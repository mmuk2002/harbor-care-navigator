import OpenAI from 'openai'
import { type Fact, type Turn, type WidgetId } from '../shared/types.js'
import type { Store } from './store.js'

interface ExtractedItem {
  title: string
  detail: string
  status: 'reported' | 'needs_review' | 'proposed' | 'agreed'
  quote: string
  corrects: string
}

const widgetInstructions: Record<WidgetId, string> = {
  circle: 'People and support. Capture patient, caller, relationships, preferences, and availability. A relationship does not prove willingness to help. Do not infer legal authority.',
  timeline: 'Reported events and upcoming plans. Preserve approximate dates and distinguish reported from verified. Do not infer cause from sequence.',
  needs: 'Practical needs, barriers, caregiver perspective, and questions for a professional. Do not diagnose or score symptoms.',
  steps: 'Suggestions and next steps. Only mark agreed when the user explicitly commits or agrees. An intention to ask someone is not proof that person accepted. Include the owner.',
}

const schema = {
  type: 'object',
  properties: {
    items: { type: 'array', items: { type: 'object', properties: {
      title: { type: 'string' }, detail: { type: 'string' },
      status: { type: 'string', enum: ['reported', 'needs_review', 'proposed', 'agreed'] },
      quote: { type: 'string' }, corrects: { type: 'string' },
    }, required: ['title', 'detail', 'status', 'quote', 'corrects'], additionalProperties: false } },
  }, required: ['items'], additionalProperties: false,
} as const

function ruleExtract(widget: WidgetId, turn: Turn): ExtractedItem[] {
  const sentences = turn.text.match(/[^.!?]+[.!?]?/g)?.map(value => value.trim()).filter(Boolean) || [turn.text]
  const rules: Record<WidgetId, { pattern: RegExp; title: string; status: ExtractedItem['status'] }> = {
    circle: { pattern: /\b(mother|father|mom|dad|sister|brother|daughter|son|wife|husband|friend|neighbor)\b/i, title: 'Person mentioned', status: 'reported' },
    timeline: { pattern: /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|yesterday|next week|appointment|last month)\b/i, title: 'Time or plan mentioned', status: 'reported' },
    needs: { pattern: /\b(need|needs|help|ride|transport|exhausted|tired|respite|worried|question|problem)\b/i, title: 'Need or concern', status: 'reported' },
    steps: { pattern: /\b(i will|i'll|we will|we'll|let's|i can ask)\b/i, title: 'Possible next step', status: 'needs_review' },
  }
  const rule = rules[widget]
  return sentences.filter(sentence => rule.pattern.test(sentence)).slice(0, 3)
    .map(sentence => ({ title: rule.title, detail: sentence, status: rule.status, quote: sentence, corrects: '' }))
}

async function modelExtract(widget: WidgetId, turn: Turn, recent: Turn[], facts: Fact[]): Promise<ExtractedItem[]> {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  const context = recent.slice(-8).map(t => `${t.speaker}: ${t.text}`).join('\n')
  const prior = facts.filter(f => f.widget === widget && f.status !== 'corrected').slice(-8)
    .map(f => `${f.title}: ${f.detail}`).join('\n')
  const response = await client.responses.create({
    model: process.env.OPENAI_WIDGET_MODEL || 'gpt-4.1-mini',
    instructions: `You extract one kind of navigator information: ${widgetInstructions[widget]}\n` +
      'Only extract information explicitly supported by the NEW USER TURN. The quote must be a verbatim substring of that turn. ' +
      'Return at most three useful, nonduplicate items. If no relevant detail exists, return an empty array. ' +
      'Use short titles and plain details. A correction can set corrects to the title of a prior item; otherwise use an empty string. ' +
      'These are reported facts, not verified medical facts. No diagnosis, medication decision, or invented commitments.',
    input: `Recent conversation:\n${context}\n\nExisting ${widget} items:\n${prior || '(none)'}\n\nNEW USER TURN:\n${turn.text}`,
    text: { format: { type: 'json_schema', name: 'widget_items', strict: true, schema } },
  })
  const parsed = JSON.parse(response.output_text || '{"items":[]}') as { items?: ExtractedItem[] }
  return (parsed.items || []).slice(0, 3)
}

export function startAnalysis(store: Store): { kick: () => void; stop: () => void } {
  const busy = new Set<string>()
  const runningJobs = new Set<string>()
  let stopped = false

  async function runJob(job: { id: string; conversation_id: string; widget: WidgetId; turn_id: string }): Promise<void> {
    const lane = `${job.conversation_id}:${job.widget}`
    busy.add(lane)
    runningJobs.add(job.id)
    const started = Date.now()
    try {
      await store.jobStatus(job.id, 'running')
      await store.setWidget(job.conversation_id, job.widget, 'working', null, null)
      const turns = await store.turns(job.conversation_id)
      const turn = turns.find(t => t.id === job.turn_id)
      if (!turn || turn.speaker !== 'user') { await store.jobStatus(job.id, 'done'); return }
      if (turn.source_id.startsWith('correction:') && !process.env.OPENAI_API_KEY) {
        await store.setWidget(job.conversation_id, job.widget, 'current', turn.id, Date.now() - started)
        await store.jobStatus(job.id, 'done')
        return
      }
      const existing = await store.facts(job.conversation_id, job.widget)
      const manuallyCorrected = existing.some(f => f.source_turn_id === turn.id && f.supersedes_id)
      const extracted = process.env.OPENAI_API_KEY
        ? await modelExtract(job.widget, turn, turns, existing)
        : ruleExtract(job.widget, turn)
      for (const item of extracted) {
        if (manuallyCorrected) continue
        if (!item.quote || !turn.text.includes(item.quote)) continue
        if (!item.title.trim() || !item.detail.trim()) continue
        if (existing.some(f => f.title === item.title && f.detail === item.detail && f.status !== 'corrected')) continue
        await store.addFact({ conversation_id: job.conversation_id, widget: job.widget,
          title: item.title.slice(0, 120), detail: item.detail.slice(0, 600), status: item.status,
          source_turn_id: turn.id, source_quote: item.quote.slice(0, 500), supersedes_id: null })
      }
      await store.setWidget(job.conversation_id, job.widget, 'current', turn.id, Date.now() - started)
      await store.jobStatus(job.id, 'done')
    } catch (error) {
      await store.setWidget(job.conversation_id, job.widget, 'failed', null, Date.now() - started).catch(() => {})
      await store.jobStatus(job.id, 'failed').catch(() => {})
      console.error('Widget analysis failed', job.widget, error)
    } finally {
      busy.delete(lane)
      runningJobs.delete(job.id)
    }
  }

  async function tick(): Promise<void> {
    if (stopped) return
    const jobs = await store.pendingJobs()
    const capacity = Math.max(0, 4 - runningJobs.size)
    const available = jobs.filter(j => !busy.has(`${j.conversation_id}:${j.widget}`) && !runningJobs.has(j.id)).slice(0, capacity)
    await Promise.all(available.map(runJob))
  }

  const timer = setInterval(() => { void tick().catch(error => console.error('Analysis queue error', error)) }, 350)
  return {
    kick: () => { void tick().catch(console.error) },
    stop: () => { stopped = true; clearInterval(timer) },
  }
}

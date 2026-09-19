import { randomUUID } from 'node:crypto'
import type { Store } from './store.js'
import type { Turn } from '../shared/types.js'

export async function createSample(store: Store, visitorId: string): Promise<string> {
  const conversation = await store.create(visitorId, {
    provider: 'openai', mode: 'patient', style: 'gentle', pace: 'unhurried', focus: 'everyday', voice: 'marin',
  })
  const utterances = [
    ['assistant', 'Hi, I’m Harbor, an AI care navigator. What would be useful to talk through today?'],
    ['user', 'I help my dad, Daniel. His sister Mara checks in on Sundays, but I handle most appointments.'],
    ['assistant', 'That sounds like a lot to carry. What is the most pressing practical issue this week?'],
    ['user', 'Dad has a memory clinic appointment next Tuesday. We need a ride, and I am exhausted.'],
    ['assistant', 'I can help organize the questions and next steps. Has anyone agreed to drive him?'],
    ['user', 'I was going to ask Nina, but she has not agreed. I will call the clinic about transport options.'],
    ['assistant', 'I’ll note that Nina has not confirmed and that you plan to call the clinic. Is the appointment still on Tuesday?'],
    ['user', 'Actually, I checked: the appointment is Thursday, not Tuesday.'],
  ] as const
  const turns: Turn[] = []
  for (const [speaker, text] of utterances) {
    turns.push((await store.addTurn(conversation.id, `sample:${randomUUID()}`, speaker, text)).turn)
  }
  const add = async (widget: 'circle' | 'timeline' | 'needs' | 'steps', title: string, detail: string, source: number, quote: string,
    status: 'reported' | 'needs_review' | 'agreed' = 'reported') => store.addFact({
    conversation_id: conversation.id, widget, title, detail, status, source_turn_id: turns[source].id,
    source_quote: quote, supersedes_id: null,
  })
  await add('circle', 'Daniel', 'Caller’s father; caller handles most appointments.', 1, 'I help my dad, Daniel.')
  await add('circle', 'Aunt Mara', 'Checks in on Sundays; availability beyond that is unknown.', 1, 'His sister Mara checks in on Sundays')
  await add('circle', 'Nina', 'Caller intends to ask her about a ride; she has not agreed.', 5, 'I was going to ask Nina, but she has not agreed.')
  const appointment = await add('timeline', 'Memory clinic appointment', 'Reported for next Tuesday.', 3, 'Dad has a memory clinic appointment next Tuesday.')
  await add('needs', 'Transportation', 'A ride to the appointment is still needed.', 3, 'We need a ride')
  await add('needs', 'Caregiver fatigue', 'Caller says they are exhausted.', 3, 'I am exhausted.')
  await add('steps', 'Call the clinic', 'Caller plans to ask the clinic about transport options.', 5,
    'I will call the clinic about transport options.', 'agreed')
  await store.replaceFact(appointment.id, { conversation_id: conversation.id, widget: 'timeline',
    title: 'Memory clinic appointment', detail: 'Corrected to Thursday; the earlier Tuesday date was mistaken.',
    status: 'reported', source_turn_id: turns[7].id, source_quote: 'the appointment is Thursday, not Tuesday.',
    supersedes_id: appointment.id })
  for (const widget of ['circle', 'timeline', 'needs', 'steps'] as const) {
    await store.setWidget(conversation.id, widget, 'current', turns[7].id, 0)
  }
  await store.setConversation(conversation.id, 'ended')
  return conversation.id
}

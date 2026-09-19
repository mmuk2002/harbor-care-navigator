import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { widgetIds, type AppEvent, type Conversation, type ConversationDetail, type Fact, type Settings, type Turn, type WidgetId, type WidgetState } from '../shared/types.js'
import type { Database } from './db.js'

export class Store {
  constructor(private db: Database, private publish: (event: AppEvent) => void) {}

  async visitor(token?: string): Promise<{ id: string; token: string; created: boolean }> {
    if (token) {
      const hash = createHash('sha256').update(token).digest('hex')
      const result = await this.db.query<{ id: string }>('SELECT id FROM visitors WHERE token_hash=$1', [hash])
      if (result.rows[0]) return { id: result.rows[0].id, token, created: false }
    }
    const next = randomBytes(32).toString('hex')
    const id = randomUUID()
    const hash = createHash('sha256').update(next).digest('hex')
    await this.db.query('INSERT INTO visitors(id, token_hash) VALUES($1,$2)', [id, hash])
    return { id, token: next, created: true }
  }

  async list(visitorId: string): Promise<Conversation[]> {
    const r = await this.db.query<Conversation>('SELECT * FROM conversations WHERE visitor_id=$1 ORDER BY started_at DESC LIMIT 50', [visitorId])
    return r.rows
  }

  async create(visitorId: string, settings: Settings): Promise<Conversation> {
    const id = randomUUID()
    const r = await this.db.query<Conversation>(
      'INSERT INTO conversations(id,visitor_id,status,settings) VALUES($1,$2,$3,$4) RETURNING *',
      [id, visitorId, 'ready', JSON.stringify(settings)],
    )
    for (const widget of widgetIds) {
      await this.db.query('INSERT INTO widget_states(conversation_id,widget,status) VALUES($1,$2,$3)', [id, widget, 'waiting'])
    }
    await this.event(id, 'conversation', r.rows[0])
    return r.rows[0]
  }

  async conversation(id: string, visitorId: string): Promise<Conversation | null> {
    const r = await this.db.query<Conversation>('SELECT * FROM conversations WHERE id=$1 AND visitor_id=$2', [id, visitorId])
    return r.rows[0] || null
  }

  async detail(id: string, visitorId: string): Promise<ConversationDetail | null> {
    const conversation = await this.conversation(id, visitorId)
    if (!conversation) return null
    const [turns, facts, widgets, events] = await Promise.all([
      this.db.query<Turn>('SELECT * FROM turns WHERE conversation_id=$1 ORDER BY seq', [id]),
      this.db.query<Fact>('SELECT * FROM facts WHERE conversation_id=$1 ORDER BY created_at,id', [id]),
      this.db.query<WidgetState>('SELECT * FROM widget_states WHERE conversation_id=$1 ORDER BY widget', [id]),
      this.db.query<AppEvent>('SELECT * FROM events WHERE conversation_id=$1 ORDER BY seq', [id]),
    ])
    return { conversation, turns: turns.rows, facts: facts.rows, widgets: widgets.rows, events: events.rows }
  }

  async setConversation(id: string, status: Conversation['status'], callId?: string): Promise<Conversation> {
    const r = await this.db.query<Conversation>(
      `UPDATE conversations SET status=$2, provider_call_id=COALESCE($3,provider_call_id),
       ended_at=CASE WHEN $2 IN ('ended','incomplete') THEN now() ELSE ended_at END WHERE id=$1 RETURNING *`,
      [id, status, callId || null],
    )
    if (!r.rows[0]) throw new Error('Conversation not found')
    await this.event(id, 'conversation', r.rows[0])
    return r.rows[0]
  }

  async addTurn(conversationId: string, sourceId: string, speaker: Turn['speaker'], text: string): Promise<{ turn: Turn; changed: boolean }> {
    const normalized = text.trim().slice(0, 10000)
    if (!normalized) throw new Error('Empty transcript')
    const existing = await this.db.query<Turn>('SELECT * FROM turns WHERE conversation_id=$1 AND source_id=$2', [conversationId, sourceId])
    if (existing.rows[0]?.text === normalized) return { turn: existing.rows[0], changed: false }
    const r = await this.db.query<Turn>(
      `INSERT INTO turns(id,conversation_id,source_id,speaker,text) VALUES($1,$2,$3,$4,$5)
       ON CONFLICT(conversation_id,source_id) DO UPDATE SET text=EXCLUDED.text RETURNING *`,
      [randomUUID(), conversationId, sourceId, speaker, normalized],
    )
    const turn = r.rows[0]
    await this.event(conversationId, 'turn', turn)
    return { turn, changed: true }
  }

  async addUserTurn(conversationId: string, sourceId: string, text: string): Promise<{ turn: Turn; changed: boolean }> {
    const normalized = text.trim().slice(0, 10000)
    if (!normalized) throw new Error('Empty transcript')
    const result = await this.db.transaction(async query => {
      const existing = await query<Turn>('SELECT * FROM turns WHERE conversation_id=$1 AND source_id=$2', [conversationId, sourceId])
      if (existing.rows[0]?.text === normalized) return { turn: existing.rows[0], changed: false, event: null }
      const saved = await query<Turn>(
        `INSERT INTO turns(id,conversation_id,source_id,speaker,text) VALUES($1,$2,$3,'user',$4)
         ON CONFLICT(conversation_id,source_id) DO UPDATE SET text=EXCLUDED.text RETURNING *`,
        [randomUUID(), conversationId, sourceId, normalized],
      )
      const turn = saved.rows[0]
      for (const widget of widgetIds) {
        await query(
          `INSERT INTO analysis_jobs(id,conversation_id,widget,turn_id,status) VALUES($1,$2,$3,$4,'pending')
           ON CONFLICT(conversation_id,widget,turn_id) DO UPDATE SET status='pending',updated_at=now()`,
          [randomUUID(), conversationId, widget, turn.id],
        )
      }
      const event = (await query<AppEvent>('INSERT INTO events(conversation_id,type,data) VALUES($1,$2,$3) RETURNING *',
        [conversationId, 'turn', JSON.stringify(turn)])).rows[0]
      return { turn, changed: true, event }
    })
    if (result.event) this.publish(result.event)
    return { turn: result.turn, changed: result.changed }
  }

  async turns(conversationId: string): Promise<Turn[]> {
    return (await this.db.query<Turn>('SELECT * FROM turns WHERE conversation_id=$1 ORDER BY seq', [conversationId])).rows
  }

  async facts(conversationId: string, widget?: WidgetId): Promise<Fact[]> {
    const sql = widget
      ? 'SELECT * FROM facts WHERE conversation_id=$1 AND widget=$2 ORDER BY created_at,id'
      : 'SELECT * FROM facts WHERE conversation_id=$1 ORDER BY created_at,id'
    return (await this.db.query<Fact>(sql, widget ? [conversationId, widget] : [conversationId])).rows
  }

  async addFact(input: Omit<Fact, 'id' | 'created_at'>): Promise<Fact> {
    const id = randomUUID()
    const r = await this.db.query<Fact>(
      `INSERT INTO facts(id,conversation_id,widget,title,detail,status,source_turn_id,source_quote,supersedes_id)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [id, input.conversation_id, input.widget, input.title, input.detail, input.status,
        input.source_turn_id, input.source_quote, input.supersedes_id],
    )
    await this.event(input.conversation_id, 'fact', r.rows[0])
    return r.rows[0]
  }

  async correctFact(id: string, visitorId: string, detail: string): Promise<Fact | null> {
    const clean = detail.trim().slice(0, 500)
    if (!clean) throw new Error('Correction cannot be empty')
    const result = await this.db.transaction(async query => {
      const old = (await query<Fact>(
        `SELECT f.* FROM facts f JOIN conversations c ON c.id=f.conversation_id
         WHERE f.id=$1 AND c.visitor_id=$2`, [id, visitorId])).rows[0]
      if (!old) return null
      const sourceText = `Correction to ${old.title}: ${clean}`
      const turn = (await query<Turn>(
        `INSERT INTO turns(id,conversation_id,source_id,speaker,text) VALUES($1,$2,$3,'user',$4) RETURNING *`,
        [randomUUID(), old.conversation_id, `correction:${randomUUID()}`, sourceText])).rows[0]
      await query('UPDATE facts SET status=$2 WHERE id=$1', [id, 'corrected'])
      const replacement = (await query<Fact>(
        `INSERT INTO facts(id,conversation_id,widget,title,detail,status,source_turn_id,source_quote,supersedes_id)
         VALUES($1,$2,$3,$4,$5,'reported',$6,$7,$8) RETURNING *`,
        [randomUUID(), old.conversation_id, old.widget, old.title, clean, turn.id, clean, id])).rows[0]
      for (const widget of widgetIds) await query(
        `INSERT INTO analysis_jobs(id,conversation_id,widget,turn_id,status) VALUES($1,$2,$3,$4,'pending')`,
        [randomUUID(), old.conversation_id, widget, turn.id])
      const events: AppEvent[] = []
      for (const [type, data] of [['turn', turn], ['fact', { ...old, status: 'corrected' }], ['fact', replacement]] as const) {
        events.push((await query<AppEvent>('INSERT INTO events(conversation_id,type,data) VALUES($1,$2,$3) RETURNING *',
          [old.conversation_id, type, JSON.stringify(data)])).rows[0])
      }
      return { replacement, events }
    })
    if (!result) return null
    result.events.forEach(event => this.publish(event))
    return result.replacement
  }

  async setWidget(conversationId: string, widget: WidgetId, status: WidgetState['status'], turnId: string | null, duration: number | null): Promise<void> {
    const r = await this.db.query<WidgetState>(
      `UPDATE widget_states SET status=$3,processed_turn_id=COALESCE($4,processed_turn_id),
       duration_ms=COALESCE($5,duration_ms),updated_at=now() WHERE conversation_id=$1 AND widget=$2 RETURNING *`,
      [conversationId, widget, status, turnId, duration],
    )
    await this.event(conversationId, 'widget', r.rows[0])
  }

  async job(conversationId: string, widget: WidgetId, turnId: string): Promise<void> {
    await this.db.query(
      `INSERT INTO analysis_jobs(id,conversation_id,widget,turn_id,status) VALUES($1,$2,$3,$4,'pending')
       ON CONFLICT(conversation_id,widget,turn_id) DO NOTHING`,
      [randomUUID(), conversationId, widget, turnId],
    )
  }

  async pendingJobs(): Promise<{ id: string; conversation_id: string; widget: WidgetId; turn_id: string }[]> {
    return (await this.db.query<{ id: string; conversation_id: string; widget: WidgetId; turn_id: string }>(
      `SELECT id,conversation_id,widget,turn_id FROM analysis_jobs WHERE status='pending'
       ORDER BY created_at LIMIT 16`,
    )).rows
  }

  async jobStatus(id: string, status: 'running' | 'done' | 'failed'): Promise<void> {
    await this.db.query(`UPDATE analysis_jobs SET status=$2,attempts=attempts+1,updated_at=now() WHERE id=$1`, [id, status])
  }

  async event(conversationId: string, type: AppEvent['type'], data: unknown): Promise<AppEvent> {
    const r = await this.db.query<AppEvent>(
      'INSERT INTO events(conversation_id,type,data) VALUES($1,$2,$3) RETURNING *',
      [conversationId, type, JSON.stringify(data)],
    )
    this.publish(r.rows[0])
    return r.rows[0]
  }
}

import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import pg from 'pg'

type QueryResult<T> = { rows: T[] }
export interface Database {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>
  transaction<T>(work: (query: Database['query']) => Promise<T>): Promise<T>
  close(): Promise<void>
}

const schema = `
CREATE TABLE IF NOT EXISTS visitors (
  id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY, visitor_id TEXT NOT NULL REFERENCES visitors(id), status TEXT NOT NULL,
  settings JSONB NOT NULL, started_at TIMESTAMPTZ NOT NULL DEFAULT now(), ended_at TIMESTAMPTZ,
  provider_call_id TEXT UNIQUE
);
CREATE INDEX IF NOT EXISTS conversations_visitor_idx ON conversations(visitor_id, started_at DESC);
CREATE TABLE IF NOT EXISTS turns (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL, speaker TEXT NOT NULL, text TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), seq BIGSERIAL, interrupted BOOLEAN NOT NULL DEFAULT false,
  UNIQUE(conversation_id, source_id)
);
CREATE TABLE IF NOT EXISTS facts (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  widget TEXT NOT NULL, title TEXT NOT NULL, detail TEXT NOT NULL, status TEXT NOT NULL,
  source_turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  source_quote TEXT NOT NULL, supersedes_id TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS facts_conversation_widget_idx ON facts(conversation_id, widget);
CREATE TABLE IF NOT EXISTS widget_states (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, widget TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'waiting', processed_turn_id TEXT, duration_ms INTEGER, updated_at TIMESTAMPTZ,
  PRIMARY KEY(conversation_id, widget)
);
CREATE TABLE IF NOT EXISTS events (
  seq BIGSERIAL PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  type TEXT NOT NULL, data JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS events_conversation_seq_idx ON events(conversation_id, seq);
CREATE TABLE IF NOT EXISTS analysis_jobs (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  widget TEXT NOT NULL, turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(conversation_id, widget, turn_id)
);
`

export async function openDatabase(): Promise<Database> {
  if (process.env.DATABASE_URL) {
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 8,
      ssl: process.env.PGSSL === 'require' ? { rejectUnauthorized: false } : false })
    await pool.query(schema)
    const query: Database['query'] = async <T>(sql: string, params: unknown[] = []) => {
      const result = await pool.query(sql, params)
      return { rows: result.rows as T[] }
    }
    return { query, transaction: async work => {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const result = await work(async <T>(sql: string, params: unknown[] = []) => {
          const response = await client.query(sql, params)
          return { rows: response.rows as T[] }
        })
        await client.query('COMMIT')
        return result
      } catch (error) { await client.query('ROLLBACK'); throw error }
      finally { client.release() }
    }, close: async () => { await pool.end() } }
  }
  const dataDir = resolve(process.env.DATA_DIR || './data')
  await mkdir(dataDir, { recursive: true })
  const db = new PGlite(dataDir)
  await db.exec(schema)
  const query: Database['query'] = async <T>(sql: string, params: unknown[] = []) => {
    const result = await db.query(sql, params)
    return { rows: result.rows as T[] }
  }
  return { query, transaction: work => db.transaction(tx => work(async <T>(sql: string, params: unknown[] = []) => {
    const result = await tx.query(sql, params)
    return { rows: result.rows as T[] }
  })), close: async () => { await db.close() } }
}

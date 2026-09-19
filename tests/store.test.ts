import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../server/db.js'
import { Store } from '../server/store.js'
import { widgetIds, type AppEvent, type Settings } from '../shared/types.js'

const dataDir = await mkdtemp(join(tmpdir(), 'harbor-store-'))
process.env.DATA_DIR = dataDir
delete process.env.DATABASE_URL
const db = await openDatabase()
const published: AppEvent[] = []
const store = new Store(db, event => published.push(event))
const settings: Settings = { provider: 'openai', mode: 'family', style: 'gentle', pace: 'unhurried', focus: 'everyday', voice: 'marin' }
after(async () => { await db.close(); await rm(dataDir, { recursive: true, force: true }) })

test('visitor isolation, atomic turn jobs, correction, and deletion', async () => {
  const owner = await store.visitor()
  const stranger = await store.visitor()
  const conversation = await store.create(owner.id, settings)
  assert.equal(await store.detail(conversation.id, stranger.id), null)
  const first = await store.addUserTurn(conversation.id, 'provider-item-1', 'My sister Nina can help on Tuesday.')
  assert.equal(first.changed, true)
  const duplicate = await store.addUserTurn(conversation.id, 'provider-item-1', first.turn.text)
  assert.equal(duplicate.changed, false)
  assert.equal((await store.turns(conversation.id)).length, 1)
  assert.deepEqual(new Set((await store.pendingJobs()).map(job => job.widget)), new Set(widgetIds))
  const fact = await store.addFact({ conversation_id: conversation.id, widget: 'circle', title: 'Sister Nina',
    detail: 'Nina can help on Tuesday', status: 'reported', source_turn_id: first.turn.id,
    source_quote: 'My sister Nina can help on Tuesday.', supersedes_id: null })
  assert.equal(await store.correctFact(fact.id, stranger.id, 'Nina is unavailable'), null)
  const corrected = await store.correctFact(fact.id, owner.id, 'Nina is unavailable on Tuesday')
  assert.equal(corrected?.supersedes_id, fact.id)
  assert.equal((await store.facts(conversation.id)).find(item => item.id === fact.id)?.status, 'corrected')
  const profile = await store.profile(owner.id)
  assert.equal(profile.conversation_count, 1)
  assert.equal(profile.facts.some(item => item.detail === 'Nina is unavailable on Tuesday'), true)
  assert.equal((await store.pendingJobs()).length, 8)
  assert.equal(published.filter(event => event.type === 'turn').length, 2)
  const auto = await store.replaceFact(corrected!.id, { conversation_id: conversation.id, widget: 'circle',
    title: 'Sister Nina', detail: 'Nina may help on Friday', status: 'reported', source_turn_id: first.turn.id,
    source_quote: first.turn.text, supersedes_id: corrected!.id })
  assert.equal(auto.supersedes_id, corrected!.id)
  assert.equal((await store.facts(conversation.id)).find(item => item.id === corrected!.id)?.status, 'corrected')
  const pending = await store.pendingJobs()
  await store.jobStatus(pending[0].id, 'running')
  await store.recoverJobs()
  assert.equal((await store.pendingJobs()).length, 8)
  await db.query('DELETE FROM conversations WHERE id=$1', [conversation.id])
  assert.equal((await db.query('SELECT * FROM analysis_jobs WHERE conversation_id=$1', [conversation.id])).rows.length, 0)
  assert.equal((await db.query('SELECT * FROM facts WHERE conversation_id=$1', [conversation.id])).rows.length, 0)
})

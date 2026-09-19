import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import middie from '@fastify/middie'
import { WebSocket, WebSocketServer } from 'ws'
import { z } from 'zod'
import { widgetIds, type AppEvent, type Settings } from '../shared/types.js'
import { openDatabase } from './db.js'
import { Store } from './store.js'
import { startAnalysis } from './analysis.js'
import { VoiceSession } from './voice.js'

if (existsSync('.env')) process.loadEnvFile('.env')

const db = await openDatabase()
const app = Fastify({ logger: false, bodyLimit: 1_000_000 })
const subscribers = new Map<string, Set<WebSocket>>()
const store = new Store(db, (event: AppEvent) => {
  const peers = subscribers.get(event.conversation_id)
  if (!peers) return
  for (const peer of peers) if (peer.readyState === WebSocket.OPEN) peer.send(JSON.stringify(event))
})
const analysis = startAnalysis(store)
const activeVoices = new Map<string, VoiceSession>()
const settingsSchema = z.object({
  mode: z.enum(['patient', 'family']), style: z.enum(['gentle', 'direct']),
  pace: z.enum(['unhurried', 'balanced']), focus: z.enum(['everyday', 'appointments', 'caregiver']),
  voice: z.enum(['marin', 'cedar', 'alloy']),
})
const idSchema = z.object({ id: z.uuid() })

function cookieValue(header: string | undefined): string | undefined {
  return header?.split(';').map(part => part.trim()).find(part => part.startsWith('harbor_visitor='))?.slice('harbor_visitor='.length)
}

async function identity(request: { headers: { cookie?: string } }, reply?: { header: (name: string, value: string) => unknown }) {
  const visitor = await store.visitor(cookieValue(request.headers.cookie))
  if (visitor.created && reply) {
    reply.header('Set-Cookie', `harbor_visitor=${visitor.token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=2592000${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`)
  }
  return visitor.id
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : 'Request failed' }

app.setErrorHandler((error, _request, reply) => {
  console.error(error)
  const known = error as { statusCode?: number; message?: string }
  reply.code(known.statusCode || 500).send({ error: known.statusCode ? known.message : 'Something went wrong. Please try again.' })
})

app.get('/api/health', async () => ({ ok: true, voiceConfigured: Boolean(process.env.OPENAI_API_KEY), storage: process.env.DATABASE_URL ? 'postgres' : 'local' }))

app.get('/api/bootstrap', async (request, reply) => {
  const visitorId = await identity(request, reply)
  return { visitorId, voiceConfigured: Boolean(process.env.OPENAI_API_KEY), conversations: await store.list(visitorId) }
})

app.post('/api/conversations', async (request, reply) => {
  const visitorId = await identity(request, reply)
  const settings = settingsSchema.parse(request.body) as Settings
  const conversation = await store.create(visitorId, settings)
  return reply.code(201).send(conversation)
})

app.get('/api/conversations/:id', async (request, reply) => {
  const visitorId = await identity(request, reply)
  const { id } = idSchema.parse(request.params)
  const detail = await store.detail(id, visitorId)
  return detail || reply.code(404).send({ error: 'Conversation not found' })
})

app.post('/api/conversations/:id/connect', async (request, reply) => {
  const visitorId = await identity(request, reply)
  const { id } = idSchema.parse(request.params)
  const conversation = await store.conversation(id, visitorId)
  if (!conversation) return reply.code(404).send({ error: 'Conversation not found' })
  if (conversation.status !== 'ready') return reply.code(409).send({ error: 'This conversation has already started' })
  const { sdp } = z.object({ sdp: z.string().min(20).max(100000) }).parse(request.body)
  await store.setConversation(id, 'connecting')
  const prior = (await store.list(visitorId)).filter(c => c.id !== id).slice(0, 4)
  const memory = (await Promise.all(prior.map(c => store.facts(c.id))))
    .flat().filter(f => f.status !== 'corrected' && f.status !== 'proposed')
    .slice(-12).map(f => `${f.title}: ${f.detail}`).join('\n')
  const voice = new VoiceSession(store, () => analysis.kick())
  try {
    const answer = await voice.connect(id, sdp, conversation.settings, memory)
    activeVoices.set(id, voice)
    return { sdp: answer }
  } catch (error) {
    voice.close()
    await store.setConversation(id, 'incomplete')
    return reply.code(502).send({ error: errorMessage(error) })
  }
})

app.post('/api/conversations/:id/turns', async (request, reply) => {
  const visitorId = await identity(request, reply)
  const { id } = idSchema.parse(request.params)
  const conversation = await store.conversation(id, visitorId)
  if (!conversation) return reply.code(404).send({ error: 'Conversation not found' })
  if (conversation.status === 'ended') return reply.code(409).send({ error: 'Conversation has ended' })
  const { text } = z.object({ text: z.string().trim().min(1).max(4000) }).parse(request.body)
  const { turn } = await store.addUserTurn(id, `text:${randomUUID()}`, text)
  analysis.kick()
  return reply.code(201).send(turn)
})

app.post('/api/conversations/:id/end', async (request, reply) => {
  const visitorId = await identity(request, reply)
  const { id } = idSchema.parse(request.params)
  const conversation = await store.conversation(id, visitorId)
  if (!conversation) return reply.code(404).send({ error: 'Conversation not found' })
  activeVoices.get(id)?.close()
  activeVoices.delete(id)
  return store.setConversation(id, 'ended')
})

app.patch('/api/facts/:id', async (request, reply) => {
  const visitorId = await identity(request, reply)
  const { id } = idSchema.parse(request.params)
  const { detail } = z.object({ detail: z.string().trim().min(1).max(500) }).parse(request.body)
  const fact = await store.correctFact(id, visitorId, detail)
  if (fact) analysis.kick()
  return fact || reply.code(404).send({ error: 'Item not found' })
})

app.delete('/api/conversations/:id', async (request, reply) => {
  const visitorId = await identity(request, reply)
  const { id } = idSchema.parse(request.params)
  const conversation = await store.conversation(id, visitorId)
  if (!conversation) return reply.code(404).send({ error: 'Conversation not found' })
  activeVoices.get(id)?.close()
  activeVoices.delete(id)
  await db.query('DELETE FROM conversations WHERE id=$1 AND visitor_id=$2', [id, visitorId])
  return reply.code(204).send()
})

const socketServer = new WebSocketServer({ noServer: true })
app.server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url || '/', 'http://localhost')
  if (url.pathname !== '/events') { socket.destroy(); return }
  void (async () => {
    const visitorId = await identity(request)
    const conversationId = url.searchParams.get('conversation') || ''
    if (!await store.conversation(conversationId, visitorId)) { socket.destroy(); return }
    socketServer.handleUpgrade(request, socket, head, peer => {
      let peers = subscribers.get(conversationId)
      if (!peers) { peers = new Set(); subscribers.set(conversationId, peers) }
      peers.add(peer)
      peer.on('close', () => { peers?.delete(peer); if (!peers?.size) subscribers.delete(conversationId) })
      peer.send(JSON.stringify({ type: 'connected', widgets: widgetIds }))
    })
  })().catch(() => socket.destroy())
})

if (process.env.NODE_ENV === 'production') {
  await app.register(fastifyStatic, { root: resolve('dist'), prefix: '/' })
  app.setNotFoundHandler((_request, reply) => reply.sendFile('index.html'))
} else {
  const { createServer } = await import('vite')
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'spa' })
  await app.register(middie)
  app.use((request, response, next) => {
    if (request.url?.startsWith('/api/')) return next()
    vite.middlewares(request, response, next)
  })
}

const port = Number(process.env.PORT || 3000)
await app.listen({ host: '0.0.0.0', port })
console.log(`Harbor running at http://localhost:${port}`)

process.on('SIGINT', () => { analysis.stop(); void app.close().then(() => db.close()).then(() => process.exit(0)) })

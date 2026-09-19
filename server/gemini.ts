import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import type { Settings } from '../shared/types.js'
import type { Store } from './store.js'
import { instructions } from './voice.js'

type ServerContent = {
  inputTranscription?: { text?: string }
  outputTranscription?: { text?: string }
  modelTurn?: { parts?: { inlineData?: { data?: string; mimeType?: string } }[] }
  interrupted?: boolean
  turnComplete?: boolean
}

function appendTranscript(current: string, piece: string): string {
  const next = piece.trim()
  if (!next) return current
  if (!current) return next
  if (next.startsWith(current)) return next
  if (current.endsWith(next)) return current
  return current + (/^[.,!?;:]/.test(next) || /\s$/.test(current) ? '' : ' ') + next
}

export class GeminiSession {
  private upstream: WebSocket | null = null
  private client: WebSocket | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private intentional = false
  private processing = Promise.resolve()
  private userBuffer = ''
  private assistantBuffer = ''
  private turnIndex = 0
  private conversationId: string | null = null

  constructor(private store: Store, private onTurn: () => void,
    private onExpire: () => Promise<void>, private onDisconnect: () => Promise<void>) {}

  async connect(client: WebSocket, conversationId: string, settings: Settings, memory: string): Promise<void> {
    const key = process.env.GEMINI_API_KEY
    if (!key) throw new Error('Gemini Live is not configured')
    this.client = client
    this.conversationId = conversationId
    const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(key)}`
    const upstream = new WebSocket(url, { maxPayload: 2_000_000 })
    this.upstream = upstream
    const ready = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Gemini Live setup timed out')), 12000)
      upstream.once('open', () => {
        upstream.send(JSON.stringify({ setup: {
          model: `models/${process.env.GEMINI_LIVE_MODEL || 'gemini-3.8-live'}`,
          generationConfig: { responseModalities: ['AUDIO'],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: settings.voice } } } },
          systemInstruction: { parts: [{ text: instructions(settings, memory) }] },
          inputAudioTranscription: {}, outputAudioTranscription: {},
          realtimeInputConfig: { automaticActivityDetection: { disabled: false,
            endOfSpeechSensitivity: 'END_SENSITIVITY_LOW', silenceDurationMs: settings.pace === 'unhurried' ? 900 : 700 } },
        } }))
      })
      upstream.on('message', data => {
        let event: { setupComplete?: unknown; serverContent?: ServerContent; goAway?: unknown }
        try { event = JSON.parse(data.toString()) } catch { return }
        if (event.setupComplete) { clearTimeout(timeout); resolve(); return }
        if (event.serverContent) {
          this.processing = this.processing.then(() => this.handleContent(conversationId, event.serverContent!))
            .catch(error => console.error('Gemini event processing failed', error))
        }
        if (event.goAway) this.send({ type: 'notice', message: 'Gemini will close this connection soon.' })
      })
      upstream.once('error', error => { clearTimeout(timeout); reject(error) })
      upstream.once('close', (code, reason) => {
        clearTimeout(timeout)
        reject(new Error(`Gemini Live closed during setup (${code}): ${reason.toString().slice(0, 120)}`))
      })
    })
    try { await ready } catch (error) { await this.close(); throw error }
    await this.store.setConversation(conversationId, 'live', `gemini:${randomUUID()}`)
    this.send({ type: 'ready' })
    client.on('message', (data, isBinary) => {
      if (upstream.readyState !== WebSocket.OPEN) return
      if (isBinary) {
        const bytes = Buffer.from(data as Buffer)
        if (bytes.length > 64000) return
        upstream.send(JSON.stringify({ realtimeInput: { audio: { data: bytes.toString('base64'), mimeType: 'audio/pcm;rate=16000' } } }))
      } else {
        try {
          const message = JSON.parse(data.toString()) as { type?: string }
          if (message.type === 'audioStreamEnd') upstream.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }))
        } catch { /* ignore malformed client control messages */ }
      }
    })
    client.on('close', () => {
      if (!this.intentional) void this.close().then(this.onDisconnect).catch(console.error)
    })
    upstream.on('close', () => {
      if (!this.intentional) void this.close().then(this.onDisconnect).catch(console.error)
    })
    this.timer = setTimeout(() => {
      void this.close().then(this.onExpire).catch(console.error)
    }, 10 * 60 * 1000)
  }

  private send(message: unknown): void {
    if (this.client?.readyState === WebSocket.OPEN) this.client.send(JSON.stringify(message))
  }

  private async flushUser(conversationId: string): Promise<void> {
    const text = this.userBuffer.trim()
    if (!text) return
    this.userBuffer = ''
    const result = await this.store.addUserTurn(conversationId, `gemini:user:${this.turnIndex}`, text)
    if (result.changed) this.onTurn()
  }

  private async flushAssistant(conversationId: string, interrupted: boolean): Promise<void> {
    const text = this.assistantBuffer.trim()
    if (!text) return
    this.assistantBuffer = ''
    await this.store.addTurn(conversationId, `gemini:assistant:${this.turnIndex}`, 'assistant', text, interrupted)
  }

  private async handleContent(conversationId: string, content: ServerContent): Promise<void> {
    if (process.env.DEBUG_GEMINI === '1') console.log('Gemini content', JSON.stringify(content).slice(0, 600))
    if (content.inputTranscription?.text) {
      this.userBuffer = appendTranscript(this.userBuffer, content.inputTranscription.text)
      this.send({ type: 'listening' })
    }
    if (content.outputTranscription?.text) {
      await this.flushUser(conversationId)
      this.assistantBuffer = appendTranscript(this.assistantBuffer, content.outputTranscription.text)
      this.send({ type: 'speaking' })
    }
    for (const part of content.modelTurn?.parts || []) {
      if (part.inlineData?.data) {
        await this.flushUser(conversationId)
        this.send({ type: 'audio', data: part.inlineData.data, mimeType: part.inlineData.mimeType || 'audio/pcm;rate=24000' })
      }
    }
    if (content.interrupted) {
      this.send({ type: 'interrupted' })
      await this.flushAssistant(conversationId, true)
      this.turnIndex += 1
    }
    if (content.turnComplete) {
      await this.flushUser(conversationId)
      await this.flushAssistant(conversationId, false)
      this.turnIndex += 1
      this.send({ type: 'listening' })
    }
  }

  async close(): Promise<void> {
    this.intentional = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    await this.processing.catch(() => {})
    if (this.conversationId) {
      await this.flushUser(this.conversationId).catch(() => {})
      await this.flushAssistant(this.conversationId, true).catch(() => {})
    }
    this.upstream?.close()
    this.client?.close()
    this.upstream = null
    this.client = null
  }
}

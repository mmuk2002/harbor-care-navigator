import WebSocket from 'ws'
import OpenAI from 'openai'
import type { Settings } from '../shared/types.js'
import type { Store } from './store.js'

const realtimeModel = process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime-2.1'

export function instructions(settings: Settings, memory: string): string {
  return `You are Harbor, a clearly disclosed AI care navigation assistant. You are not a clinician.
You are speaking with ${settings.mode === 'patient' ? 'a patient' : 'a family member or caregiver'}.
Ask one useful question at a time. Be patient, respectful, never infantilizing, and leave room for long pauses.
Speak in ${settings.style === 'gentle' ? 'warm, reassuring' : 'clear, concise'} language, with ${settings.pace === 'unhurried' ? 'short sentences and generous pause tolerance' : 'a natural pace'}.
Focus on ${settings.focus === 'appointments' ? 'appointment preparation and logistics' : settings.focus === 'caregiver' ? 'caregiver support and practical relief' : 'everyday needs and practical next steps'}.
Do not diagnose, recommend medication or dosage changes, invent available services, or claim an action was completed. For clinical questions, suggest discussing them with a qualified professional. For immediate danger, tell the caller to seek local emergency help promptly.
Do not claim a ride, callback, booking, or contact has been arranged by this app. A plan to ask someone is different from their agreement to help.
Relevant prior reported information, which may need confirmation:\n${memory || '(no prior details)'}
Use prior information sparingly and ask whether open plans changed. If the caller corrects something, acknowledge it and use the correction. End with a concise recap of the caller's own next step and unresolved questions.`
}

export class VoiceSession {
  private socket: WebSocket | null = null
  private callId: string | null = null
  private expiry: ReturnType<typeof setTimeout> | null = null
  constructor(private store: Store, private onTurn: () => void,
    private onExpire: () => Promise<void>, private onDisconnect: () => Promise<void>) {}

  async connect(conversationId: string, sdp: string, settings: Settings, memory: string): Promise<string> {
    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) throw new Error('Voice service is not configured yet')
    const fd = new FormData()
    fd.set('sdp', new Blob([sdp], { type: 'application/sdp' }), 'offer.sdp')
    fd.set('session', new Blob([JSON.stringify({
      type: 'realtime', model: realtimeModel,
      instructions: instructions(settings, memory),
      audio: {
        input: { transcription: { model: 'gpt-4o-mini-transcribe' },
          turn_detection: { type: 'semantic_vad', eagerness: settings.pace === 'unhurried' ? 'low' : 'medium', create_response: true, interrupt_response: true } },
        output: { voice: settings.voice },
      },
    })], { type: 'application/json' }), 'session.json')
    const response = await fetch('https://api.openai.com/v1/realtime/calls', {
      method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: fd,
    })
    if (!response.ok) throw new Error(`Voice provider rejected the session (${response.status}): ${(await response.text()).slice(0, 280)}`)
    const answer = await response.text()
    const callId = response.headers.get('Location')?.split('/').pop()
    if (!callId) throw new Error('Voice provider returned no call ID for observation')
    this.callId = callId
    await this.attach(callId, conversationId, apiKey)
    await this.store.setConversation(conversationId, 'live', callId)
    this.expiry = setTimeout(() => {
      void this.close().then(this.onExpire).catch(error => console.error('Voice session expiry failed', error))
    }, 10 * 60 * 1000)
    return answer
  }

  private async attach(callId: string, conversationId: string, key: string): Promise<void> {
    const socket = new WebSocket(`wss://api.openai.com/v1/realtime?call_id=${encodeURIComponent(callId)}`, {
      headers: { Authorization: `Bearer ${key}` },
    })
    this.socket = socket
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { socket.terminate(); reject(new Error('Voice observation timed out')) }, 7000)
      socket.once('open', () => { clearTimeout(timer); resolve() })
      socket.once('error', error => { clearTimeout(timer); reject(error) })
    })
    socket.on('message', data => {
      void this.onProviderEvent(conversationId, JSON.parse(data.toString()) as Record<string, unknown>).catch(error => {
        console.error('Voice event processing failed', error)
        void this.store.event(conversationId, 'error', { message: 'A transcript event could not be saved.' })
      })
    })
    socket.on('close', () => {
      if (this.socket === socket) {
        void this.store.event(conversationId, 'error', { message: 'Live transcript observation disconnected.' })
        void this.close().then(this.onDisconnect).catch(error => console.error('Voice disconnect cleanup failed', error))
      }
    })
  }

  private async onProviderEvent(conversationId: string, event: Record<string, unknown>): Promise<void> {
    const type = String(event.type || '')
    const itemId = String(event.item_id || (event.item as { id?: string } | undefined)?.id || event.response_id || '')
    if (type === 'error') {
      await this.store.event(conversationId, 'error', { message: 'Voice service reported an error.' })
      return
    }
    const userDone = type === 'conversation.item.input_audio_transcription.completed' ||
      type === 'conversation.item.input_audio_transcript.done' || type === 'session.input_transcript.done'
    const assistantDone = type === 'response.audio_transcript.done' ||
      type === 'response.output_audio_transcript.done' || type === 'session.output_transcript.done'
    if (userDone || assistantDone) {
      const text = String(event.transcript || event.text || '').trim()
      if (!text) return
      const sourceId = itemId || `${type}:${String(event.event_id || '')}`
      if (userDone) {
        const { changed } = await this.store.addUserTurn(conversationId, sourceId, text)
        if (changed) this.onTurn()
      } else await this.store.addTurn(conversationId, sourceId, 'assistant', text)
    }
  }

  async close(): Promise<void> {
    if (this.expiry) clearTimeout(this.expiry)
    this.expiry = null
    const socket = this.socket
    this.socket = null
    socket?.close()
    const callId = this.callId
    this.callId = null
    if (callId && process.env.OPENAI_API_KEY) {
      try { await new OpenAI({ apiKey: process.env.OPENAI_API_KEY }).realtime.calls.hangup(callId) }
      catch (error) { console.error('Voice hangup failed', error) }
    }
  }
}

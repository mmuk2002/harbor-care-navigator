import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity, ArrowLeft, ArrowRight, AudioLines, CalendarDays, CheckCircle2,
  ChevronRight, Clock3, HeartHandshake, History, Info, LayoutGrid, Mic, MicOff,
  Play, Send, Settings2, ShieldCheck, Sparkles, Square, Users, Volume2, X,
} from 'lucide-react'
import type { Conversation, ConversationDetail, Fact, Settings, Turn, WidgetId } from '../shared/types'

const defaultSettings: Settings = { mode: 'family', style: 'gentle', pace: 'unhurried', focus: 'everyday', voice: 'marin' }
const widgetMeta: Record<WidgetId, { title: string; subtitle: string; icon: typeof Users; color: string }> = {
  circle: { title: 'Care circle', subtitle: 'People who matter', icon: Users, color: 'blue' },
  timeline: { title: 'Care timeline', subtitle: 'Events and plans', icon: CalendarDays, color: 'amber' },
  needs: { title: 'Needs & questions', subtitle: 'What matters now', icon: HeartHandshake, color: 'rose' },
  steps: { title: 'Next steps', subtitle: 'Who will do what', icon: CheckCircle2, color: 'green' },
}
const widgetOrder: WidgetId[] = ['circle', 'timeline', 'needs', 'steps']

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init, headers: { 'Content-Type': 'application/json', ...init?.headers }, credentials: 'same-origin',
  })
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: string }
    throw new Error(payload.error || `Request failed (${response.status})`)
  }
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

function readableDate(value: string): string {
  return new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}
function readableTime(value: string): string {
  return new Date(value).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}
function durationSince(value: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000))
  return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`
}

export default function App() {
  const [settings, setSettings] = useState<Settings>(defaultSettings)
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [detail, setDetail] = useState<ConversationDetail | null>(null)
  const [voiceConfigured, setVoiceConfigured] = useState(false)
  const [page, setPage] = useState<'home' | 'call' | 'workspace' | 'history'>('home')
  const [callState, setCallState] = useState<'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking' | 'ended'>('idle')
  const [muted, setMuted] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [selectedSource, setSelectedSource] = useState<string | null>(null)
  const [editingFact, setEditingFact] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [draft, setDraft] = useState('')
  const [replayIndex, setReplayIndex] = useState<number | null>(null)
  const [tick, setTick] = useState(0)
  const connection = useRef<RTCPeerConnection | null>(null)
  const channel = useRef<RTCDataChannel | null>(null)
  const stream = useRef<MediaStream | null>(null)
  const player = useRef<HTMLAudioElement | null>(null)
  const socket = useRef<WebSocket | null>(null)
  const activeId = useRef<string | null>(null)
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const refresh = useCallback(async (id: string) => {
    const next = await api<ConversationDetail>(`/api/conversations/${id}`)
    if (activeId.current === id) setDetail(next)
  }, [])

  const openConversation = useCallback(async (id: string, target: typeof page = 'call') => {
    activeId.current = id
    setError('')
    setReplayIndex(null)
    await refresh(id)
    setPage(target)
    socket.current?.close()
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(`${protocol}//${location.host}/events?conversation=${encodeURIComponent(id)}`)
    socket.current = ws
    ws.onmessage = () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current)
      refreshTimer.current = setTimeout(() => { void refresh(id).catch(setErrorFromUnknown) }, 80)
    }
    ws.onclose = () => { if (activeId.current === id) setStatus('Live updates disconnected. Saved history remains available.') }
  }, [refresh])

  function setErrorFromUnknown(value: unknown) { setError(value instanceof Error ? value.message : String(value)) }

  useEffect(() => {
    void api<{ conversations: Conversation[]; voiceConfigured: boolean }>('/api/bootstrap')
      .then(data => { setConversations(data.conversations); setVoiceConfigured(data.voiceConfigured) })
      .catch(setErrorFromUnknown)
    const timer = setInterval(() => setTick(value => value + 1), 1000)
    return () => { clearInterval(timer); socket.current?.close(); connection.current?.close(); stream.current?.getTracks().forEach(track => track.stop()) }
  }, [])

  async function start(): Promise<void> {
    setError('')
    setStatus('Preparing a private conversation…')
    setCallState('connecting')
    let created: Conversation | null = null
    try {
      created = await api<Conversation>('/api/conversations', { method: 'POST', body: JSON.stringify(settings) })
      setConversations(value => [created!, ...value])
      await openConversation(created.id)
      if (!voiceConfigured) {
        setCallState('idle')
        setStatus('Text sandbox is ready. Add an OpenAI key to enable live voice.')
        return
      }
      const microphone = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
      stream.current = microphone
      const pc = new RTCPeerConnection()
      connection.current = pc
      for (const track of microphone.getTracks()) pc.addTrack(track, microphone)
      const audio = new Audio()
      audio.autoplay = true
      player.current = audio
      pc.ontrack = event => { audio.srcObject = event.streams[0]; void audio.play().catch(() => setStatus('Tap the speaker control to hear Harbor.')) }
      const dc = pc.createDataChannel('oai-events')
      channel.current = dc
      dc.onmessage = event => {
        const message = JSON.parse(event.data) as { type?: string }
        if (message.type?.includes('speech_started')) setCallState('listening')
        else if (message.type === 'response.created') setCallState('thinking')
        else if (message.type?.includes('audio_transcript.delta')) setCallState('speaking')
        else if (message.type === 'response.done') setCallState('listening')
      }
      await pc.setLocalDescription(await pc.createOffer())
      const answer = await api<{ sdp: string }>(`/api/conversations/${created.id}/connect`, {
        method: 'POST', body: JSON.stringify({ sdp: pc.localDescription?.sdp }),
      })
      await pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp })
      setCallState('listening')
      setStatus('Transcript saving • Take your time')
    } catch (cause) {
      cleanupMedia()
      setCallState('idle')
      setErrorFromUnknown(cause)
      setStatus('Voice did not connect. This conversation is still saved.')
    }
  }

  function cleanupMedia(): void {
    stream.current?.getTracks().forEach(track => track.stop())
    stream.current = null
    player.current?.pause()
    if (player.current) player.current.srcObject = null
    connection.current?.close()
    connection.current = null
    channel.current = null
  }

  async function end(): Promise<void> {
    cleanupMedia()
    setCallState('ended')
    setStatus('Finishing saved conversation…')
    if (!activeId.current) return
    try {
      await api(`/api/conversations/${activeId.current}/end`, { method: 'POST' })
      await refresh(activeId.current)
      setConversations(await api<{ conversations: Conversation[] }>('/api/bootstrap').then(value => value.conversations))
      setStatus('Conversation saved')
    } catch (cause) { setErrorFromUnknown(cause); setStatus('Could not confirm final save') }
  }

  async function sendText(): Promise<void> {
    if (!detail || !draft.trim()) return
    const text = draft.trim()
    setDraft('')
    try {
      await api(`/api/conversations/${detail.conversation.id}/turns`, { method: 'POST', body: JSON.stringify({ text }) })
      await refresh(detail.conversation.id)
    } catch (cause) { setErrorFromUnknown(cause) }
  }

  async function saveCorrection(fact: Fact): Promise<void> {
    if (!editValue.trim()) return
    try {
      await api(`/api/facts/${fact.id}`, { method: 'PATCH', body: JSON.stringify({ detail: editValue.trim() }) })
      setEditingFact(null)
      setEditValue('')
      await refresh(fact.conversation_id)
    } catch (cause) { setErrorFromUnknown(cause) }
  }

  async function removeConversation(): Promise<void> {
    if (!detail || !window.confirm('Delete this conversation and its saved details?')) return
    const id = detail.conversation.id
    cleanupMedia()
    try {
      await api(`/api/conversations/${id}`, { method: 'DELETE' })
      activeId.current = null
      socket.current?.close()
      setDetail(null)
      setConversations(value => value.filter(item => item.id !== id))
      setPage('history')
    } catch (cause) { setErrorFromUnknown(cause) }
  }

  function openSource(turnId: string) {
    setSelectedSource(turnId)
    setTimeout(() => document.getElementById(`turn-${turnId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50)
  }

  function widgetCard(widget: WidgetId, compact = false) {
    const meta = widgetMeta[widget]
    const Icon = meta.icon
    const state = detail?.widgets.find(value => value.widget === widget)
    const allFacts = detail?.facts.filter(value => value.widget === widget) || []
    const visibleFacts = replayIndex === null ? allFacts : (detail?.events.slice(0, replayIndex + 1)
      .filter(event => event.type === 'fact').map(event => event.data as Fact).filter(value => value.widget === widget) || [])
    const facts = visibleFacts.filter(value => value.status !== 'corrected')
    return <section className={`widget widget-${meta.color} ${compact ? 'compact' : ''}`} key={widget}>
      <div className="widget-top">
        <span className={`widget-icon ${meta.color}`}><Icon size={19} strokeWidth={1.8} /></span>
        <div className="widget-heading"><h3>{meta.title}</h3><p>{meta.subtitle}</p></div>
        <span className={`widget-state ${state?.status || 'waiting'}`} title={state?.status || 'Waiting'}>
          <span className="state-dot" />{state?.status === 'current' ? 'Current' : state?.status === 'working' ? 'Updating' : state?.status === 'failed' ? 'Needs retry' : 'Waiting'}
        </span>
      </div>
      <div className="widget-body">
        {facts.length ? facts.map(fact => <article className="fact" key={fact.id}>
          <div className="fact-main"><strong>{fact.title}</strong><span className={`fact-status ${fact.status}`}>{fact.status.replace('_', ' ')}</span></div>
          {editingFact === fact.id ? <div className="fact-edit">
            <textarea aria-label={`Correct ${fact.title}`} value={editValue} onChange={event => setEditValue(event.target.value)} />
            <div><button className="text-button" onClick={() => setEditingFact(null)}>Cancel</button><button className="small-primary" onClick={() => void saveCorrection(fact)}>Save correction</button></div>
          </div> : <><p>{fact.detail}</p><div className="fact-actions">
            <button onClick={() => openSource(fact.source_turn_id)}>View source <ChevronRight size={13} /></button>
            {replayIndex === null && <button onClick={() => { setEditingFact(fact.id); setEditValue(fact.detail) }}>Correct</button>}
          </div></>}
        </article>) : <div className="empty-widget"><span className="empty-dash">✦</span><p>{widget === 'circle' ? 'People and helpers will appear here.' : widget === 'timeline' ? 'Important events will take shape here.' : widget === 'needs' ? 'We’ll keep track of what matters.' : 'Agreed actions will stay visible here.'}</p></div>}
      </div>
      {state?.duration_ms != null && <div className="widget-foot">Updated in {(state.duration_ms / 1000).toFixed(1)}s</div>}
    </section>
  }

  const latestSteps = useMemo(() => detail?.facts.filter(f => f.widget === 'steps' && f.status !== 'corrected').slice(-3) || [], [detail])
  const currentConversation = detail?.conversation
  const isActive = currentConversation?.status === 'live' || callState === 'connecting' || (currentConversation?.status === 'ready' && !voiceConfigured)

  return <div className="app-shell">
    <header className="site-header">
      <button className="brand" onClick={() => setPage('home')} aria-label="Harbor home"><span className="brand-mark"><AudioLines size={21} /></span><span>harbor<span className="brand-period">.</span></span></button>
      <nav aria-label="Main navigation"><button className={page === 'home' ? 'nav-active' : ''} onClick={() => setPage('home')}>Home</button><button className={page === 'history' ? 'nav-active' : ''} onClick={() => setPage('history')}><History size={15} /> Conversations</button></nav>
      <span className="header-note"><span className="header-heart">●</span> Here to help, one step at a time</span>
    </header>

    {error && <div className="error-banner" role="alert"><Info size={17} /><span>{error}</span><button onClick={() => setError('')} aria-label="Dismiss error"><X size={17} /></button></div>}

    {page === 'home' && <main className="home-main">
      <div className="hero-copy"><div className="eyebrow"><Sparkles size={14} /> A calmer way forward</div><h1>Every conversation<br /><em>moves care forward.</em></h1><p>A gentle place to talk through what’s happening, remember what matters, and find one clear next step.</p><div className="hero-actions"><button className="primary-button" onClick={() => void start()} disabled={callState === 'connecting'}><Mic size={18} />{voiceConfigured ? 'Start a conversation' : 'Open text sandbox'}<ArrowRight size={18} /></button><span className="privacy-caption"><ShieldCheck size={16} /> Your conversation is saved privately</span></div></div>
      <div className="hero-art" aria-hidden="true"><div className="hero-ring outer" /><div className="hero-ring mid" /><div className="hero-ring inner" /><div className="hero-orb"><AudioLines size={57} strokeWidth={1.4} /></div><span className="orbit-label orbit-one">A little clarity</span><span className="orbit-label orbit-two">One step at a time</span></div>
      <div className="home-bottom">
        <section className="settings-panel"><div className="section-kicker"><Settings2 size={15} /> MAKE IT YOURS</div><h2>How would you like to talk?</h2><p>Choose what feels comfortable. You can change this before each conversation.</p><div className="setting-row"><label>I’m here as</label><div className="segmented"><button className={settings.mode === 'family' ? 'selected' : ''} onClick={() => setSettings({ ...settings, mode: 'family' })}>Family or caregiver</button><button className={settings.mode === 'patient' ? 'selected' : ''} onClick={() => setSettings({ ...settings, mode: 'patient' })}>Patient</button></div></div><div className="settings-grid"><label>Conversation style<select value={settings.style} onChange={event => setSettings({ ...settings, style: event.target.value as Settings['style'] })}><option value="gentle">Gentle & reassuring</option><option value="direct">Clear & concise</option></select></label><label>Speaking pace<select value={settings.pace} onChange={event => setSettings({ ...settings, pace: event.target.value as Settings['pace'] })}><option value="unhurried">Unhurried</option><option value="balanced">Balanced</option></select></label><label>Today’s focus<select value={settings.focus} onChange={event => setSettings({ ...settings, focus: event.target.value as Settings['focus'] })}><option value="everyday">Everyday support</option><option value="appointments">Appointments</option><option value="caregiver">Caregiver support</option></select></label><label>Voice<select value={settings.voice} onChange={event => setSettings({ ...settings, voice: event.target.value as Settings['voice'] })}><option value="marin">Marin</option><option value="cedar">Cedar</option><option value="alloy">Alloy</option></select></label></div></section>
        <section className="recent-panel"><div className="section-kicker"><Clock3 size={15} /> CONTINUITY</div><h2>Pick up where you left off</h2><p>What you share can help the next conversation begin with context.</p>{conversations.length ? <div className="recent-list">{conversations.slice(0, 3).map(item => <button key={item.id} onClick={() => void openConversation(item.id, 'call')}><span className="recent-icon"><AudioLines size={18} /></span><span><strong>{item.settings.mode === 'patient' ? 'Patient' : 'Family'} conversation</strong><small>{readableDate(item.started_at)} · {item.status === 'ended' ? 'Saved' : item.status}</small></span><ChevronRight size={18} /></button>)}</div> : <div className="recent-empty"><span className="empty-sparkle">✦</span><strong>Your story starts here</strong><span>Conversations and next steps will appear in this space.</span></div>}</section>
      </div>
      <div className="bottom-note"><Info size={15} /> Harbor is an AI care support prototype for practical navigation. It does not provide medical advice or arrange services for you.</div>
    </main>}

    {page === 'history' && <main className="history-main"><button className="back-link" onClick={() => setPage('home')}><ArrowLeft size={17} /> Back home</button><div className="page-heading"><div className="section-kicker">YOUR CONVERSATIONS</div><h1>A place to remember<br /><em>what matters.</em></h1><p>Revisit a conversation and the details that came from it.</p></div>{conversations.length ? <div className="history-list">{conversations.map(item => <button key={item.id} onClick={() => void openConversation(item.id, 'call')}><span className="history-icon"><AudioLines size={21} /></span><span className="history-text"><strong>{item.settings.mode === 'patient' ? 'Patient' : 'Family'} conversation</strong><small>{readableDate(item.started_at)} at {readableTime(item.started_at)}</small></span><span className="history-status">{item.status === 'ended' ? 'Saved' : item.status}</span><ArrowRight size={19} /></button>)}</div> : <div className="history-empty">No conversations yet. Start one when you’re ready.</div>}</main>}

    {(page === 'call' || page === 'workspace') && currentConversation && <main className="session-main">
      <div className="session-header"><button className="back-link" onClick={() => setPage('home')}><ArrowLeft size={17} /> Back home</button><div className="session-title"><span className="session-kicker">{currentConversation.settings.mode === 'patient' ? 'PATIENT' : 'FAMILY'} CONVERSATION</span><h1>{currentConversation.status === 'ended' ? 'A conversation to keep.' : 'Take your time. I’m here.'}</h1><p>{currentConversation.status === 'ended' ? readableDate(currentConversation.started_at) : 'We can take this one step at a time.'}</p></div><button className="icon-button" title="Delete conversation" aria-label="Delete conversation" onClick={() => void removeConversation()}><X size={18} /></button></div>
      <div className="session-tabs" role="tablist"><button role="tab" aria-selected={page === 'call'} className={page === 'call' ? 'selected' : ''} onClick={() => setPage('call')}><AudioLines size={17} /> Conversation</button><button role="tab" aria-selected={page === 'workspace'} className={page === 'workspace' ? 'selected' : ''} onClick={() => setPage('workspace')}><LayoutGrid size={17} /> Live workspace <span className="tab-badge">4</span></button></div>

      {page === 'call' && <div className="call-layout"><section className="call-surface"><div className="call-top"><div className="live-state"><span className={`live-dot ${isActive ? 'pulse' : ''}`} />{currentConversation.status === 'ended' ? 'Conversation saved' : callState === 'connecting' ? 'Connecting' : voiceConfigured ? 'Live conversation' : 'Text sandbox'}</div><span className="call-timer"><Clock3 size={16} />{currentConversation.status === 'ended' && currentConversation.ended_at ? readableTime(currentConversation.ended_at) : durationSince(currentConversation.started_at)}{void tick}</span></div><div className={`call-orb ${callState}`}><div className="orb-wave a" /><div className="orb-wave b" /><span className="orb-center"><AudioLines size={48} strokeWidth={1.35} /></span></div><h2>{currentConversation.status === 'ended' ? 'Thank you for sharing.' : callState === 'speaking' ? 'Harbor is speaking' : callState === 'thinking' ? 'Thinking with you…' : callState === 'connecting' ? 'Finding a connection…' : 'I’m listening.'}</h2><p className="call-guidance">{status || 'You can talk naturally. There is no rush.'}</p><div className="call-controls">{voiceConfigured && currentConversation.status === 'live' && <button className={`round-control ${muted ? 'muted' : ''}`} title={muted ? 'Unmute microphone' : 'Mute microphone'} aria-label={muted ? 'Unmute microphone' : 'Mute microphone'} onClick={() => { stream.current?.getAudioTracks().forEach(track => { track.enabled = muted }); setMuted(!muted) }}>{muted ? <MicOff size={22} /> : <Mic size={22} />}</button>}{voiceConfigured && currentConversation.status === 'live' && <button className="round-control" title="Play voice output" aria-label="Play voice output" onClick={() => void player.current?.play()}><Volume2 size={22} /></button>}{isActive && <button className="end-control" onClick={() => void end()}><Square size={15} fill="currentColor" /> End conversation</button>}{currentConversation.status === 'ended' && <button className="outline-control" onClick={() => setPage('workspace')}>Review what we heard <ArrowRight size={16} /></button>}</div>{!voiceConfigured && currentConversation.status !== 'ended' && <div className="sandbox-entry"><label htmlFor="sandbox-text">Explore with text while live voice is being connected</label><div><input id="sandbox-text" value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void sendText() }} placeholder="I help my dad, and he needs a ride Tuesday…" /><button aria-label="Send text" onClick={() => void sendText()}><Send size={18} /></button></div></div>}</section><aside className="call-side"><div className="side-heading"><span className="section-kicker"><Sparkles size={14} /> THE THREAD</span><h2>What we’re holding onto</h2><p>These details can help your next conversation start with understanding.</p></div><div className="mini-transcript">{detail.turns.length ? detail.turns.slice(-5).map(turn => <div key={turn.id} className={`mini-turn ${turn.speaker}`}><span>{turn.speaker === 'user' ? 'You' : 'Harbor'}</span><p>{turn.text}</p></div>) : <div className="mini-empty">Your conversation will appear here as it unfolds.</div>}</div><div className="next-actions"><div><CheckCircle2 size={18} /><strong>Next steps</strong></div>{latestSteps.length ? latestSteps.map(fact => <p key={fact.id}>{fact.detail}</p>) : <p>We’ll collect any agreed next steps here.</p>}</div></aside></div>}

      {page === 'workspace' && <div className="workspace-layout"><section className="transcript-panel"><div className="panel-heading"><div><span className="section-kicker">LIVE SESSION</span><h2>Conversation transcript</h2></div><span className={`stream-tag ${currentConversation.status === 'live' ? 'on' : ''}`}><span />{currentConversation.status === 'live' ? 'Streaming' : 'Saved'}</span></div><p className="transcript-intro">Every detail connects back to something said. Select a source on the right to see it here.</p><div className="transcript-list">{detail.turns.length ? detail.turns.map((turn: Turn) => <article id={`turn-${turn.id}`} key={turn.id} className={`transcript-turn ${turn.speaker} ${selectedSource === turn.id ? 'highlighted' : ''}`}><div className="turn-avatar">{turn.speaker === 'user' ? <Users size={16} /> : <AudioLines size={16} />}</div><div className="turn-content"><div className="turn-meta"><strong>{turn.speaker === 'user' ? 'You' : 'Harbor'}</strong><span>{readableTime(turn.created_at)}</span>{turn.interrupted && <span>Interrupted</span>}</div><p>{turn.text}</p></div></article>) : <div className="transcript-empty"><AudioLines size={28} /><p>The transcript will build here as the conversation continues.</p></div>}</div><div className="activity-panel"><div><Activity size={17} /><strong>Extraction activity</strong></div><p>{detail.facts.length} saved details · {detail.widgets.filter(widget => widget.status === 'working').length} processors updating</p><span>Each detail links to the words that support it.</span></div></section><section className="widgets-panel"><div className="widgets-heading"><div><span className="section-kicker">FOUR INDEPENDENT VIEWS</span><h2>What’s taking shape</h2></div><span className="update-caption"><span className="small-pulse" /> {currentConversation.status === 'live' ? 'Updating as you speak' : 'Saved from this session'}</span></div><div className="widget-grid">{widgetOrder.map(widget => widgetCard(widget))}</div><div className="replay-panel"><div><Play size={16} /><strong>Conversation replay</strong><span>Inspect what was known at each moment</span></div><input type="range" min="0" max={Math.max(0, detail.events.length - 1)} value={replayIndex ?? Math.max(0, detail.events.length - 1)} onChange={event => setReplayIndex(Number(event.target.value))} aria-label="Replay conversation events" /><small>{replayIndex === null || replayIndex === detail.events.length - 1 ? 'Latest state' : `Event ${replayIndex + 1} of ${detail.events.length}`}</small>{replayIndex !== null && <button className="text-button" onClick={() => setReplayIndex(null)}>Return to live</button>}</div></section></div>}
    </main>}
  </div>
}

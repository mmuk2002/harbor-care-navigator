export const widgetIds = ['circle', 'timeline', 'needs', 'steps'] as const
export type WidgetId = typeof widgetIds[number]
export type Mode = 'patient' | 'family'
export type Provider = 'openai' | 'gemini'

export interface Settings {
  provider: Provider
  mode: Mode
  style: 'gentle' | 'direct'
  pace: 'unhurried' | 'balanced'
  focus: 'everyday' | 'appointments' | 'caregiver'
  voice: 'marin' | 'cedar' | 'alloy' | 'Kore' | 'Aoede' | 'Sulafat'
}

export interface Conversation {
  id: string
  visitor_id: string
  status: 'ready' | 'connecting' | 'live' | 'ended' | 'incomplete'
  settings: Settings
  started_at: string
  ended_at: string | null
  provider_call_id: string | null
}

export interface Turn {
  id: string
  conversation_id: string
  source_id: string
  speaker: 'user' | 'assistant'
  text: string
  created_at: string
  seq: number
  interrupted: boolean
}

export interface Fact {
  id: string
  conversation_id: string
  widget: WidgetId
  title: string
  detail: string
  status: 'reported' | 'needs_review' | 'proposed' | 'agreed' | 'completed' | 'corrected'
  source_turn_id: string
  source_quote: string
  supersedes_id: string | null
  created_at: string
}

export interface AppEvent {
  seq: number
  conversation_id: string
  type: 'conversation' | 'turn' | 'fact' | 'widget' | 'error'
  data: unknown
  created_at: string
}

export interface WidgetState {
  widget: WidgetId
  status: 'waiting' | 'working' | 'current' | 'failed'
  processed_turn_id: string | null
  duration_ms: number | null
  updated_at: string | null
}

export interface ConversationDetail {
  conversation: Conversation
  turns: Turn[]
  facts: Fact[]
  widgets: WidgetState[]
  events: AppEvent[]
}

/** Longitudinal patient memory shared by every conversation in this browser profile. */
export interface PatientProfile {
  facts: Fact[]
  conversation_count: number
  last_activity: string | null
}

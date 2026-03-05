import type { ModelMessage } from 'ai'

export type Priority = 'P0' | 'P1' | 'P2'
export type DJMode = 'tool' | 'json' | 'safe_groove_only'
export type Facet = 'genre' | 'energy' | 'tempo' | 'mood' | 'general'

export interface RequestEnvelope {
  id: string
  text: string
  priority: Priority
  source: 'ui' | 'stdin' | 'openclaw'
  facet: Facet
  timestampMs: number
}

export interface PatternRecord {
  code: string
  cpm: number
  vibe: string
  reason: string
  ts: number
}

export interface ChatRecord {
  id: string
  role: 'user' | 'assistant' | 'system'
  text: string
  ts: number
  code?: string
}

export interface BreakerBucketState {
  state: 'closed' | 'open' | 'half-open'
  consecutiveFailures: number
  consecutiveSuccesses: number
  openedAtPhrase: number | null
}

export interface DJState {
  sessionId: string
  sessionStartMs: number
  activeModel: string
  mode: DJMode
  localMode: boolean
  playbackActive: boolean
  history: ModelMessage[]
  chatLog: ChatRecord[]
  requestQueue: RequestEnvelope[]
  currentVibe: string
  currentCPM: number
  currentKey: string
  recentVibes: string[]
  barDurationMs: number
  phraseLength: number
  phraseMs: number
  currentPhraseIndex: number
  currentCode: string
  volumeMultiplier: number
  pendingTick: string
  lastError: string | null
  transitioning: boolean
  allowedSamples: string[]
  patternHistory: PatternRecord[]
  breakerState: Record<'syntax' | 'bridge_timeout' | 'model_timeout', BreakerBucketState>
}

export function inferFacet(text: string): Facet {
  const lower = text.toLowerCase()
  if (/(house|techno|dnb|jungle|ambient|breakbeat|trap|garage|genre)/.test(lower)) return 'genre'
  if (/(energy|harder|softer|aggressive|chill|intense|punchy|calm)/.test(lower)) return 'energy'
  if (/(tempo|bpm|faster|slower|speed|up|down)/.test(lower)) return 'tempo'
  if (/(mood|vibe|feel|dark|happy|uplift|melancholy|warm)/.test(lower)) return 'mood'
  return 'general'
}

export function makeRequest(input: Omit<RequestEnvelope, 'id' | 'facet' | 'timestampMs'>): RequestEnvelope {
  return {
    ...input,
    id: crypto.randomUUID(),
    facet: inferFacet(input.text),
    timestampMs: Date.now()
  }
}

export function updateTempoDerivedFields(state: DJState, cpm: number): void {
  state.currentCPM = cpm
  state.barDurationMs = (60000 / cpm) * 4
  state.phraseMs = state.barDurationMs * state.phraseLength
}

export function enqueueRequest(state: DJState, req: RequestEnvelope, queueMax: number): void {
  if (req.priority === 'P1') {
    state.requestQueue = state.requestQueue.filter((r) => !(r.priority === 'P1' && r.facet === req.facet))
  }

  if (req.priority === 'P0') {
    state.requestQueue.unshift(req)
  } else {
    state.requestQueue.push(req)
  }

  while (state.requestQueue.length > queueMax) {
    const p2Index = state.requestQueue.findIndex((r) => r.priority === 'P2')
    if (p2Index >= 0) {
      state.requestQueue.splice(p2Index, 1)
    } else {
      state.requestQueue.shift()
    }
  }
}

export function dequeueRequest(state: DJState): RequestEnvelope | null {
  const p0 = state.requestQueue.findIndex((r) => r.priority === 'P0')
  if (p0 >= 0) return state.requestQueue.splice(p0, 1)[0] ?? null

  const p1 = state.requestQueue.findIndex((r) => r.priority === 'P1')
  if (p1 >= 0) return state.requestQueue.splice(p1, 1)[0] ?? null

  const p2 = state.requestQueue.findIndex((r) => r.priority === 'P2')
  if (p2 >= 0) return state.requestQueue.splice(p2, 1)[0] ?? null

  return null
}

export function pushChat(state: DJState, record: Omit<ChatRecord, 'id' | 'ts'>): void {
  state.chatLog.push({ ...record, id: crypto.randomUUID(), ts: Date.now() })
  if (state.chatLog.length > 300) state.chatLog = state.chatLog.slice(-300)
}

export function trimHistory(state: DJState, maxTurns: number): void {
  if (state.history.length > maxTurns) {
    const first = state.history[0]
    state.history = first ? [first, ...state.history.slice(-(maxTurns - 1))] : state.history.slice(-maxTurns)
  }
}

export function createInitialState(params: {
  activeModel: string
  mode: DJMode
  localMode: boolean
  phraseLength: number
  allowedSamples: string[]
}): DJState {
  const cpm = 124
  const bar = (60000 / cpm) * 4
  const emptyBucket = (): BreakerBucketState => ({
    state: 'closed',
    consecutiveFailures: 0,
    consecutiveSuccesses: 0,
    openedAtPhrase: null
  })

  return {
    sessionId: crypto.randomUUID(),
    sessionStartMs: Date.now(),
    activeModel: params.activeModel,
    mode: params.mode,
    localMode: params.localMode,
    playbackActive: false,
    history: [],
    chatLog: [],
    requestQueue: [],
    currentVibe: 'idle',
    currentCPM: cpm,
    currentKey: 'unknown',
    recentVibes: [],
    barDurationMs: bar,
    phraseLength: params.phraseLength,
    phraseMs: bar * params.phraseLength,
    currentPhraseIndex: 0,
    currentCode: '',
    volumeMultiplier: 0.8,
    pendingTick: '',
    lastError: null,
    transitioning: false,
    allowedSamples: params.allowedSamples,
    patternHistory: [],
    breakerState: {
      syntax: emptyBucket(),
      bridge_timeout: emptyBucket(),
      model_timeout: emptyBucket()
    }
  }
}

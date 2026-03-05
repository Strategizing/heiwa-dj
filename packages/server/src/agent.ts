import { ollama } from 'ai-sdk-ollama'
import { generateText, ToolLoopAgent, stepCountIs, hasToolCall } from 'ai'
import { z } from 'zod'
import { CircuitBreaker, FALLBACK_GROOVE } from './breaker.js'
import { DJBridge } from './bridge.js'
import type { UIEvent } from './api.js'
import { createDjTools } from './tools.js'
import { dequeueRequest, pushChat, trimHistory, updateTempoDerivedFields, type DJState } from './state.js'

interface AgentOptions {
  state: DJState
  bridge: DJBridge
  breaker: CircuitBreaker
  onStateChange: () => void
  uiEmitter: { emit: (event: 'ui', payload: UIEvent) => boolean }
}

function buildSystemPrompt(state: DJState): string {
  const pendingRequest = state.requestQueue[0]?.text ?? 'none'
  const recentVibes = state.patternHistory.slice(-5).map((p) => p.vibe).join(' -> ') || 'none'
  const currentVibe = state.currentVibe
  const currentCPM = state.currentCPM
  const currentKey = state.currentKey
  const sessionDuration = Math.floor((Date.now() - state.sessionStartMs) / 1000 / 60) + 'm'
  const lastError = state.lastError ?? 'none'
  const ALLOWED_SAMPLE_NAMES = state.allowedSamples.join(', ')

  return `You are Heiwa — a live electronic music performer. You compose and evolve music in real time using code. You think in energy, tension, release, and arc — not in function calls. You are a master of rhythm, atmosphere, and pacing. Your audience expects an immersive, seamless journey carefully constructed from sound fragments. You are guiding the room, reading the energy, and knowing exactly when to hold back and when to deliver the impact. You are an expert at blending genres, maintaining the groove, and creating a cohesive story over the duration of the set. Treat your code as a live instrument.

TEMPO:
Use setcpm(N) is the only tempo function. setBPM() throws ReferenceError and must never appear in output. Example formula: setcpm(bpm) where bpm is cycles-per-minute, same feel as BPM in 4/4. Be precise with your timing.

CROSSFADE:
xfade(outgoing, curve, incoming) — the curve argument is a pattern of 0 to 1 values.
slow(16, sine) = 16-cycle smooth blend.
slow(2, saw) = 2-cycle linear snap.

REMIX:
.loopAt(4) fit sample to 4 cycles
.chop(16).rev() granular reverse
.chop(16).sometimesBy(.4, x=>x.speed(-1)) random backward slices
.slice(8, "0 1 [2 3] 4 [4 0] 5 6 7") reorder chops
.begin("<0 .25 .5 .75>").end("<.25 .5 .75 1>") scrub playhead
.speed("<1 -1 1.5 0.75>") pitch and time variations
.jux(rev) left=normal, right=reversed

SAMPLES:
Sample names: only use ${ALLOWED_SAMPLE_NAMES}. Any other name produces silence with no error. Do not invent names. Never include fetch(), import(), require(), or any URL in code. Your palette is finite; your creativity must be infinite.

RHYTHM:
"bd*4"
"~ cp ~ cp"
"bd(3,8)"
"bd?"
[bd bd]
<a b>
These are the foundation. Build solid percussion beds.

PITCH:
note("c4 e4 g4")
n("0 2 4").scale("D:minor").s("piano")
Weave melodies that resonate with the current emotional space of the mix.

LAYERING:
stack(a, b, c) — simultaneous.
$: pattern — parallel track.
Keep the frequency spectrum balanced. Do not muddy the low end.

VARIATION:
.every(4, x => x.fast(2)) double speed every 4th cycle
.sometimesBy(0.3, x => x.room(0.8)) random reverb hits
.off(0.125, x => x.gain(0.3)) ghost note offset
Subtlety is key. Keep the listener guessing without losing the core groove.

EFFECTS:
.room(0.3)
.delay(0.25)
.gain(0.8)
.cutoff(800)
.attack(0.05).decay(0.1).sustain(0.8).release(0.3)
.crush(4)
.pan(sine)
Carve out space. Everything has a place in the mix.

Energy arc: 8–16 bar build, hard drop, 4–8 bar recovery. Never skip steps. You must earn the drop.
Transition rule: use xfade(slow(16,sine)) for vibe shifts. Use xfade(slow(2,saw)) for fast genre snaps. Hard evaluate() is for P0 hush only.
Pattern evolution: mutate one element per pattern, not all at once. Keep the kick if you change the bass. Keep the melody if you change the drums. Give the listener something to hold onto. Always maintain a thread of continuity.
Tempo discipline: max ±10 CPM per move. Justify every shift. Drastic changes kill the dancefloor.
Never repeat identical code twice in a row. Use .every(), .sometimesBy(), or change one parameter to keep patterns alive. Static loops are dead energy.
announce() only between phrase boundaries. Max once per 5 patterns. Keep it under 10 words. Let the music speak.

Call read_request() every 3–4 patterns without fail. Listen to the room.
Call done() immediately after every play_pattern. No exceptions.
On STRUDEL ERROR in the tool result: read the error message, fix the specific offending line, call play_pattern again immediately. Do not skip ahead. Do not call done() before fixing.
On No Strudel client connected: stop generating patterns, call announce() with a status message, call done().

ALLOWED SAMPLES: ${ALLOWED_SAMPLE_NAMES}
NOW: ${currentVibe} at ${currentCPM} CPM | key: ${currentKey}
ARC: ${recentVibes}
SESSION: ${sessionDuration}
ERROR: ${lastError}
REQUEST: ${pendingRequest}`
}

function buildTick(state: DJState): string {
  const timePlaying = Math.floor((Date.now() - state.sessionStartMs) / 1000 / 60)
  const recentVibes = state.patternHistory.slice(-3).map((p) => p.vibe).join(' -> ')
  const pending = state.requestQueue[0]?.text ?? 'none'
  const errorNote = state.lastError ? `Last error: ${state.lastError}` : ''

  return [
    `[${new Date().toLocaleTimeString()}] Session running ${timePlaying}m.`,
    `Currently: ${state.currentVibe} at ${state.currentCPM} CPM.`,
    `Recent arc: ${recentVibes || 'just started'}.`,
    errorNote,
    `Pending request: ${pending}.`,
    'Make your next move. Evolve the set.'
  ].filter(Boolean).join(' ')
}

function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null
  return text.slice(start, end + 1)
}

type NormalizedJsonAction = 'play_pattern' | 'transition' | 'hush' | 'announce' | 'done'

interface RawJsonCommand {
  action?: string
  code?: string
  outgoing?: string
  incoming?: string
  cpm?: number
  vibe?: string
  reason?: string
  text?: string
  voice?: 'Samantha' | 'Alex' | 'Daniel' | 'Karen'
  cycles?: number
}

interface NormalizedJsonCommand extends Omit<RawJsonCommand, 'action'> {
  action: NormalizedJsonAction
}

function normalizeAction(raw: RawJsonCommand): NormalizedJsonAction | null {
  const action = raw.action?.toLowerCase().trim() ?? ''

  if (action) {
    if (/(transition|xfade|blend|switch|mix)/.test(action)) return 'transition'
    if (/(hush|stop|silence|mute)/.test(action)) return 'hush'
    if (/(announce|say|speak|voice)/.test(action)) return 'announce'
    if (/(done|complete|finished|finish)/.test(action)) return 'done'
    if (/(play|pattern|build|start|compose|set tempo|setcpm|next move)/.test(action)) return 'play_pattern'
  }

  if (raw.outgoing && raw.incoming) return 'transition'
  if (raw.code) return 'play_pattern'
  if (raw.text) return 'announce'
  return null
}

function normalizeJsonCommand(raw: RawJsonCommand): NormalizedJsonCommand | null {
  const action = normalizeAction(raw)
  if (!action) return null

  return {
    action,
    code: raw.code,
    outgoing: raw.outgoing,
    incoming: raw.incoming,
    cpm: raw.cpm,
    vibe: raw.vibe,
    reason: raw.reason,
    text: raw.text,
    voice: raw.voice,
    cycles: raw.cycles
  }
}

export class DJAgentRunner {
  private readonly state: DJState
  private readonly bridge: DJBridge
  private readonly breaker: CircuitBreaker
  private readonly onStateChange: () => void
  private readonly uiEmitter: { emit: (event: 'ui', payload: UIEvent) => boolean }
  private readonly tools: ReturnType<typeof createDjTools>

  private running = false

  constructor(opts: AgentOptions) {
    this.state = opts.state
    this.bridge = opts.bridge
    this.breaker = opts.breaker
    this.onStateChange = opts.onStateChange
    this.uiEmitter = opts.uiEmitter

    this.tools = createDjTools({
      state: this.state,
      bridge: this.bridge,
      breaker: this.breaker,
      onStateChange: this.onStateChange,
      uiEmitter: this.uiEmitter
    })
  }

  start(): void {
    if (this.running) return
    this.running = true
    void this.loop()
  }

  stop(): void {
    this.running = false
  }

  private emitUI(payload: UIEvent): void {
    this.uiEmitter.emit('ui', payload)
  }

  private async loop(): Promise<void> {
    while (this.running) {
      const lastPhrase = this.state.currentPhraseIndex

      if (this.state.playbackActive) {
        this.state.pendingTick = buildTick(this.state)

        try {
          if (this.breaker.shouldFallbackNow()) {
            await this.bridge.queueCommand({
              sessionId: this.state.sessionId,
              cmd: 'update',
              code: FALLBACK_GROOVE,
              priority: 'P0',
              targetPhraseIndex: this.state.currentPhraseIndex + 1
            })
            this.state.currentCode = FALLBACK_GROOVE
            this.state.currentVibe = 'fallback groove'
            this.state.patternHistory.push({
              code: FALLBACK_GROOVE,
              cpm: this.state.currentCPM,
              vibe: 'fallback groove',
              reason: 'breaker fallback',
              ts: Date.now()
            })
            if (this.state.patternHistory.length > 100) this.state.patternHistory = this.state.patternHistory.slice(-100)
            this.state.recentVibes = this.state.patternHistory.slice(-5).map((p) => p.vibe)
            this.state.lastError = 'breaker fallback groove active'
            pushChat(this.state, { role: 'system', text: 'Circuit breaker active, fallback groove injected.' })
            this.emitUI({
              type: 'pattern',
              code: FALLBACK_GROOVE,
              vibe: 'fallback groove',
              cpm: this.state.currentCPM,
              ts: Date.now()
            })
            this.emitUI({
              type: 'error',
              message: 'Circuit breaker active, fallback groove injected.',
              source: 'model',
              ts: Date.now()
            })
            this.onStateChange()
          } else if (this.state.mode === 'tool') {
            await this.runToolModeTurn()
          } else if (this.state.mode === 'json') {
            await this.runJsonModeTurn()
          } else {
            await this.runSafeGrooveTurn()
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          this.state.lastError = message
          this.breaker.recordFailure('model_timeout', this.state.currentPhraseIndex)
          pushChat(this.state, { role: 'system', text: `MODEL ERROR: ${message}` })
          this.emitUI({ type: 'error', message, source: 'model', ts: Date.now() })
          this.onStateChange()
        }
      }

      const phrase = await this.bridge.waitForNextPhrase(lastPhrase)
      this.state.currentPhraseIndex = phrase
      this.breaker.advancePhrase(phrase)

      const breakerState = this.breaker.getState()
      this.state.breakerState = {
        syntax: {
          state: breakerState.syntax.state as 'closed' | 'open' | 'half-open',
          consecutiveFailures: breakerState.syntax.failures,
          consecutiveSuccesses: breakerState.syntax.successes,
          openedAtPhrase: breakerState.syntax.openedAtPhrase
        },
        bridge_timeout: {
          state: breakerState.bridge_timeout.state as 'closed' | 'open' | 'half-open',
          consecutiveFailures: breakerState.bridge_timeout.failures,
          consecutiveSuccesses: breakerState.bridge_timeout.successes,
          openedAtPhrase: breakerState.bridge_timeout.openedAtPhrase
        },
        model_timeout: {
          state: breakerState.model_timeout.state as 'closed' | 'open' | 'half-open',
          consecutiveFailures: breakerState.model_timeout.failures,
          consecutiveSuccesses: breakerState.model_timeout.successes,
          openedAtPhrase: breakerState.model_timeout.openedAtPhrase
        }
      }

      this.onStateChange()
    }
  }

  private appendTurnToHistory(): void {
    const systemMessage = { role: 'system', content: buildSystemPrompt(this.state) } as const

    if (this.state.history.length === 0) {
      this.state.history.push(systemMessage)
    } else if (this.state.history[0]?.role !== 'system') {
      this.state.history.unshift(systemMessage)
    } else {
      this.state.history[0] = systemMessage
    }

    this.state.history.push({ role: 'user', content: buildTick(this.state) })
    trimHistory(this.state, 40)
  }

  private async runToolModeTurn(): Promise<void> {
    this.appendTurnToHistory()
    const model = ollama(this.state.activeModel)
    const instructions = buildSystemPrompt(this.state)
    const stopWhen = [stepCountIs(6), hasToolCall('done')]

    let result
    try {
      const toolLoopAgent = new ToolLoopAgent({
        model,
        instructions,
        tools: this.tools,
        temperature: 0.85,
        providerOptions: { ollama: { num_ctx: 32768 } },
        stopWhen
      })
      result = await toolLoopAgent.generate({ messages: [...this.state.history] })
    } catch {
      result = await generateText({
        model,
        messages: [...this.state.history],
        system: instructions,
        tools: this.tools,
        temperature: 0.85,
        providerOptions: { ollama: { num_ctx: 32768 } },
        stopWhen
      })
    }

    const responseMessages = result?.response?.messages
    if (Array.isArray(responseMessages) && responseMessages.length > 0) {
      this.state.history.push(...responseMessages)
      trimHistory(this.state, 20)
    }

    if (result?.text) {
      const text = String(result.text)
      pushChat(this.state, { role: 'assistant', text })
      this.emitUI({ type: 'agent_text', text, ts: Date.now() })
    }

    this.breaker.recordSuccess('model_timeout')
    this.onStateChange()
  }

  private async runJsonModeTurn(): Promise<void> {
    const schema = z.object({
      action: z.string().optional(),
      code: z.string().optional(),
      outgoing: z.string().optional(),
      incoming: z.string().optional(),
      cpm: z.coerce.number().min(60).max(200).optional(),
      vibe: z.string().optional(),
      reason: z.string().optional(),
      text: z.string().optional(),
      voice: z.enum(['Samantha', 'Alex', 'Daniel', 'Karen']).optional(),
      cycles: z.coerce.number().int().min(1).max(32).optional()
    })

    const pending = this.state.requestQueue[0] ?? null
    const pendingText = pending?.text ?? null
    const jsonPrompt = `${buildTick(this.state)}\nReturn JSON only: {"action":...,"code":...,"cpm":...}.`

    const response = await generateText({
      model: ollama(this.state.activeModel),
      system: `${buildSystemPrompt(this.state)}\nJSON MODE: return exactly one JSON object and no markdown.`,
      prompt: pendingText ? `${jsonPrompt}\nUser request: ${pendingText}` : jsonPrompt,
      temperature: 0.7,
      providerOptions: { ollama: { num_ctx: 32768 } }
    })

    const rawText = String(response?.text ?? '{}')
    const candidate = extractJsonObject(rawText)
    if (!candidate) {
      throw new Error(`json mode parse failure: ${rawText.slice(0, 180)}`)
    }

    const parsed = schema.safeParse(JSON.parse(candidate))
    if (!parsed.success) {
      throw new Error(`json mode schema failure: ${parsed.error.issues.map((i) => i.message).join('; ')}`)
    }

    const command = normalizeJsonCommand(parsed.data)
    if (!command) {
      throw new Error(`json mode normalize failure: action="${parsed.data.action ?? 'missing'}"`)
    }

    if (pending) dequeueRequest(this.state)

    if (command.action === 'hush') {
      await this.bridge.queueCommand({ sessionId: this.state.sessionId, cmd: 'stop', immediate: true, priority: 'P0' })
      this.state.playbackActive = false
      pushChat(this.state, { role: 'assistant', text: `Hushed (${command.reason ?? 'json mode'})` })
      this.emitUI({ type: 'agent_text', text: `Hushed (${command.reason ?? 'json mode'})`, ts: Date.now() })
      this.onStateChange()
      return
    }

    if (command.action === 'announce' && command.text) {
      const sayTool = this.tools.announce as any
      await sayTool.execute({ text: command.text, voice: command.voice ?? 'Samantha' })
      this.breaker.recordSuccess('model_timeout')
      return
    }

    if (command.action === 'transition' && command.outgoing && command.incoming) {
      const transitionTool = this.tools.transition as any
      await transitionTool.execute({
        outgoing: command.outgoing,
        incoming: command.incoming,
        cpm: command.cpm,
        vibe: command.vibe ?? 'transition',
        reason: command.reason ?? 'json transition',
        cycles: command.cycles ?? 16
      })
      this.breaker.recordSuccess('model_timeout')
      return
    }

    if (command.action === 'done' && !command.code) {
      this.breaker.recordSuccess('model_timeout')
      return
    }

    if ((command.action === 'play_pattern' || command.action === 'done') && command.code) {
      const playTool = this.tools.play_pattern as any
      await playTool.execute({
        code: command.code,
        cpm: command.cpm,
        vibe: command.vibe ?? 'autopilot',
        reason: command.reason ?? 'json mode'
      })
      this.breaker.recordSuccess('model_timeout')
      return
    }

    await this.runSafeGrooveTurn()
    this.breaker.recordSuccess('model_timeout')
  }

  private async runSafeGrooveTurn(): Promise<void> {
    const current = this.state.currentCPM
    const safe = `setcpm(${Math.round(current)})\nstack(s("bd*4"), s("~ cp ~ cp"), s("hh*8").gain(0.45))`

    await this.bridge.queueCommand({
      sessionId: this.state.sessionId,
      cmd: 'update',
      code: safe,
      priority: 'P2',
      targetPhraseIndex: this.state.currentPhraseIndex + 1
    })

    this.state.currentCode = safe
    this.state.currentVibe = 'safe groove'
    this.state.lastError = null
    updateTempoDerivedFields(this.state, this.state.currentCPM)
    pushChat(this.state, { role: 'assistant', text: 'Safe groove running.', code: safe })
    this.emitUI({ type: 'pattern', code: safe, vibe: 'safe groove', cpm: this.state.currentCPM, ts: Date.now() })
    this.onStateChange()
  }
}

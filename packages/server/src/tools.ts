import { spawn } from 'node:child_process'
import { tool } from 'ai'
import { z } from 'zod'
import { CircuitBreaker } from './breaker.js'
import { DJBridge } from './bridge.js'
import type { UIEvent } from './api.js'
import { dequeueRequest, pushChat, type DJState } from './state.js'
import { lintStrudelCode } from './linter.js'

interface ToolsContext {
  state: DJState
  bridge: DJBridge
  breaker: CircuitBreaker
  onStateChange: () => void
  uiEmitter: { emit: (event: 'ui', payload: UIEvent) => boolean }
}

function emitUI(ctx: ToolsContext, payload: UIEvent): void {
  ctx.uiEmitter.emit('ui', payload)
}

function extractCpm(code: string): number | null {
  const cpmMatch = code.match(/setcpm\s*\(\s*([0-9]+(?:\.[0-9]+)?)\s*\)/i)
  if (cpmMatch?.[1]) return Number(cpmMatch[1])
  return null
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function applyVolumeMultiplier(code: string, multiplier: number): string {
  const stripped = code.replace(/\nall\(\(x\)=>x\.gain\([^)]+\)\)/g, '').trimEnd()
  if (Math.abs(multiplier - 1) < 0.001) return stripped
  return `${stripped}\nall((x)=>x.gain(${multiplier.toFixed(3)}))`
}

async function sendPattern(ctx: ToolsContext, input: {
  code: string
  cpm?: number
  vibe: string
  reason: string
  targetPhraseIndex?: number
}): Promise<{ ok: boolean; message: string }> {
  const state = ctx.state

  if (!ctx.bridge.isClientConnected()) {
    const message = 'No Strudel client connected. Open strudel.cc or run pnpm dev:local'
    state.lastError = message
    pushChat(state, { role: 'system', text: message })
    emitUI(ctx, { type: 'error', message, source: 'strudel', ts: Date.now() })
    ctx.onStateChange()
    return { ok: false, message }
  }

  const cpm = clamp(input.cpm ?? extractCpm(input.code) ?? state.currentCPM, 60, 200)
  const codeWithVolume = applyVolumeMultiplier(input.code, state.volumeMultiplier)

  const lintError = lintStrudelCode(codeWithVolume, state.allowedSamples)
  if (lintError) {
    state.lastError = lintError
    ctx.breaker.recordFailure('syntax', state.currentPhraseIndex)
    pushChat(state, { role: 'system', text: `STRUDEL ERROR: ${lintError}` })
    emitUI(ctx, { type: 'error', message: lintError, source: 'linter', ts: Date.now() })
    ctx.onStateChange()
    return { ok: false, message: `STRUDEL ERROR: ${lintError}` }
  }

  const result = await ctx.bridge.queueCommand({
    sessionId: state.sessionId,
    cmd: 'update',
    code: codeWithVolume,
    targetPhraseIndex: input.targetPhraseIndex,
    priority: 'P1'
  })

  if (!result.success) {
    state.lastError = result.error ?? 'bridge failure'
    ctx.breaker.recordFailure('bridge_timeout', state.currentPhraseIndex)
    pushChat(state, { role: 'system', text: `BRIDGE ERROR: ${state.lastError}` })
    emitUI(ctx, { type: 'error', message: state.lastError, source: 'strudel', ts: Date.now() })
    ctx.onStateChange()
    return { ok: false, message: `STRUDEL ERROR: ${state.lastError}` }
  }

  state.currentCode = codeWithVolume
  state.currentVibe = input.vibe
  state.currentCPM = cpm
  state.barDurationMs = (60000 / cpm) * 4
  state.phraseMs = state.barDurationMs * state.phraseLength
  state.lastError = null

  state.patternHistory.push({
    code: codeWithVolume,
    cpm,
    vibe: input.vibe,
    reason: input.reason,
    ts: Date.now()
  })
  if (state.patternHistory.length > 100) state.patternHistory = state.patternHistory.slice(-100)

  state.recentVibes = state.patternHistory.slice(-5).map((p) => p.vibe)

  ctx.bridge.setTempo(cpm, state.phraseLength)
  ctx.breaker.recordSuccess('syntax')
  ctx.breaker.recordSuccess('bridge_timeout')

  pushChat(state, { role: 'assistant', text: `${input.vibe} @ ${cpm} CPM`, code: codeWithVolume })
  emitUI(ctx, { type: 'pattern', code: codeWithVolume, vibe: input.vibe, cpm, ts: Date.now() })
  ctx.onStateChange()

  return {
    ok: true,
    message: `Playing: ${input.vibe} @ ${cpm} CPM (phrase ${result.executedPhraseIndex})`
  }
}

export function createDjTools(ctx: ToolsContext) {
  const playPatternSchema = z.object({
    code: z.string().min(1),
    cpm: z.number().min(60).max(200).optional(),
    vibe: z.string().min(1).default('flow'),
    reason: z.string().min(1).default('autopilot'),
    targetPhraseIndex: z.number().int().optional()
  })

  return {
    play_pattern: tool({
      description: 'Inject a Strudel pattern into the next phrase boundary. Always use setcpm().',
      inputSchema: playPatternSchema,
      execute: async (input) => sendPattern(ctx, input)
    }),

    transition: tool({
      description: 'Create a smooth xfade transition between outgoing and incoming patterns.',
      inputSchema: z.object({
        outgoing: z.string().min(1),
        incoming: z.string().min(1),
        cpm: z.number().min(60).max(200).optional(),
        vibe: z.string().min(1).default('transition'),
        reason: z.string().default('smooth transition'),
        cycles: z.number().int().min(1).max(32).default(16)
      }),
      execute: async ({ outgoing, incoming, cpm, vibe, reason, cycles }) => {
        const code = `setcpm(${Math.round(cpm ?? ctx.state.currentCPM)})\nxfade(\n  (${outgoing}),\n  slow(${cycles}, sine),\n  (${incoming})\n)`
        ctx.state.transitioning = true
        const result = await sendPattern(ctx, { code, cpm, vibe, reason })
        ctx.state.transitioning = false
        ctx.onStateChange()
        return result
      }
    }),

    hush: tool({
      description: 'Immediately stop audio output (P0 only).',
      inputSchema: z.object({ reason: z.string().default('hush') }),
      execute: async ({ reason }) => {
        const state = ctx.state
        const result = await ctx.bridge.queueCommand({
          sessionId: state.sessionId,
          cmd: 'stop',
          immediate: true,
          priority: 'P0'
        })

        state.currentCode = ''
        state.lastError = result.success ? null : (result.error ?? 'hush failed')
        state.playbackActive = false
        pushChat(state, { role: 'assistant', text: `Hushed: ${reason}` })
        emitUI(ctx, { type: 'agent_text', text: `Hushed: ${reason}`, ts: Date.now() })
        ctx.onStateChange()
        return result.success ? `Hushed: ${reason}` : `HUSH ERROR: ${state.lastError}`
      }
    }),

    announce: tool({
      description: 'Speak a short DJ announcement with macOS say. Keep it under 100 chars.',
      inputSchema: z.object({
        text: z.string().min(1).max(100),
        voice: z.enum(['Samantha', 'Alex', 'Daniel', 'Karen']).default('Samantha')
      }),
      execute: async ({ text, voice }) => {
        spawn('say', ['-v', voice, text], { stdio: 'ignore', detached: false })
        pushChat(ctx.state, { role: 'assistant', text: `[announce:${voice}] ${text}` })
        emitUI(ctx, { type: 'agent_text', text, ts: Date.now() })
        ctx.onStateChange()
        return `Announced: ${text}`
      }
    }),

    read_request: tool({
      description: 'Drain next request from queue. Priority order: P0, P1, then P2.',
      inputSchema: z.object({}),
      execute: async () => {
        const req = dequeueRequest(ctx.state)
        if (!req) return { found: false, message: 'No pending requests' }
        return {
          found: true,
          id: req.id,
          priority: req.priority,
          facet: req.facet,
          text: req.text,
          source: req.source,
          timestampMs: req.timestampMs
        }
      }
    }),

    get_style_context: tool({
      description: `Retrieve style context from analyzed local songs to inform your next pattern.
Use when the user references a song, energy level, or asks you to match something.
Returns BPM, energy, and genre hints you can use to compose a matching pattern.`,
      inputSchema: z.object({
        query: z.string().describe('e.g. "upbeat house", "dark techno", or a track name')
      }),
      execute: async ({ query }) => {
        return JSON.stringify({
          note: 'No library analyzed yet. Use vibe/genre hints from user request directly.',
          suggestedCPM: ctx.state.currentCPM,
          suggestedVibe: query
        })
      }
    }),

    done: tool({
      description: 'Signal decision complete. Call after play_pattern.',
      inputSchema: z.object({ summary: z.string().min(1) })
    })
  }
}

export type DjTools = ReturnType<typeof createDjTools>

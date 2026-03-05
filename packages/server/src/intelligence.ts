import type { DJState } from './state.js'

export interface LocalDecision {
  handled: boolean
  action?: 'gain' | 'cpm' | 'hush'
  value?: number
  message?: string
}

const GENRE_MAP: Record<string, number> = {
  'techno': 128,
  'house': 124,
  'dnb': 174,
  'jungle': 165,
  'ambient': 90,
  'hiphop': 95,
  'trap': 140
}

export function processLocalIntelligence(state: DJState, text: string): LocalDecision {
  const lower = text.toLowerCase().trim()

  // 1. Volume Controls
  if (/^(louder|volume up|up volume|more volume|crank it)$/.test(lower)) {
    const next = Math.min(1.0, state.volumeMultiplier + 0.1)
    return { handled: true, action: 'gain', value: next, message: `Increasing volume to ${Math.round(next * 100)}%` }
  }
  if (/^(softer|volume down|down volume|less volume|quiet down)$/.test(lower)) {
    const next = Math.max(0.0, state.volumeMultiplier - 0.1)
    return { handled: true, action: 'gain', value: next, message: `Decreasing volume to ${Math.round(next * 100)}%` }
  }

  // 2. Tempo Controls
  if (/^(faster|speed up|increase speed|more tempo|accelerate)$/.test(lower)) {
    const next = Math.min(200, state.currentCPM + 4)
    return { handled: true, action: 'cpm', value: next, message: `Accelerating to ${next} CPM` }
  }
  if (/^(slower|slow down|decrease speed|less tempo|decelerate)$/.test(lower)) {
    const next = Math.max(60, state.currentCPM - 4)
    return { handled: true, action: 'cpm', value: next, message: `Decelerating to ${next} CPM` }
  }

  // 3. Simple Hush
  if (/^(hush|stop|silence|mute|kill)$/.test(lower)) {
    return { handled: true, action: 'hush', message: 'Stopping all audio immediately.' }
  }

  // 4. Genre Snap (Tempo only - still let AI handle the transition/code)
  for (const [genre, bpm] of Object.entries(GENRE_MAP)) {
    if (lower === `set tempo for ${genre}` || lower === `${genre} tempo`) {
      return { handled: true, action: 'cpm', value: bpm, message: `Setting standard ${genre} tempo: ${bpm} CPM` }
    }
  }

  return { handled: false }
}

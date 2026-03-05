import { useEffect, useMemo, useRef, useState } from 'react'
import * as diff from 'diff'

export interface BreakerBucket {
  state: string
  failures: number
  successes: number
  openedAtPhrase: number | null
}

export interface StatusPayload {
  activeModel: string
  model: string
  modelMode: string
  mode: string
  vibe: string
  cpm: number
  currentKey: string
  phraseIndex: number
  phraseMs: number
  playbackActive: boolean
  breakerState: {
    syntax: BreakerBucket
    bridge_timeout: BreakerBucket
    model_timeout: BreakerBucket
  }
  queueLength: number
  bridgeQueueLength: number
  bridgeConnections: number
  clientConnected: boolean
  clientState: 'none' | 'connecting' | 'connected'
  localMode: boolean
  volumeMultiplier: number
  currentPersona: string
  personas: { name: string, description: string }[]
  lastError: string | null
}

interface ControlsProps {
  status: StatusPayload
  nowPlayingCode: string
  prevPlayingCode: string
  snippetText: string
  onControl: (action: 'start' | 'stop' | 'hush') => Promise<void>
  onVolume: (value: number) => Promise<void>
  onTempoRequest: (cpm: number) => Promise<void>
  onPersonaChange: (name: string) => Promise<void>
  onOpenStrudel: () => void
  onCopySnippet: () => Promise<void>
}

function breakerColor(state: string): string {
  if (state === 'open') return '#d62828'
  if (state === 'half-open') return '#f4a261'
  return '#2a9d8f'
}

function vibeColor(vibe: string): string {
  const lower = vibe.toLowerCase()
  if (lower.includes('techno')) return '#3a86ff'
  if (lower.includes('house')) return '#ff9f1c'
  if (lower.includes('ambient')) return '#8e7dff'
  if (lower.includes('dnb') || lower.includes('drum')) return '#e5383b'
  if (lower.includes('breakbeat') || lower.includes('break')) return '#d4e157'
  return '#f1faee'
}

function connectionBannerTone(state: 'none' | 'connecting' | 'connected'): { bg: string; border: string; label: string } {
  if (state === 'connected') return { bg: '#123824', border: '#2a9d8f', label: '🟢 Strudel connected' }
  if (state === 'connecting') return { bg: '#3b2d0d', border: '#f4a261', label: '🟡 Client connecting...' }
  return { bg: '#3b1116', border: '#e76f51', label: '🔴 No Strudel client' }
}

export default function Controls({
  status,
  nowPlayingCode,
  prevPlayingCode,
  snippetText,
  onControl,
  onVolume,
  onTempoRequest,
  onPersonaChange,
  onOpenStrudel,
  onCopySnippet
}: ControlsProps) {
  const [volume, setVolume] = useState(80)
  const [editingCpm, setEditingCpm] = useState(false)
  const [cpmDraft, setCpmDraft] = useState(String(status.cpm))
  const [bannerDismissed, setBannerDismissed] = useState(false)
  const [justConnected, setJustConnected] = useState(false)
  const [pulse, setPulse] = useState(0)
  const [viewMode, setViewMode] = useState<'code' | 'diff' | 'debug'>('code')
  
  const prevClientState = useRef(status.clientState)
  const volumeTimer = useRef<NodeJS.Timeout | null>(null)
  const pulseTimer = useRef<number | null>(null)

  useEffect(() => {
    if (!status.playbackActive || !status.clientConnected) {
      setPulse(0)
      if (pulseTimer.current) cancelAnimationFrame(pulseTimer.current)
      return
    }

    // A beat occurs every (60000 / CPM) ms.
    // Strudel internal cycles default to 4 beats. We want a smooth sine wave pulse.
    const beatMs = 60000 / (status.cpm || 120)
    let startTime = performance.now()

    const animate = (time: number) => {
      const elapsed = time - startTime
      // Calculate a value between 0 and 1 based on the beat interval
      const phase = (elapsed % beatMs) / beatMs
      // Use sine wave for smooth in/out breathing effect, peaking at the beat
      const intensity = (Math.sin((phase * Math.PI * 2) - Math.PI / 2) + 1) / 2
      setPulse(intensity)
      pulseTimer.current = requestAnimationFrame(animate)
    }

    pulseTimer.current = requestAnimationFrame(animate)
    return () => {
      if (pulseTimer.current) cancelAnimationFrame(pulseTimer.current)
    }
  }, [status.playbackActive, status.clientConnected, status.cpm])

  useEffect(() => {
    setCpmDraft(String(status.cpm))
  }, [status.cpm])

  useEffect(() => {
    if (!status.clientConnected) {
      setBannerDismissed(false)
    }
  }, [status.clientConnected])

  useEffect(() => {
    if (
      prevClientState.current !== 'connected' &&
      status.clientState === 'connected'
    ) {
      setJustConnected(true)
      prevClientState.current = status.clientState
      const t = setTimeout(() => setJustConnected(false), 2000)
      return () => clearTimeout(t)
    }
    prevClientState.current = status.clientState
  }, [status.clientState])

  useEffect(() => {
    setVolume(Math.round(status.volumeMultiplier * 100))
  }, [status.volumeMultiplier])

  const bannerTone = useMemo(() => connectionBannerTone(status.clientState), [status.clientState])

  const vibeBadgeColor = useMemo(() => vibeColor(status.vibe), [status.vibe])

  async function submitTempo(): Promise<void> {
    const parsed = Number(cpmDraft)
    if (!Number.isFinite(parsed) || parsed < 60 || parsed > 200) {
      setCpmDraft(String(status.cpm))
      setEditingCpm(false)
      return
    }
    await onTempoRequest(Math.round(parsed))
    setEditingCpm(false)
  }

  return (
    <section style={{
      display: 'flex',
      flexDirection: 'column',
      gap: 24,
      padding: 24,
      height: '100%',
      boxSizing: 'border-box',
      overflowY: 'auto',
      background: 'rgba(5, 8, 12, 0.2)'
    }}>
      {((!status.clientConnected && !bannerDismissed) || justConnected) ? (
        <div style={{
          border: `1px solid ${bannerTone.border}55`,
          background: `${bannerTone.bg}88`,
          borderRadius: 12,
          padding: 16,
          display: 'grid',
          gap: 12,
          backdropFilter: 'blur(8px)'
        }}>
          <div style={{ fontWeight: 800, fontSize: 13, letterSpacing: '0.02em', color: '#fff' }}>
            {bannerTone.label.toUpperCase()}
          </div>
          {status.clientState === 'connected' ? (
            <div style={{ fontSize: 13, color: '#9fe8cf', fontWeight: 500 }}>Connection established. Audio runtime is ready.</div>
          ) : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
              <button
                onClick={onOpenStrudel}
                style={{ border: 0, borderRadius: 8, padding: '10px 16px', cursor: 'pointer', background: '#3a86ff', color: '#fff', fontWeight: 600, fontSize: 13 }}
              >
                OPEN ENGINE
              </button>
              <button
                onClick={() => void onCopySnippet()}
                style={{ border: 0, borderRadius: 8, padding: '10px 16px', cursor: 'pointer', background: 'rgba(255,255,255,0.1)', color: '#fff', fontWeight: 600, fontSize: 13 }}
              >
                COPY SNIPPET
              </button>
              <button
                onClick={() => setBannerDismissed(true)}
                style={{ border: 0, borderRadius: 8, padding: '10px 16px', cursor: 'pointer', background: 'transparent', color: 'rgba(255,255,255,0.4)', fontWeight: 600, fontSize: 12 }}
              >
                DISMISS
              </button>
            </div>
          )}
        </div>
      ) : null}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
        <button
          onClick={() => void onControl('start')}
          disabled={!status.clientConnected}
          style={{
            height: 48,
            border: 0,
            borderRadius: 12,
            background: status.clientConnected ? '#3ddc97' : 'rgba(61, 220, 151, 0.1)',
            color: status.clientConnected ? '#050a08' : 'rgba(61, 220, 151, 0.3)',
            fontWeight: 800,
            fontSize: 13,
            cursor: status.clientConnected ? 'pointer' : 'not-allowed',
            transition: 'all 200ms ease'
          }}
        >
          START
        </button>
        <button
          onClick={() => void onControl('stop')}
          style={{
            height: 48,
            border: '1px solid rgba(255, 255, 255, 0.1)',
            borderRadius: 12,
            background: 'rgba(255, 255, 255, 0.05)',
            color: '#fff',
            fontWeight: 700,
            fontSize: 13,
            cursor: 'pointer'
          }}
        >
          STOP
        </button>
        <button
          onClick={() => void onControl('hush')}
          style={{
            height: 48,
            border: 0,
            borderRadius: 12,
            background: '#ff5c7a',
            color: '#0a0506',
            fontWeight: 800,
            fontSize: 13,
            cursor: 'pointer'
          }}
        >
          HUSH
        </button>
      </div>

      <div style={{
        background: 'rgba(0, 0, 0, 0.2)',
        borderRadius: 16,
        padding: 20,
        border: '1px solid rgba(255, 255, 255, 0.05)',
        display: 'grid',
        gap: 16
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 10, fontWeight: 700, color: '#667c94', letterSpacing: '0.05em' }}>TEMPO / CPM</span>
            {!editingCpm ? (
              <div
                onClick={() => setEditingCpm(true)}
                style={{
                  fontSize: 36,
                  fontWeight: 800,
                  fontFamily: 'ui-monospace, monospace',
                  color: '#fff',
                  cursor: 'pointer',
                  letterSpacing: '-0.02em'
                }}
              >
                {status.cpm}
              </div>
            ) : (
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  value={cpmDraft}
                  onChange={(e) => setCpmDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void submitTempo()
                    if (e.key === 'Escape') {
                      setCpmDraft(String(status.cpm))
                      setEditingCpm(false)
                    }
                  }}
                  autoFocus
                  style={{
                    width: 70,
                    borderRadius: 8,
                    border: '1px solid #3a86ff',
                    background: '#05080c',
                    color: '#fff',
                    fontFamily: 'ui-monospace, monospace',
                    fontSize: 24,
                    padding: '4px 8px',
                    outline: 'none'
                  }}
                />
              </div>
            )}
          </div>

          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: '#667c94', letterSpacing: '0.05em', marginBottom: 6 }}>PERSONA</div>
            <select
              value={status.currentPersona}
              onChange={(e) => void onPersonaChange(e.target.value)}
              style={{
                background: 'rgba(255,255,255,0.05)',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: 8,
                color: '#fff',
                fontSize: 12,
                fontWeight: 600,
                padding: '4px 8px',
                outline: 'none',
                cursor: 'pointer'
              }}
            >
              {status.personas.map(p => (
                <option key={p.name} value={p.name}>{p.name}</option>
              ))}
            </select>
          </div>

          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: '#667c94', letterSpacing: '0.05em', marginBottom: 6 }}>VIBE</div>
            <div style={{
              display: 'inline-block',
              borderRadius: 8,
              padding: '6px 12px',
              border: `1px solid ${vibeBadgeColor}44`,
              background: `${vibeBadgeColor}11`,
              color: vibeBadgeColor,
              fontSize: 13,
              fontWeight: 700,
              textTransform: 'uppercase',
              boxShadow: status.playbackActive ? `0 0 ${10 + (pulse * 30)}px ${vibeBadgeColor}${Math.floor(20 + pulse * 60).toString(16).padStart(2, '0')}` : `0 0 20px ${vibeBadgeColor}22`,
              transition: 'box-shadow 50ms ease-out'
            }}>
              {status.vibe}
            </div>
          </div>
        </div>

        <div style={{ display: 'grid', gap: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, fontWeight: 600, color: '#667c94' }}>
            <span>OUTPUT VOLUME</span>
            <span>{volume}%</span>
          </div>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={volume}
            onChange={(e) => {
              const next = Number(e.currentTarget.value)
              setVolume(next)
              if (volumeTimer.current) clearTimeout(volumeTimer.current)
              volumeTimer.current = setTimeout(() => {
                void onVolume(next / 100)
              }, 150)
            }}
            style={{ width: '100%', accentColor: '#3a86ff' }}
          />
        </div>
      </div>

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 10, minHeight: 0 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <span style={{ fontSize: 10, fontWeight: 700, color: '#667c94', letterSpacing: '0.05em' }}>LIVE PATTERN</span>
            <div style={{ display: 'flex', background: 'rgba(255,255,255,0.05)', borderRadius: 6, overflow: 'hidden' }}>
              {(['code', 'diff', 'debug'] as const).map(m => (
                <button
                  key={m}
                  onClick={() => setViewMode(m)}
                  style={{
                    border: 0,
                    background: viewMode === m ? 'rgba(255,255,255,0.1)' : 'transparent',
                    color: viewMode === m ? '#fff' : '#667c94',
                    fontSize: 10,
                    fontWeight: 700,
                    padding: '4px 8px',
                    cursor: 'pointer',
                    textTransform: 'uppercase'
                  }}
                >
                  {m}
                </button>
              ))}
            </div>
          </div>
          <span style={{ fontSize: 10, fontWeight: 700, color: status.clientConnected ? '#3ddc97' : '#ff5c7a' }}>
            {status.clientState.toUpperCase()}
          </span>
        </div>
        <div style={{
          flex: 1,
          background: 'rgba(0, 0, 0, 0.3)',
          borderRadius: 16,
          border: '1px solid rgba(255, 255, 255, 0.05)',
          padding: 16,
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: status.playbackActive ? `inset 0 0 ${20 + (pulse * 50)}px rgba(61, 220, 151, ${0.05 + (pulse * 0.1)})` : 'none',
          transition: 'box-shadow 50ms ease-out'
        }}>
          <div style={{
            margin: 0,
            flex: 1,
            overflowY: 'auto',
            fontSize: 13,
            lineHeight: 1.6,
            fontFamily: '"Fira Code", "JetBrains Mono", ui-monospace, monospace',
            color: '#94abc7'
          }}>
            {viewMode === 'code' && (
              <pre style={{ margin: 0 }}>{nowPlayingCode || '// Awaiting pattern generation...'}</pre>
            )}
            
            {viewMode === 'diff' && (
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                {diff.diffLines(prevPlayingCode || '', nowPlayingCode || '').map((part, i) => {
                  if (part.added) {
                    return <span key={i} style={{ color: '#3ddc97', background: 'rgba(61, 220, 151, 0.1)', display: 'block' }}>+ {part.value.replace(/\n$/, '')}</span>
                  }
                  if (part.removed) {
                    return <span key={i} style={{ color: '#ff5c7a', background: 'rgba(255, 92, 122, 0.1)', textDecoration: 'line-through', display: 'block' }}>- {part.value.replace(/\n$/, '')}</span>
                  }
                  return <span key={i} style={{ opacity: 0.6, display: 'block' }}>  {part.value.replace(/\n$/, '')}</span>
                })}
              </div>
            )}

            {viewMode === 'debug' && (
              <div style={{ fontSize: 11, display: 'grid', gap: 10 }}>
                <a href="/api/debug" target="_blank" rel="noreferrer" style={{ color: '#3a86ff', textDecoration: 'none', fontWeight: 'bold' }}>
                  → Open Full State Dump (/api/debug)
                </a>
                <pre style={{ margin: 0, opacity: 0.8, color: '#ff9f1c' }}>
                  {JSON.stringify({ 
                    phraseIndex: status.phraseIndex, 
                    queueLength: status.queueLength, 
                    bridgeQueue: status.bridgeQueueLength,
                    phraseMs: status.phraseMs,
                    breakers: status.breakerState
                  }, null, 2)}
                </pre>
              </div>
            )}
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: 8 }}>
        <div style={{ display: 'flex', gap: 12 }}>
          {([
            ['SYN', status.breakerState.syntax.state],
            ['BRG', status.breakerState.bridge_timeout.state],
            ['MDL', status.breakerState.model_timeout.state]
          ] as const).map(([label, state]) => (
            <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{
                width: 7,
                height: 7,
                borderRadius: '50%',
                background: breakerColor(state),
                boxShadow: state === 'open' ? '0 0 8px #d62828' : 'none'
              }} />
              <span style={{ fontSize: 10, fontWeight: 700, color: '#4a5d71' }}>{label}</span>
            </div>
          ))}
        </div>
        <div style={{ fontSize: 11, fontWeight: 500, color: '#4a5d71' }}>
          {status.activeModel}
        </div>
      </div>

      {status.lastError && (
        <div style={{
          padding: 10,
          background: 'rgba(255, 92, 122, 0.1)',
          border: '1px solid rgba(255, 92, 122, 0.2)',
          borderRadius: 8,
          color: '#ff99aa',
          fontSize: 12,
          fontWeight: 500
        }}>
          {status.lastError}
        </div>
      )}
    </section>
  )
}

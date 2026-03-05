import { useEffect, useMemo, useRef, useState } from 'react'

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
  lastError: string | null
}

interface ControlsProps {
  status: StatusPayload
  nowPlayingCode: string
  snippetText: string
  onControl: (action: 'start' | 'stop' | 'hush') => Promise<void>
  onVolume: (value: number) => Promise<void>
  onTempoRequest: (cpm: number) => Promise<void>
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
  snippetText,
  onControl,
  onVolume,
  onTempoRequest,
  onOpenStrudel,
  onCopySnippet
}: ControlsProps) {
  const [volume, setVolume] = useState(80)
  const [editingCpm, setEditingCpm] = useState(false)
  const [cpmDraft, setCpmDraft] = useState(String(status.cpm))
  const [bannerDismissed, setBannerDismissed] = useState(false)
  const [justConnected, setJustConnected] = useState(false)
  const prevClientState = useRef(status.clientState)

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
      border: '1px solid #273445',
      borderRadius: 14,
      padding: 14,
      background: 'linear-gradient(160deg, #101824 0%, #0b1118 100%)',
      display: 'grid',
      gap: 14
    }}>
      {((!status.clientConnected && !bannerDismissed) || justConnected) ? (
        <div style={{
          border: `1px solid ${bannerTone.border}`,
          background: bannerTone.bg,
          borderRadius: 10,
          padding: 10,
          display: 'grid',
          gap: 8
        }}>
          <div style={{ fontWeight: 700 }}>{bannerTone.label}</div>
          {status.clientState === 'connected' ? (
            <div style={{ fontSize: 12, color: '#9fe8cf' }}>Connection established.</div>
          ) : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              <button
                onClick={onOpenStrudel}
                style={{ border: 0, borderRadius: 8, padding: '8px 10px', cursor: 'pointer', background: '#3a86ff', color: '#fff' }}
              >
                Open strudel.cc
              </button>
              <button
                onClick={() => void onCopySnippet()}
                style={{ border: 0, borderRadius: 8, padding: '8px 10px', cursor: 'pointer', background: '#2a9d8f', color: '#06241f', fontWeight: 700 }}
              >
                Copy snippet
              </button>
              <button
                onClick={() => setBannerDismissed(true)}
                style={{ border: '1px solid #31465f', borderRadius: 8, padding: '8px 10px', cursor: 'pointer', background: 'transparent', color: '#d6dee8' }}
              >
                Dismiss
              </button>
            </div>
          )}
          {snippetText ? <div style={{ fontSize: 11, color: '#9eb3c8' }}>Snippet ready from /snippet</div> : null}
        </div>
      ) : null}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button
          onClick={() => void onControl('start')}
          disabled={!status.clientConnected}
          style={{
            padding: '10px 12px',
            border: 0,
            borderRadius: 8,
            background: status.clientConnected ? '#2a9d8f' : '#436a66',
            color: '#06241f',
            fontWeight: 700,
            cursor: status.clientConnected ? 'pointer' : 'not-allowed'
          }}
        >
          ▶ Start Set
        </button>
        <button
          onClick={() => void onControl('stop')}
          style={{ padding: '10px 12px', border: 0, borderRadius: 8, background: '#53687e', color: '#e7edf5', cursor: 'pointer' }}
        >
          ■ Stop
        </button>
        <button
          onClick={() => void onControl('hush')}
          style={{ padding: '10px 12px', border: 0, borderRadius: 8, background: '#d62828', color: '#fff', fontWeight: 700, cursor: 'pointer' }}
        >
          ✕ Hush
        </button>
      </div>

      <div style={{ display: 'grid', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12, color: '#8da2b8' }}>CPM</span>
          {!editingCpm ? (
            <button
              onClick={() => setEditingCpm(true)}
              style={{
                border: '1px solid #2f4258',
                borderRadius: 8,
                background: '#0b1118',
                color: '#e7edf5',
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                fontSize: 28,
                lineHeight: 1,
                padding: '6px 10px',
                cursor: 'pointer'
              }}
            >
              {status.cpm}
            </button>
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
                  width: 90,
                  borderRadius: 8,
                  border: '1px solid #2f4258',
                  background: '#0b1118',
                  color: '#e7edf5',
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                  fontSize: 24,
                  padding: '4px 8px'
                }}
              />
              <button onClick={() => void submitTempo()} style={{ borderRadius: 8, border: 0, padding: '0 10px', background: '#2a9d8f', color: '#06241f', fontWeight: 700 }}>Set</button>
            </div>
          )}

          <span style={{
            borderRadius: 999,
            padding: '6px 12px',
            border: '1px solid #2f4258',
            background: '#0f1621',
            color: vibeBadgeColor,
            boxShadow: `0 0 18px ${vibeBadgeColor}44`,
            transition: 'all 280ms ease'
          }}>
            {status.vibe}
          </span>
        </div>

        <div style={{ fontSize: 12, color: '#8da2b8' }}>
          Model: {status.activeModel} [{status.modelMode}] · Connection: {status.clientState}
        </div>
      </div>

      <label style={{ display: 'grid', gap: 8 }}>
        <span style={{ fontSize: 13, color: '#8da2b8' }}>Volume: {volume}</span>
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={volume}
          onChange={(e) => {
            const next = Number(e.currentTarget.value)
            setVolume(next)
            void onVolume(next / 100)
          }}
        />
      </label>

      <div style={{ border: '1px solid #273445', borderRadius: 10, padding: 10, background: '#0b1118' }}>
        <div style={{ fontSize: 12, color: '#8da2b8', marginBottom: 6 }}>NOW PLAYING</div>
        <pre style={{
          margin: 0,
          maxHeight: '17.5em',
          overflowY: 'auto',
          lineHeight: 1.45,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          background: '#121a24',
          borderRadius: 8,
          padding: 8
        }}>
          {nowPlayingCode || '// waiting for first pattern'}
        </pre>
      </div>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        {([
          ['SYN', status.breakerState.syntax.state],
          ['BRG', status.breakerState.bridge_timeout.state],
          ['MDL', status.breakerState.model_timeout.state]
        ] as const).map(([label, state]) => (
          <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{
              width: 10,
              height: 10,
              borderRadius: '50%',
              background: breakerColor(state),
              display: 'inline-block'
            }} />
            <span style={{ fontSize: 12, color: '#8da2b8' }}>{label}</span>
          </div>
        ))}
      </div>

      {status.lastError ? <div style={{ color: '#ff7b7b', fontSize: 13 }}>{status.lastError}</div> : null}
    </section>
  )
}

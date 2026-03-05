import { useEffect, useMemo, useState } from 'react'
import Chat, { type ChatMessage } from './Chat'
import Controls, { type StatusPayload } from './Controls'

type UIEvent =
  | { type: 'pattern'; code: string; vibe: string; cpm: number; ts: number }
  | { type: 'agent_text'; text: string; ts: number }
  | { type: 'error'; message: string; source: 'linter' | 'strudel' | 'model'; ts: number }
  | {
    type: 'status'
    model: string
    modelMode: string
    vibe: string
    cpm: number
    breakerState: Record<string, string>
    clientConnected: boolean
    clientState: 'none' | 'connecting' | 'connected'
    ts: number
  }

const initialStatus: StatusPayload = {
  activeModel: 'loading',
  model: 'loading',
  modelMode: 'loading',
  mode: 'loading',
  vibe: 'idle',
  cpm: 124,
  currentKey: 'unknown',
  phraseIndex: 0,
  phraseMs: 0,
  playbackActive: false,
  breakerState: {
    syntax: { state: 'closed', failures: 0, successes: 0, openedAtPhrase: null },
    bridge_timeout: { state: 'closed', failures: 0, successes: 0, openedAtPhrase: null },
    model_timeout: { state: 'closed', failures: 0, successes: 0, openedAtPhrase: null }
  },
  queueLength: 0,
  bridgeQueueLength: 0,
  bridgeConnections: 0,
  clientConnected: false,
  clientState: 'none',
  localMode: false,
  volumeMultiplier: 0.8,
  currentPersona: 'The Architect',
  personas: [
    { name: 'The Architect', description: 'Precise and minimal.' },
    { name: 'Liquid Weaver', description: 'Fluid and atmospheric.' }
  ],
  lastError: null
}

async function postJson(path: string, body: unknown): Promise<void> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(text || `Request failed: ${res.status}`)
  }
}

async function fetchStatus(): Promise<StatusPayload> {
  const res = await fetch('/api/status')
  if (!res.ok) throw new Error(`status request failed: ${res.status}`)
  return res.json() as Promise<StatusPayload>
}

async function fetchSnippet(): Promise<string> {
  const res = await fetch('/snippet')
  if (!res.ok) throw new Error('Failed to fetch snippet')
  return res.text()
}

function makeMessage(message: Omit<ChatMessage, 'id'>): ChatMessage {
  return { ...message, id: crypto.randomUUID() }
}

export default function App() {
  const [status, setStatus] = useState<StatusPayload>(initialStatus)
  const [messages, setMessages] = useState<ChatMessage[]>([
    makeMessage({
      type: 'system',
      ts: Date.now(),
      text: '🎧 Heiwa is ready. Connect Strudel to start the set.\nType anything to talk to your DJ.'
    })
  ])
  const [nowPlayingCode, setNowPlayingCode] = useState('')
  const [prevPlayingCode, setPrevPlayingCode] = useState('')
  const [snippetText, setSnippetText] = useState('')
  const [wsConnected, setWsConnected] = useState(false)
  const [viewportWidth, setViewportWidth] = useState(window.innerWidth)

  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    let cancelled = false

    const loadInitial = async () => {
      try {
        const [currentStatus, snippet] = await Promise.all([fetchStatus(), fetchSnippet()])
        if (cancelled) return
        setStatus(currentStatus)
        setSnippetText(snippet)
      } catch (err) {
        if (cancelled) return
        const text = err instanceof Error ? err.message : String(err)
        setMessages((prev) => [...prev, makeMessage({ type: 'error', ts: Date.now(), text })])
      }
    }

    void loadInitial()

    const poll = window.setInterval(() => {
      if (wsConnected) return
      void (async () => {
        try {
          const currentStatus = await fetchStatus()
          if (!cancelled) setStatus(currentStatus)
        } catch {
          // keep websocket path as primary when available
        }
      })()
    }, 2000)

    return () => {
      cancelled = true
      window.clearInterval(poll)
    }
  }, [wsConnected])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA') return
      
      if (e.code === 'Space') {
        e.preventDefault()
        void onControl(status.playbackActive ? 'stop' : 'start')
      } else if (e.code === 'Escape') {
        e.preventDefault()
        void onControl('hush')
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [status.playbackActive, onControl])

  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${protocol}://${window.location.host}/ws`)

    ws.onopen = () => setWsConnected(true)
    ws.onclose = () => setWsConnected(false)
    ws.onerror = () => {
      setMessages((prev) => [...prev, makeMessage({ type: 'system', ts: Date.now(), text: 'UI websocket disconnected.' })])
    }

    ws.onmessage = (evt) => {
      let event: UIEvent
      try {
        event = JSON.parse(evt.data) as UIEvent
      } catch {
        return
      }

      if (event.type === 'pattern') {
        setPrevPlayingCode((prev) => {
          setNowPlayingCode(event.code)
          return nowPlayingCode // wait, state updates are async, so we use functional update to capture the old value
        })
        // actually, let's just do:
        setNowPlayingCode((prev) => {
          if (prev !== event.code) setPrevPlayingCode(prev)
          return event.code
        })
        
        setMessages((prev) => [...prev, makeMessage({ type: 'pattern', ts: event.ts, code: event.code })])
        return
      }

      if (event.type === 'agent_text') {
        setMessages((prev) => [...prev, makeMessage({ type: 'dj', ts: event.ts, text: event.text })])
        return
      }

      if (event.type === 'error') {
        setMessages((prev) => [...prev, makeMessage({ type: 'error', ts: event.ts, text: `${event.source}: ${event.message}` })])
        return
      }

      if (event.type === 'status') {
        setStatus((prev) => ({
          ...prev,
          model: event.model,
          activeModel: event.model,
          modelMode: event.modelMode,
          mode: event.modelMode,
          vibe: event.vibe,
          cpm: event.cpm,
          clientConnected: event.clientConnected,
          clientState: event.clientState,
          breakerState: {
            syntax: { ...prev.breakerState.syntax, state: event.breakerState.syntax ?? prev.breakerState.syntax.state },
            bridge_timeout: { ...prev.breakerState.bridge_timeout, state: event.breakerState.bridge_timeout ?? prev.breakerState.bridge_timeout.state },
            model_timeout: { ...prev.breakerState.model_timeout, state: event.breakerState.model_timeout ?? prev.breakerState.model_timeout.state }
          }
        }))
      }
    }

    return () => ws.close()
  }, [])

  const isMobile = viewportWidth < 980

  const connectionMode = useMemo(() => (status.localMode ? 'embedded engine' : 'external bridge'), [status.localMode])

  async function onSend(text: string): Promise<void> {
    setMessages((prev) => [...prev, makeMessage({ type: 'user', ts: Date.now(), text })])
    await postJson('/api/request', { text, priority: 'P1', source: 'ui' })
  }

  async function onControl(action: 'start' | 'stop' | 'hush'): Promise<void> {
    await postJson('/api/control', { action })
  }

  async function onVolume(value: number): Promise<void> {
    await postJson('/api/control/volume', { value })
  }

  async function onTempoRequest(cpm: number): Promise<void> {
    await postJson('/api/request', { text: `set tempo to ${cpm} CPM`, priority: 'P1', source: 'ui' })
    setMessages((prev) => [...prev, makeMessage({ type: 'system', ts: Date.now(), text: `Tempo request queued: ${cpm} CPM` })])
  }

  async function onPersonaChange(name: string): Promise<void> {
    await postJson('/api/control/persona', { name })
    setMessages((prev) => [...prev, makeMessage({ type: 'system', ts: Date.now(), text: `Persona shifted to: ${name}` })])
  }

  function onOpenStrudel(): void {
    document.getElementById('engine-panel')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }

  async function onCopySnippet(): Promise<void> {
    const text = snippetText || await fetchSnippet()
    setSnippetText(text)
    await navigator.clipboard.writeText(text)
    setMessages((prev) => [...prev, makeMessage({ type: 'system', ts: Date.now(), text: 'Connection snippet copied to clipboard.' })])
  }

  return (
    <main style={{
      minHeight: '100vh',
      background: 'radial-gradient(circle at 0% 0%, #16253d 0%, #05080c 50%), linear-gradient(135deg, #05080c 0%, #0c1118 100%)',
      color: '#e7edf5',
      padding: isMobile ? 12 : 24,
      boxSizing: 'border-box',
      fontFamily: '"Inter", "SF Pro Display", sans-serif'
    }}>
      <div style={{ maxWidth: 1440, margin: '0 auto', display: 'grid', gap: 20 }}>
        <header style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 12,
          padding: '0 8px'
        }}>
          <div>
            <h1 style={{
              margin: 0,
              fontSize: 32,
              fontWeight: 800,
              letterSpacing: '-0.02em',
              background: 'linear-gradient(to right, #fff, #94abc7)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent'
            }}>
              🎧 HEIWA DJ
            </h1>
            <div style={{ color: '#94abc7', fontSize: 14, fontWeight: 500, marginTop: 4 }}>
              Standalone Local AI DJ • v1.7.0
            </div>
          </div>
          <div style={{
            borderRadius: 12,
            border: '1px solid rgba(255, 255, 255, 0.1)',
            padding: '8px 16px',
            fontSize: 13,
            fontWeight: 600,
            color: '#d6dee8',
            background: 'rgba(15, 22, 33, 0.6)',
            backdropFilter: 'blur(10px)',
            boxShadow: '0 4px 12px rgba(0, 0, 0, 0.2)'
          }}>
            <span style={{ color: wsConnected ? '#3ddc97' : '#ff5c7a', marginRight: 8 }}>●</span>
            {wsConnected ? 'UI WS Connected' : 'UI WS Disconnected'}
            <span style={{ margin: '0 12px', opacity: 0.3 }}>|</span>
            <span style={{ color: '#5cc6ff' }}>{connectionMode}</span>
          </div>
        </header>

        <div style={{
          display: 'grid',
          gap: 20,
          gridTemplateColumns: isMobile ? '1fr' : 'minmax(400px, 1fr) minmax(400px, 1fr) minmax(400px, 1fr)',
          height: isMobile ? 'auto' : 'calc(100vh - 160px)'
        }}>
          <div style={{
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            borderRadius: 20,
            overflow: 'hidden',
            border: '1px solid rgba(255, 255, 255, 0.08)',
            background: 'rgba(9, 14, 23, 0.4)',
            backdropFilter: 'blur(20px)',
            boxShadow: '0 8px 32px rgba(0, 0, 0, 0.3)'
          }}>
            <Chat messages={messages} onSend={onSend} />
          </div>

          <div style={{
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            borderRadius: 20,
            overflow: 'hidden',
            border: '1px solid rgba(255, 255, 255, 0.08)',
            background: 'rgba(9, 14, 23, 0.4)',
            backdropFilter: 'blur(20px)',
            boxShadow: '0 8px 32px rgba(0, 0, 0, 0.3)'
          }}>
            <Controls
              status={status}
              nowPlayingCode={nowPlayingCode}
              prevPlayingCode={prevPlayingCode}
              snippetText={snippetText}
              onControl={onControl}
              onVolume={onVolume}
              onTempoRequest={onTempoRequest}
              onPersonaChange={onPersonaChange}
              onOpenStrudel={onOpenStrudel}
              onCopySnippet={onCopySnippet}
            />
          </div>

          <div
            id="engine-panel"
            style={{
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            borderRadius: 20,
            overflow: 'hidden',
            border: '1px solid rgba(255, 255, 255, 0.08)',
            background: 'rgba(9, 14, 23, 0.4)',
            backdropFilter: 'blur(20px)',
            boxShadow: '0 8px 32px rgba(0, 0, 0, 0.3)'
          }}>
            <div style={{ display: 'grid', gap: 18, padding: 24, height: '100%', boxSizing: 'border-box' }}>
              <div>
                <div style={{ fontSize: 10, fontWeight: 700, color: '#667c94', letterSpacing: '0.08em', marginBottom: 8 }}>EMBEDDED ENGINE</div>
                <div style={{ fontSize: 28, fontWeight: 800, letterSpacing: '-0.02em', color: '#f0f6ff' }}>
                  Local Strudel Runtime
                </div>
                <div style={{ marginTop: 8, color: '#8fa7c4', fontSize: 14, lineHeight: 1.6 }}>
                  Heiwa DJ renders and performs inside the app. The hidden Electron audio window is the only engine client; this panel mirrors its state without spawning a second runtime.
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12 }}>
                {[
                  ['Connection', status.clientState],
                  ['Phrase', String(status.phraseIndex)],
                  ['Phrase MS', String(Math.round(status.phraseMs))],
                  ['Tempo', `${status.cpm} CPM`],
                  ['Persona', status.currentPersona],
                  ['Playback', status.playbackActive ? 'active' : 'stopped']
                ].map(([label, value]) => (
                  <div key={label} style={{ borderRadius: 14, padding: 14, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)' }}>
                    <div style={{ fontSize: 10, fontWeight: 700, color: '#667c94', letterSpacing: '0.06em', marginBottom: 6 }}>{label.toUpperCase()}</div>
                    <div style={{ fontSize: 18, fontWeight: 700, color: '#e7edf5' }}>{value}</div>
                  </div>
                ))}
              </div>

              <div style={{ borderRadius: 16, padding: 18, background: 'linear-gradient(135deg, rgba(92,198,255,0.12), rgba(255,255,255,0.02))', border: '1px solid rgba(92,198,255,0.18)' }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#5cc6ff', letterSpacing: '0.08em', marginBottom: 10 }}>LOCAL RENDER CONTRACT</div>
                <div style={{ color: '#d8e6f7', fontSize: 13, lineHeight: 1.7 }}>
                  Vibes become Strudel patterns on-device through Ollama, pass the AST/lint gate, then schedule phrase-accurate updates over the internal bridge. No browser tab, cloud synth, or external code runner is required.
                </div>
              </div>

              <pre style={{
                margin: 0,
                flex: 1,
                minHeight: 180,
                borderRadius: 16,
                padding: 18,
                background: 'rgba(0, 0, 0, 0.32)',
                border: '1px solid rgba(255,255,255,0.06)',
                overflow: 'auto',
                color: '#91b4d8',
                fontSize: 12,
                lineHeight: 1.65,
                fontFamily: '"Fira Code", "JetBrains Mono", ui-monospace, monospace'
              }}>
{JSON.stringify({
  engineRoute: `http://${window.location.hostname}:4321/engine`,
  embeddedClientState: status.clientState,
  bridgeConnections: status.bridgeConnections,
  playbackActive: status.playbackActive,
  nowPlayingVibe: status.vibe,
  activeModel: status.activeModel
}, null, 2)}
              </pre>
            </div>
          </div>
        </div>
      </div>
    </main>
  )
}

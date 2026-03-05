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
        setNowPlayingCode(event.code)
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

  const connectionMode = useMemo(() => (status.localMode ? 'localhost' : 'strudel.cc'), [status.localMode])

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

  function onOpenStrudel(): void {
    window.open('https://strudel.cc', '_blank', 'noopener,noreferrer')
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
      background: 'radial-gradient(1400px 760px at 8% -10%, #1f4b6b 0%, #0a0f16 42%, #070b11 100%)',
      color: '#e7edf5',
      padding: 16,
      boxSizing: 'border-box'
    }}>
      <div style={{ maxWidth: 1320, margin: '0 auto', display: 'grid', gap: 14 }}>
        <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 30 }}>🎧 HEIWA DJ</h1>
            <div style={{ color: '#8da2b8', fontSize: 13 }}>Realtime Strudel AI performer</div>
          </div>
          <div style={{
            borderRadius: 999,
            border: '1px solid #2f4258',
            padding: '6px 10px',
            fontSize: 12,
            color: '#d6dee8',
            background: '#0f1621'
          }}>
            {wsConnected ? 'UI WS connected' : 'UI WS disconnected'} · {connectionMode}
          </div>
        </header>

        <div style={{
          display: 'grid',
          gap: 14,
          gridTemplateColumns: isMobile ? '1fr' : '1.3fr 1fr',
          minHeight: isMobile ? 'auto' : 'calc(100vh - 146px)'
        }}>
          <div style={{ minHeight: 0 }}>
            <Chat messages={messages} onSend={onSend} />
          </div>

          <div style={{ minHeight: 0 }}>
            <Controls
              status={status}
              nowPlayingCode={nowPlayingCode}
              snippetText={snippetText}
              onControl={onControl}
              onVolume={onVolume}
              onTempoRequest={onTempoRequest}
              onOpenStrudel={onOpenStrudel}
              onCopySnippet={onCopySnippet}
            />
          </div>
        </div>
      </div>
    </main>
  )
}

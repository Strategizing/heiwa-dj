import path from 'node:path'
import http from 'node:http'
import fs from 'node:fs'
import express from 'express'
import cors from 'cors'
import { WebSocketServer, type WebSocket } from 'ws'
import { CircuitBreaker } from './breaker.js'
import { DJBridge } from './bridge.js'
import { enqueueRequest, makeRequest, pushChat, updateTempoDerivedFields, type DJState, type Priority } from './state.js'
import { DJSpacetimeClient } from './spacetime.js'
import { processLocalIntelligence } from './intelligence.js'

export type UIEvent =
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

interface APIOptions {
  state: DJState
  bridge: DJBridge
  breaker: CircuitBreaker
  uiEmitter: { on: (event: 'ui', listener: (payload: UIEvent) => void) => void; off: (event: 'ui', listener: (payload: UIEvent) => void) => void }
  apiPort: number
  queueMax: number
  sampleDir: string
  uiDistDir?: string | null
}

export interface APIRuntime {
  close: () => Promise<void>
  broadcast: () => void
}

function serializeBreakerState(breaker: CircuitBreaker): Record<string, string> {
  const state = breaker.getState()
  return {
    syntax: state.syntax.state,
    bridge_timeout: state.bridge_timeout.state,
    model_timeout: state.model_timeout.state
  }
}

function buildStatus(state: DJState, bridge: DJBridge, breaker: CircuitBreaker) {
  return {
    activeModel: state.activeModel,
    model: state.activeModel,
    modelMode: state.mode,
    mode: state.mode,
    vibe: state.currentVibe,
    cpm: state.currentCPM,
    currentPersona: state.currentPersona,
    personas: [
      { name: 'The Architect', description: 'Precise and minimal.' },
      { name: 'Liquid Weaver', description: 'Fluid and atmospheric.' }
    ],
    currentKey: state.currentKey,
    phraseIndex: state.currentPhraseIndex,
    phraseMs: state.phraseMs,
    playbackActive: state.playbackActive,
    breakerState: breaker.getState(),
    queueLength: state.requestQueue.length,
    bridgeQueueLength: bridge.getQueueLength(),
    bridgeConnections: bridge.getConnectionCount(),
    clientConnected: bridge.isClientConnected(),
    clientState: bridge.getClientConnectionState(),
    localMode: state.localMode,
    volumeMultiplier: state.volumeMultiplier,
    lastError: state.lastError
  }
}

function buildStatusEvent(state: DJState, bridge: DJBridge, breaker: CircuitBreaker): UIEvent {
  return {
    type: 'status',
    model: state.activeModel,
    modelMode: state.mode,
    vibe: state.currentVibe,
    cpm: state.currentCPM,
    breakerState: serializeBreakerState(breaker),
    clientConnected: bridge.isClientConnected(),
    clientState: bridge.getClientConnectionState(),
    ts: Date.now()
  }
}

function snippet(bridgePort: number): string {
  return `if (!window.heiwaSocketInitialized) {
  window.heiwaSocketInitialized = true;
  const socket = new WebSocket('ws://localhost:${bridgePort}');
  socket.onopen = () => {
    console.log('[Heiwa] connected');
    socket.send(JSON.stringify({ type: 'connected' }));
  };
  socket.onclose = () => console.log('[Heiwa] disconnected');
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    try {
      if (message.type === 'update') {
        strudelMirror.setCode(message.data);
        strudelMirror.evaluate();
        socket.send(JSON.stringify({ type: 'ack', messageId: message.messageId, executedPhraseIndex: message.targetPhraseIndex }));
      }
      if (message.type === 'stop') {
        strudelMirror.stop();
        socket.send(JSON.stringify({ type: 'ack', messageId: message.messageId, executedPhraseIndex: message.targetPhraseIndex }));
      }
    } catch (err) {
      socket.send(JSON.stringify({ type: 'error', messageId: message.messageId, message: String(err) }));
    }
  };
}`
}

export function startAPI(opts: APIOptions): APIRuntime {
  const app = express()
  app.use(cors())
  app.use(express.json({ limit: '1mb' }))
  const shouldServeBuiltUi = Boolean(
    opts.uiDistDir &&
    fs.existsSync(path.resolve(opts.uiDistDir, 'index.html'))
  )
  const builtUiDir = shouldServeBuiltUi ? path.resolve(opts.uiDistDir as string) : null

  const sampleAbs = path.resolve(opts.sampleDir)
  app.use('/samples', express.static(sampleAbs))
  if (builtUiDir) {
    app.use(express.static(builtUiDir))
  }

  app.get('/api/debug', (_req, res) => {
    res.json({
      timestamp: Date.now(),
      status: buildStatus(opts.state, opts.bridge, opts.breaker),
      stateDump: {
        sessionId: opts.state.sessionId,
        chatLog: opts.state.chatLog,
        patternHistory: opts.state.patternHistory,
        requestQueue: opts.state.requestQueue,
        allowedSamples: opts.state.allowedSamples,
        lastError: opts.state.lastError
      },
      bridge: {
        connections: opts.bridge.getConnectionCount(),
        queueLength: opts.bridge.getQueueLength(),
        clientState: opts.bridge.getClientConnectionState()
      }
    })
  })

  app.get('/api/status', (_req, res) => {
    res.json(buildStatus(opts.state, opts.bridge, opts.breaker))
  })

  app.get('/api/history', (_req, res) => {
    res.json({
      patterns: opts.state.patternHistory.slice(-20),
      chat: opts.state.chatLog.slice(-100)
    })
  })

  app.get('/api/share', (_req, res) => {
    const shareData = {
      version: '1.0',
      timestamp: Date.now(),
      vibe: opts.state.currentVibe,
      persona: opts.state.currentPersona,
      cpm: opts.state.currentCPM,
      key: opts.state.currentKey,
      topPatterns: opts.state.patternHistory.slice(-5).map(h => ({ code: h.code, vibe: h.vibe })),
      summary: `A ${opts.state.currentVibe} set at ${opts.state.currentCPM} BPM, guided by ${opts.state.currentPersona}.`
    }
    res.json(shareData)
  })

  app.get('/snippet', (_req, res) => {
    res.type('text/plain').send(snippet(opts.bridge.getBridgePort()))
  })

  app.post('/api/request', async (req, res) => {
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : ''
    const priority = (req.body?.priority ?? 'P1') as Priority
    const source = (req.body?.source ?? 'ui') as 'ui' | 'stdin' | 'openclaw'

    if (!text) {
      res.status(400).json({ ok: false, error: 'text is required' })
      return
    }

    if (!['P0', 'P1', 'P2'].includes(priority)) {
      res.status(400).json({ ok: false, error: 'priority must be P0|P1|P2' })
      return
    }

    // Fast-track simple musical commands natively
    const local = processLocalIntelligence(opts.state, text)
    if (local.handled) {
      if (local.message) pushChat(opts.state, { role: 'system', text: local.message })

      if (local.action === 'gain' && local.value !== undefined) {
        opts.state.volumeMultiplier = local.value
        await opts.bridge.queueCommand({
          sessionId: opts.state.sessionId,
          cmd: 'gain',
          data: String(local.value),
          immediate: true,
          priority: 'P0'
        })
      } else if (local.action === 'cpm' && local.value !== undefined) {
        updateTempoDerivedFields(opts.state, local.value)
        await opts.bridge.queueCommand({
          sessionId: opts.state.sessionId,
          cmd: 'cpm',
          data: String(local.value),
          immediate: true,
          priority: 'P0'
        })
      } else if (local.action === 'hush') {
        await opts.bridge.queueCommand({ sessionId: opts.state.sessionId, cmd: 'stop', immediate: true, priority: 'P0' })
        opts.state.playbackActive = false
      }

      opts.state.lastError = null
      sendStatus()
      return res.json({ ok: true, local: true, request: makeRequest({ text, priority, source }) })
    }

    const request = makeRequest({ text, priority, source })
    enqueueRequest(opts.state, request, opts.queueMax)
    pushChat(opts.state, { role: 'user', text })

    res.json({ ok: true, request })
  })

  app.post('/api/control', async (req, res) => {
    const action = req.body?.action as 'start' | 'stop' | 'hush'

    if (!action || !['start', 'stop', 'hush'].includes(action)) {
      res.status(400).json({ ok: false, error: 'action must be start|stop|hush' })
      return
    }

    if (action === 'start') {
      opts.state.playbackActive = true
      opts.state.lastError = null
      pushChat(opts.state, { role: 'system', text: 'Playback started.' })
      res.json({ ok: true })
      return
    }

    if (action === 'stop') {
      opts.state.playbackActive = false
      const result = await opts.bridge.queueCommand({
        sessionId: opts.state.sessionId,
        cmd: 'stop',
        priority: 'P0',
        immediate: true
      })
      if (!result.success) {
        opts.state.lastError = result.error ?? 'stop failed'
        sendEvent({ type: 'error', message: opts.state.lastError, source: 'strudel', ts: Date.now() })
        return res.json({ ok: false, error: opts.state.lastError })
      }
      opts.state.lastError = null
      pushChat(opts.state, { role: 'system', text: 'Playback stopped.' })
      res.json({ ok: true })
      return
    }

    opts.state.playbackActive = false
    const result = await opts.bridge.queueCommand({
      sessionId: opts.state.sessionId,
      cmd: 'stop',
      priority: 'P0',
      immediate: true
    })
    if (!result.success) {
      opts.state.lastError = result.error ?? 'stop failed'
      sendEvent({ type: 'error', message: opts.state.lastError, source: 'strudel', ts: Date.now() })
      return res.json({ ok: false, error: opts.state.lastError })
    }
    opts.state.lastError = null
    pushChat(opts.state, { role: 'system', text: 'Hush command sent.' })
    res.json({ ok: true })
  })

  app.post('/api/control/volume', async (req, res) => {
    const value = Number(req.body?.value)
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      res.status(400).json({ ok: false, error: 'value must be between 0 and 1' })
      return
    }

    opts.state.volumeMultiplier = value

    if (opts.bridge.isClientConnected()) {
      const result = await opts.bridge.queueCommand({
        sessionId: opts.state.sessionId,
        cmd: 'gain',
        data: String(value),
        priority: 'P0',
        immediate: true
      })
      if (!result.success) {
        opts.state.lastError = result.error ?? 'volume change failed'
        sendEvent({ type: 'error', message: opts.state.lastError, source: 'strudel', ts: Date.now() })
        return res.json({ ok: false, error: opts.state.lastError })
      }
      opts.state.lastError = null
    }

    sendStatus()
    res.json({ ok: true, value })
  })

  app.post('/api/control/persona', async (req, res) => {
    const name = req.body?.name as string
    if (!name) {
      res.status(400).json({ ok: false, error: 'name is required' })
      return
    }

    opts.state.currentPersona = name
    try {
      DJSpacetimeClient.getInstance().setPersona(name)
    } catch {
      // ignore
    }

    sendStatus()
    res.json({ ok: true, name })
  })

  app.get('/', (_req, res) => {
    if (builtUiDir) {
      res.sendFile(path.resolve(builtUiDir, 'index.html'))
      return
    }

    res.type('html').send(`<!doctype html>
<html>
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Heiwa DJ API</title>
    <style>
      body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif; background: #0b1118; color: #e7edf5; margin: 0; padding: 24px; }
      .card { max-width: 760px; margin: 0 auto; border: 1px solid #273445; border-radius: 12px; padding: 18px; background: #101824; }
      a { color: #8ecae6; }
      code { background: #16202d; border-radius: 6px; padding: 2px 6px; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>Heiwa DJ</h1>
      <p>API is running on <code>:${opts.apiPort}</code>.</p>
      <p>UI dev server is expected on <a href="http://localhost:5173">http://localhost:5173</a>.</p>
      <p>Connection snippet: <a href="/snippet">/snippet</a></p>
      <p>Status endpoint: <a href="/api/status">/api/status</a></p>
    </div>
  </body>
</html>`)
  })

  const server = http.createServer(app)
  const wsClients = new Set<WebSocket>()
  const uiWss = new WebSocketServer({ noServer: true })

  const sendEvent = (event: UIEvent) => {
    const payload = JSON.stringify(event)
    for (const ws of wsClients) {
      if (ws.readyState === ws.OPEN) ws.send(payload)
    }
  }

  const sendStatus = () => {
    sendEvent(buildStatusEvent(opts.state, opts.bridge, opts.breaker))
  }

  server.on('upgrade', (req, socket, head) => {
    if (!req.url?.startsWith('/ws')) return socket.destroy()

    uiWss.handleUpgrade(req, socket, head, (ws) => {
      uiWss.emit('connection', ws, req)
    })
  })

  uiWss.on('connection', (ws) => {
    wsClients.add(ws)
    ws.on('close', () => wsClients.delete(ws))
    sendStatus()
  })

  let expectedStatusFire = Date.now() + 5000
  let statusTimer: NodeJS.Timeout
  const statusTick = () => {
    sendStatus()
    const drift = Date.now() - expectedStatusFire
    expectedStatusFire += 5000
    statusTimer = setTimeout(statusTick, Math.max(0, 5000 - drift))
  }
  statusTimer = setTimeout(statusTick, 5000)

  const uiListener = (event: UIEvent) => {
    sendEvent(event)
  }
  opts.uiEmitter.on('ui', uiListener)

  const onPhrase = () => sendStatus()
  const onConnection = () => sendStatus()
  const onConnectionState = () => sendStatus()
  const onWarning = (msg: string) => {
    opts.state.lastError = msg
    sendEvent({ type: 'error', message: msg, source: 'strudel', ts: Date.now() })
    sendStatus()
  }

  opts.bridge.on('phrase', onPhrase)
  opts.bridge.on('connection', onConnection)
  opts.bridge.on('connection_state', onConnectionState)
  opts.bridge.on('warning', onWarning)

  server.listen(opts.apiPort, '127.0.0.1')

  return {
    broadcast: sendStatus,
    close: async () => {
      clearTimeout(statusTimer)
      opts.uiEmitter.off('ui', uiListener)
      opts.bridge.off('phrase', onPhrase)
      opts.bridge.off('connection', onConnection)
      opts.bridge.off('connection_state', onConnectionState)
      opts.bridge.off('warning', onWarning)
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
      })
    }
  }
}

import { EventEmitter } from 'node:events'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import express from 'express'
import { WebSocketServer, type WebSocket } from 'ws'

export type BridgePriority = 'P0' | 'P1' | 'P2'

export interface BridgeCommand {
  id: string
  sessionId: string
  cmd: 'update' | 'stop'
  code?: string
  targetPhraseIndex: number
  priority: BridgePriority
  retries: number
  enqueuedAt: number
}

export interface BridgeCommandResult {
  success: boolean
  commandId: string
  executedPhraseIndex: number
  error?: string
}

interface PendingAck {
  resolve: (value: BridgeCommandResult) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

interface BridgeOptions {
  bridgePort: number
  localStrudelPort: number
  apiPort: number
  localMode: boolean
  embeddedEngine: boolean
  sessionId: string
  phraseLength: number
  initialCpm: number
}

function priorityWeight(priority: BridgePriority): number {
  if (priority === 'P0') return 0
  if (priority === 'P1') return 1
  return 2
}

export class DJBridge extends EventEmitter {
  private readonly opts: BridgeOptions
  private readonly wss: WebSocketServer
  private readonly browserClients = new Set<WebSocket>()
  private readonly queue = new Map<number, BridgeCommand[]>()
  private readonly pendingAcks = new Map<string, PendingAck>()

  private localServer: http.Server | null = null
  private phraseTimer: NodeJS.Timeout | null = null
  private heartbeatTimer: NodeJS.Timeout | null = null

  private expectedFireTime = 0
  private phraseMs: number
  private currentPhraseIndex = 0
  private dispatchChain: Promise<void> = Promise.resolve()
  private clientConnected = false
  private clientConnecting = false

  constructor(opts: BridgeOptions) {
    super()
    this.setMaxListeners(50)
    this.opts = opts
    this.phraseMs = (60000 / opts.initialCpm) * 4 * opts.phraseLength
    this.wss = new WebSocketServer({ port: opts.bridgePort })
  }

  start(): void {
    this.wss.on('connection', (ws) => {
      this.browserClients.add(ws)
      this.clientConnecting = true
      this.emit('connection', this.browserClients.size)
      this.emit('connection_state', this.getClientConnectionState())

      ws.on('message', (raw) => {
        this.handleClientMessage(ws, raw.toString('utf8'))
      })

      ws.on('close', () => {
        this.browserClients.delete(ws)
        if (this.browserClients.size === 0) {
          this.clientConnected = false
          this.clientConnecting = false
        }
        this.emit('connection', this.browserClients.size)
        this.emit('connection_state', this.getClientConnectionState())
      })
    })

    this.expectedFireTime = Date.now() + this.phraseMs
    this.schedulePhraseTick(this.phraseMs)
    let expectedHeartbeatFire = Date.now() + 5000
    const heartbeatTick = () => {
      this.broadcast({ event: 'heartbeat', ts: Date.now(), currentPhraseIndex: this.currentPhraseIndex })
      const drift = Date.now() - expectedHeartbeatFire
      expectedHeartbeatFire += 5000
      this.heartbeatTimer = setTimeout(heartbeatTick, Math.max(0, 5000 - drift))
    }
    this.heartbeatTimer = setTimeout(heartbeatTick, 5000)

    if (this.opts.localMode) {
      this.startLocalReplServer()
    }
  }

  stop(): void {
    if (this.phraseTimer) clearTimeout(this.phraseTimer)
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer)
    this.wss.close()

    for (const pending of this.pendingAcks.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Bridge shutting down'))
    }
    this.pendingAcks.clear()

    if (this.localServer) {
      this.localServer.close()
      this.localServer = null
    }
  }

  getPhraseIndex(): number {
    return this.currentPhraseIndex
  }

  getPhraseMs(): number {
    return this.phraseMs
  }

  setTempo(cpm: number, phraseLength: number): void {
    this.phraseMs = (60000 / cpm) * 4 * phraseLength
    this.expectedFireTime = Date.now() + this.phraseMs
    this.emit('tempo', { cpm, phraseMs: this.phraseMs })
  }

  getQueueLength(): number {
    let total = 0
    for (const bucket of this.queue.values()) total += bucket.length
    return total
  }

  getConnectionCount(): number {
    return this.browserClients.size
  }

  getBridgePort(): number {
    return this.opts.bridgePort
  }

  isClientConnected(): boolean {
    return this.clientConnected
  }

  getClientConnectionState(): 'none' | 'connecting' | 'connected' {
    if (this.clientConnected) return 'connected'
    if (this.clientConnecting || this.browserClients.size > 0) return 'connecting'
    return 'none'
  }

  waitForNextPhrase(lastSeenPhrase: number): Promise<number> {
    if (this.currentPhraseIndex > lastSeenPhrase) {
      return Promise.resolve(this.currentPhraseIndex)
    }

    return new Promise((resolve) => {
      const onPhrase = (phrase: number) => {
        if (phrase > lastSeenPhrase) {
          this.off('phrase', onPhrase)
          resolve(phrase)
        }
      }
      this.on('phrase', onPhrase)
    })
  }

  async queueCommand(input: {
    sessionId: string
    cmd: 'update' | 'stop'
    code?: string
    priority?: BridgePriority
    targetPhraseIndex?: number
    immediate?: boolean
  }): Promise<BridgeCommandResult> {
    const priority = input.priority ?? 'P2'

    const targetPhraseIndex = input.immediate
      ? this.currentPhraseIndex
      : (input.targetPhraseIndex ?? (this.currentPhraseIndex + 1))

    if (targetPhraseIndex < this.currentPhraseIndex || (!input.immediate && targetPhraseIndex <= this.currentPhraseIndex)) {
      return {
        success: false,
        commandId: crypto.randomUUID(),
        executedPhraseIndex: this.currentPhraseIndex,
        error: `stale command rejected (target=${targetPhraseIndex}, current=${this.currentPhraseIndex})`
      }
    }

    const cmd: BridgeCommand = {
      id: crypto.randomUUID(),
      sessionId: input.sessionId,
      cmd: input.cmd,
      code: input.code,
      targetPhraseIndex,
      priority,
      retries: 0,
      enqueuedAt: Date.now()
    }

    if (input.immediate || priority === 'P0') {
      return this.dispatchWithRetry(cmd)
    }

    return new Promise((resolve) => {
      const bucket = this.queue.get(targetPhraseIndex) ?? []
      bucket.push(cmd)
      this.queue.set(targetPhraseIndex, bucket)

      const onDone = (result: BridgeCommandResult) => {
        if (result.commandId === cmd.id) {
          this.off('command_result', onDone)
          resolve(result)
        }
      }
      this.on('command_result', onDone)
    })
  }

  private schedulePhraseTick(delayMs: number): void {
    this.phraseTimer = setTimeout(() => {
      void this.phraseTick()
    }, delayMs)
  }

  private async phraseTick(): Promise<void> {
    const now = Date.now()
    const drift = now - this.expectedFireTime

    this.currentPhraseIndex += 1
    this.emit('phrase', this.currentPhraseIndex)

    const cmds = (this.queue.get(this.currentPhraseIndex) ?? [])
      .sort((a, b) => priorityWeight(a.priority) - priorityWeight(b.priority))
    this.queue.delete(this.currentPhraseIndex)

    for (const cmd of cmds) {
      await this.enqueueDispatch(async () => {
        const result = await this.dispatchWithRetry(cmd)
        this.emit('command_result', result)
      })
    }

    this.expectedFireTime += this.phraseMs
    this.schedulePhraseTick(Math.max(0, this.phraseMs - drift))
  }

  private async enqueueDispatch(task: () => Promise<void>): Promise<void> {
    this.dispatchChain = this.dispatchChain.then(task).catch((err) => {
      this.emit('warning', `dispatch error: ${err instanceof Error ? err.message : String(err)}`)
    })
    return this.dispatchChain
  }

  private async dispatchWithRetry(cmd: BridgeCommand): Promise<BridgeCommandResult> {
    try {
      return await this.dispatchCommand(cmd)
    } catch (err) {
      if (cmd.retries < 1) {
        cmd.retries += 1
        this.emit('warning', `retrying command ${cmd.id}: ${err instanceof Error ? err.message : String(err)}`)
        try {
          return await this.dispatchCommand(cmd)
        } catch (retryErr) {
          err = retryErr
        }
      }

      const message = err instanceof Error ? err.message : String(err)
      return {
        success: false,
        commandId: cmd.id,
        executedPhraseIndex: this.currentPhraseIndex,
        error: message
      }
    }
  }

  private async dispatchCommand(cmd: BridgeCommand): Promise<BridgeCommandResult> {
    if (this.browserClients.size === 0) {
      throw new Error('No Strudel client connected. Open strudel.cc or run pnpm dev:local')
    }

    const payload = {
      type: cmd.cmd,
      data: cmd.code,
      messageId: cmd.id,
      sessionId: cmd.sessionId,
      targetPhraseIndex: cmd.targetPhraseIndex
    }

    const waitForAck = new Promise<BridgeCommandResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingAcks.delete(cmd.id)
        reject(new Error(`bridge ack timeout for ${cmd.id}`))
      }, 2500)

      this.pendingAcks.set(cmd.id, { resolve, reject, timer })
    })

    for (const client of this.browserClients) {
      if (client.readyState === client.OPEN) {
        client.send(JSON.stringify(payload))
      }
    }

    return waitForAck
  }

  private handleClientMessage(_ws: WebSocket, raw: string): void {
    let message: Record<string, unknown>
    try {
      message = JSON.parse(raw) as Record<string, unknown>
    } catch {
      this.emit('warning', 'received non-JSON message from client')
      return
    }

    const messageId = typeof message.messageId === 'string'
      ? message.messageId
      : (typeof message.id === 'string' ? message.id : null)

    if (messageId && this.pendingAcks.has(messageId)) {
      const pending = this.pendingAcks.get(messageId)
      if (!pending) return

      this.clientConnected = true
      this.clientConnecting = false
      this.emit('connection_state', this.getClientConnectionState())

      clearTimeout(pending.timer)
      this.pendingAcks.delete(messageId)

      const isError = message.type === 'error' || message.event === 'error'
      const phrase = typeof message.executedPhraseIndex === 'number'
        ? message.executedPhraseIndex
        : this.currentPhraseIndex

      if (isError) {
        const errText = typeof message.message === 'string' ? message.message : 'bridge reported error'
        pending.reject(new Error(errText))
      } else {
        pending.resolve({
          success: true,
          commandId: messageId,
          executedPhraseIndex: phrase
        })
      }
      return
    }

    if (message.event === 'ready' || message.type === 'connected') {
      this.clientConnected = true
      this.clientConnecting = false
      this.emit('ready')
      this.emit('connection_state', this.getClientConnectionState())
    }
  }

  private broadcast(payload: unknown): void {
    const wire = JSON.stringify(payload)
    for (const client of this.browserClients) {
      if (client.readyState === client.OPEN) client.send(wire)
    }
  }

  private startLocalReplServer(): void {
    const app = express()
    const replDistCandidates = [
      path.resolve(process.cwd(), 'node_modules', '@strudel', 'repl', 'dist'),
      path.resolve(process.cwd(), '..', 'node_modules', '@strudel', 'repl', 'dist'),
      path.resolve(process.cwd(), '..', '..', 'node_modules', '@strudel', 'repl', 'dist'),
      path.resolve(process.cwd(), 'packages', 'server', 'node_modules', '@strudel', 'repl', 'dist')
    ]
    const replDistDir = replDistCandidates.find((candidate) => fs.existsSync(path.resolve(candidate, 'index.js')))

    if (replDistDir) {
      app.use('/vendor/strudel-repl', express.static(replDistDir))
    }

    const helperHtml = `<!doctype html>
<html>
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Heiwa DJ Local Helper</title>
    <style>
      body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif; margin: 0; background: #0c1118; color: #e7edf5; }
      .wrap { max-width: 900px; margin: 0 auto; padding: 20px; display: grid; gap: 14px; }
      .card { border: 1px solid #2d3f56; border-radius: 12px; padding: 14px; background: #111a24; }
      .row { display: flex; gap: 8px; flex-wrap: wrap; }
      button { border: 0; border-radius: 8px; padding: 10px 14px; cursor: pointer; font-weight: 700; }
      #openStrudel { background: #3a86ff; color: #fff; }
      #copySnippet { background: #2a9d8f; color: #06241f; }
      #status { color: #a5b8ce; font-weight: 600; }
      pre { margin: 0; white-space: pre-wrap; word-break: break-word; background: #0a1118; border: 1px solid #243548; border-radius: 10px; padding: 12px; min-height: 180px; }
    </style>
  </head>
  <body>
    <div class="wrap">
      <h1>Heiwa DJ Local Connection Helper</h1>
      <div class="card">
        <p><strong>Native engine mode is available.</strong> You can run Strudel fully local in this app.</p>
        <div class="row">
          <a href="/engine">Open local engine</a>
        </div>
      </div>
      <div class="card">
        <p>1. Open <strong>strudel.cc</strong></p>
        <p>2. Paste the snippet below into the browser console once</p>
        <p>3. Keep strudel.cc open while Heiwa DJ performs</p>
        <div class="row">
          <button id="openStrudel">Open strudel.cc</button>
          <button id="copySnippet">Copy snippet</button>
        </div>
      </div>
      <div class="card">
        <div id="status">Checking Strudel connection…</div>
      </div>
      <div class="card">
        <pre id="snippet">Loading snippet…</pre>
      </div>
    </div>
    <script>
      const apiBase = 'http://localhost:${this.opts.apiPort}'
      const status = document.getElementById('status')
      const snippet = document.getElementById('snippet')
      const openButton = document.getElementById('openStrudel')
      const copyButton = document.getElementById('copySnippet')

      function openStrudel() {
        window.open('https://strudel.cc', '_blank')
      }

      async function loadSnippet() {
        try {
          const res = await fetch(apiBase + '/snippet')
          if (!res.ok) throw new Error('snippet request failed')
          const text = await res.text()
          snippet.textContent = text
          return text
        } catch (err) {
          snippet.textContent = 'Failed to load snippet: ' + String(err)
          return null
        }
      }

      async function copySnippet() {
        try {
          const text = snippet.textContent && !snippet.textContent.startsWith('Failed')
            ? snippet.textContent
            : await loadSnippet()
          if (text) {
            await navigator.clipboard.writeText(text)
            status.textContent = 'Snippet copied. Paste into strudel.cc console.'
          }
        } catch (err) {
          status.textContent = 'Copy failed: ' + String(err)
        }
      }

      async function pollStatus() {
        try {
          const res = await fetch(apiBase + '/api/status')
          if (!res.ok) throw new Error('status request failed')
          const data = await res.json()
          if (data.clientState === 'connected') {
            status.textContent = '🟢 Strudel connected'
          } else if (data.clientState === 'connecting') {
            status.textContent = '🟡 Client connecting...'
          } else {
            status.textContent = '🔴 No Strudel client. Open strudel.cc and paste snippet.'
          }
        } catch (err) {
          status.textContent = 'Status unavailable: ' + String(err)
        }
      }

      openButton.addEventListener('click', openStrudel)
      copyButton.addEventListener('click', () => { void copySnippet() })

      window.addEventListener('load', () => {
        openStrudel()
        void loadSnippet()
        void pollStatus()
        setInterval(() => { void pollStatus() }, 2000)
      })
    </script>
  </body>
</html>
`

    const engineHtml = `<!doctype html>
<html>
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Heiwa DJ Engine</title>
    <style>
      body { margin: 0; background: #0b1118; color: #e7edf5; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif; }
      .wrap { display: grid; grid-template-rows: auto 1fr; min-height: 100vh; }
      .top { border-bottom: 1px solid #273445; padding: 10px 14px; background: #111a24; display: grid; gap: 8px; }
      .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
      .pill { font-size: 12px; border-radius: 999px; border: 1px solid #31465f; padding: 4px 10px; }
      button { border: 0; border-radius: 8px; padding: 8px 12px; cursor: pointer; font-weight: 700; }
      #unlock { background: #2a9d8f; color: #06241f; }
      #connect { background: #3a86ff; color: #fff; }
      #repl { display: block; height: calc(100vh - 128px); }
      #status { font-size: 13px; color: #9eb3c8; }
    </style>
    ${replDistDir
      ? '<script src="/vendor/strudel-repl/index.js"></script>'
      : '<script>console.error("Missing @strudel/repl dist bundle. Run pnpm install.")</script>'}
  </head>
  <body>
    <div class="wrap">
      <div class="top">
        <div class="row">
          <button id="unlock">▶ Unlock Audio</button>
          <button id="connect">Reconnect Bridge</button>
          <span id="status" class="pill">booting</span>
        </div>
        <div style="font-size:12px;color:#8da2b8">This page is the native Strudel runtime. Keep it open while Heiwa performs.</div>
      </div>
      <strudel-editor id="repl" code="setcpm(124)
$: s(\\"bd*4\\")
$: s(\\"~ cp ~ cp\\")
$: s(\\"hh*8\\").gain(0.35)"></strudel-editor>
    </div>
    <script>
      const bridgeUrl = 'ws://localhost:${this.opts.bridgePort}'
      const statusEl = document.getElementById('status')
      const unlockBtn = document.getElementById('unlock')
      const connectBtn = document.getElementById('connect')
      const replEl = document.getElementById('repl')
      let socket = null
      let editorPromise = null

      function setStatus(text) {
        statusEl.textContent = text
      }

      async function getEditor() {
        if (editorPromise) return editorPromise
        editorPromise = (async () => {
          await customElements.whenDefined('strudel-editor')
          if (replEl.editor) return replEl.editor
          return await new Promise((resolve, reject) => {
            let attempts = 0
            const timer = setInterval(() => {
              if (replEl.editor) {
                clearInterval(timer)
                resolve(replEl.editor)
                return
              }
              attempts += 1
              if (attempts > 240) {
                clearInterval(timer)
                reject(new Error('strudel editor not ready'))
              }
            }, 50)
          })
        })()
        return editorPromise
      }

      async function unlockAudio() {
        try {
          const editor = await getEditor()
          const ctx = editor?.repl?.scheduler?.context
          if (ctx && typeof ctx.resume === 'function') {
            await ctx.resume()
          }
          setStatus('audio ready')
        } catch (err) {
          setStatus('audio unlock failed')
          console.error(err)
        }
      }

      async function connectBridge() {
        if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
          return
        }

        setStatus('connecting')
        socket = new WebSocket(bridgeUrl)

        socket.onopen = () => {
          setStatus('connected')
          socket.send(JSON.stringify({ type: 'connected' }))
        }
        socket.onclose = () => {
          setStatus('disconnected')
          socket = null
        }
        socket.onerror = () => {
          setStatus('connection error')
        }
        socket.onmessage = async (event) => {
          let msg
          try {
            msg = JSON.parse(event.data)
          } catch {
            return
          }

          try {
            const editor = await getEditor()

            if (msg.type === 'update') {
              editor.setCode(msg.data || '')
              await editor.evaluate()
              socket.send(JSON.stringify({ type: 'ack', messageId: msg.messageId, executedPhraseIndex: msg.targetPhraseIndex }))
              return
            }

            if (msg.type === 'stop') {
              await editor.stop()
              socket.send(JSON.stringify({ type: 'ack', messageId: msg.messageId, executedPhraseIndex: msg.targetPhraseIndex }))
            }
          } catch (err) {
            if (socket && msg?.messageId) {
              socket.send(JSON.stringify({ type: 'error', messageId: msg.messageId, message: String(err) }))
            }
            console.error(err)
          }
        }
      }

      unlockBtn.addEventListener('click', () => { void unlockAudio() })
      connectBtn.addEventListener('click', () => { void connectBridge() })

      window.addEventListener('load', () => {
        void unlockAudio()
        void connectBridge()
      })
    </script>
  </body>
</html>`

    app.get('/engine', (_req, res) => {
      res.type('html').send(engineHtml)
    })

    app.get('/helper', (_req, res) => {
      res.type('html').send(helperHtml)
    })

    app.get('/', (_req, res) => {
      if (this.opts.embeddedEngine) {
        res.type('html').send(engineHtml)
        return
      }
      res.type('html').send(helperHtml)
    })

    this.localServer = app.listen(this.opts.localStrudelPort, () => {
      this.emit('local_server', this.opts.localStrudelPort)
    })
  }
}

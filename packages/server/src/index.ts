import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import readline from 'node:readline'
import fs from 'node:fs'
import { startAPI } from './api.js'
import { DJAgentRunner } from './agent.js'
import { DJBridge } from './bridge.js'
import { CircuitBreaker } from './breaker.js'
import { loadConfig } from './config/dj.config.js'

function getRuntimeConfig(): any {
  const envPath = process.env.HEIWA_DJ_CONFIG_PATH
  if (envPath && fs.existsSync(envPath)) {
    console.log(`[Config] loading overrides from ${envPath}`)
    // In a real implementation we might dynamic import or merge.
    // For now we trust the built-in loadConfig but allow future expansion.
  }
  return loadConfig()
}
import { loadAllowedSamples } from './linter.js'
import { selectActiveModel } from './probe.js'
import { createInitialState, makeRequest, enqueueRequest } from './state.js'

function printStartupBanner(localMode: boolean, embeddedEngine: boolean, apiPort: number, localStrudelPort: number): void {
  if (localMode) {
    if (embeddedEngine) {
      console.log('┌─────────────────────────────────────────────────────┐')
      console.log('│  Heiwa DJ — embedded Strudel engine mode           │')
      console.log('│                                                     │')
      console.log(`│  1. Open http://127.0.0.1:${localStrudelPort}/engine              │`)
      console.log('│  2. Keep engine window open                         │')
      console.log(`│  3. Open http://127.0.0.1:${apiPort} for DJ UI                 │`)
      console.log('└─────────────────────────────────────────────────────┘')
    } else {
      console.log('┌─────────────────────────────────────────────────────┐')
      console.log('│  Heiwa DJ — local helper mode                      │')
      console.log('│                                                     │')
      console.log(`│  1. Open http://127.0.0.1:${localStrudelPort} in Chrome            │`)
      console.log('│  2. Click "Open strudel.cc"                        │')
      console.log('│  3. Paste snippet into strudel.cc console          │')
      console.log(`│  4. Open http://127.0.0.1:${apiPort} for DJ UI                 │`)
      console.log('└─────────────────────────────────────────────────────┘')
    }
    return
  }

  console.log('┌─────────────────────────────────────────────────────┐')
  console.log('│  Heiwa DJ — strudel.cc mode                        │')
  console.log('│                                                     │')
  console.log('│  1. Open https://strudel.cc in Chrome              │')
  console.log('│  2. Open browser console (Cmd+Option+J)            │')
  console.log('│  3. Paste connection snippet from:                 │')
  console.log(`│     http://127.0.0.1:${apiPort}/snippet                    │`)
  console.log('│  4. Press Enter — you should see "connected"       │')
  console.log(`│  5. Open http://127.0.0.1:${apiPort} for the DJ UI                 │`)
  console.log('└─────────────────────────────────────────────────────┘')
}

async function main(): Promise<void> {
  const [major] = process.versions.node.split('.').map(Number)
  if (major < 22) {
    console.error('Node 22+ required. Current:', process.version)
    process.exit(1)
  }
  console.log(`[Heiwa] Node runtime: ${process.version}`)

  const config = getRuntimeConfig()
  const localMode = process.argv.includes('--local')
  const embeddedEngine = process.argv.includes('--embedded-engine')
  const serveBuiltUi = process.env.HEIWA_DJ_SERVE_UI_DIST === '1'
  const noAutoOpen = process.env.HEIWA_DJ_NO_AUTO_OPEN === '1'

  const discoverRootDir = (): string => {
    if (process.env.HEIWA_DJ_ROOT_DIR) {
      return path.resolve(process.env.HEIWA_DJ_ROOT_DIR)
    }

    let cursor = path.dirname(fileURLToPath(import.meta.url))
    for (let i = 0; i < 10; i += 1) {
      const candidate = path.join(cursor, 'package.json')
      if (fs.existsSync(candidate)) {
        try {
          const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8')) as { name?: string }
          if (parsed.name === 'heiwa-dj') return cursor
        } catch {
          // continue upward
        }
      }
      const next = path.dirname(cursor)
      if (next === cursor) break
      cursor = next
    }

    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
  }

  const rootDir = discoverRootDir()
  const sampleMapPath = path.resolve(rootDir, config.sampleMapPath)
  const sampleDir = path.resolve(rootDir, config.sampleDir)
  const uiDistDir = process.env.HEIWA_DJ_UI_DIST_DIR
    ? path.resolve(process.env.HEIWA_DJ_UI_DIST_DIR)
    : path.resolve(rootDir, 'packages/ui/dist')

  const allowedSamples = loadAllowedSamples(sampleMapPath)
  const modelSelection = await selectActiveModel(config.modelCandidates)

  const state = createInitialState({
    activeModel: modelSelection.activeModel,
    mode: modelSelection.mode,
    localMode,
    phraseLength: config.phraseLength,
    allowedSamples
  })

  const breaker = new CircuitBreaker()
  const uiEmitter = new EventEmitter()

  const bridge = new DJBridge({
    bridgePort: config.bridgePort,
    localStrudelPort: config.localStrudelPort,
    apiPort: config.apiPort,
    localMode,
    embeddedEngine,
    sessionId: state.sessionId,
    phraseLength: state.phraseLength,
    initialCpm: state.currentCPM
  })

  bridge.on('warning', (msg: string) => {
    state.lastError = msg
  })

  bridge.on('phrase', (phrase: number) => {
    state.currentPhraseIndex = phrase
  })

  bridge.start()

  const api = startAPI({
    state,
    bridge,
    breaker,
    uiEmitter,
    apiPort: config.apiPort,
    queueMax: config.queueMax,
    sampleDir,
    uiDistDir: serveBuiltUi ? uiDistDir : null
  })

  const agent = new DJAgentRunner({
    state,
    bridge,
    breaker,
    uiEmitter,
    onStateChange: api.broadcast
  })

  agent.start()

  const rl = readline.createInterface({ input: process.stdin, terminal: false })
  rl.on('line', (line) => {
    const text = line.trim()
    if (!text) return
    const req = makeRequest({ text, priority: 'P1', source: 'stdin' })
    enqueueRequest(state, req, config.queueMax)
    console.log(`[stdin] queued: "${text}"`)
    api.broadcast()
  })

  printStartupBanner(localMode, embeddedEngine, config.apiPort, config.localStrudelPort)
  if (serveBuiltUi) {
    console.log(`[Heiwa] serving built UI from ${uiDistDir}`)
    console.log(`[Heiwa] open http://127.0.0.1:${config.apiPort}`)
  } else {
    console.log('[Heiwa] UI dev server expected on http://127.0.0.1:5173')
  }
  console.log(`[Heiwa] model selected: ${modelSelection.activeModel} (${modelSelection.mode})`)
  if (modelSelection.warning) {
    console.warn(modelSelection.warning)
  }
  if (modelSelection.installedModels.length > 0) {
    console.log(`[Heiwa] installed models: ${modelSelection.installedModels.join(', ')}`)
  } else {
    console.warn('[Heiwa] no installed models discovered from ollama list')
  }
  for (const probe of modelSelection.probes) {
    console.log(`[Probe] ${probe.model} => ${probe.mode} (${probe.details})`)
  }

  if (localMode && !noAutoOpen) {
    const localPath = embeddedEngine ? '/engine' : ''
    spawn('open', ['-a', 'Google Chrome', `http://127.0.0.1:${config.localStrudelPort}${localPath}`], {
      detached: true,
      stdio: 'ignore'
    }).unref()
  }

  const shutdown = async () => {
    console.log('\n[Heiwa] shutting down...')
    agent.stop()
    bridge.stop()
    await api.close()
    process.exit(0)
  }

  process.on('SIGINT', () => {
    void shutdown()
  })
  process.on('SIGTERM', () => {
    void shutdown()
  })
}

void main().catch((err) => {
  console.error('[Heiwa] fatal startup error', err)
  process.exit(1)
})

#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import net from 'node:net'

const ROOT_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const API_BASE = process.env.HEIWA_SMOKE_BASE_URL ?? 'http://127.0.0.1:3001'
const WS_URL = process.env.HEIWA_SMOKE_WS_URL ?? 'ws://127.0.0.1:3001/ws'
const TIMEOUT_MS = Number(process.env.HEIWA_SMOKE_TIMEOUT_MS ?? 45000)
const ARTIFACT_DIR = path.join(ROOT_DIR, 'artifacts', 'app-window-smoke')
const REQUIRED_PORTS = [3001, 4321, 9999]

const checks = []

function findServerEntry() {
  const candidates = [
    path.join(ROOT_DIR, 'packages', 'server', 'dist', 'packages', 'server', 'src', 'index.js'),
    path.join(ROOT_DIR, 'packages', 'server', 'dist', 'src', 'index.js'),
    path.join(ROOT_DIR, 'packages', 'server', 'dist', 'index.js')
  ]
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

function assertBuildAssets(serverEntry) {
  const uiEntry = path.join(ROOT_DIR, 'packages', 'ui', 'dist', 'index.html')
  if (!serverEntry || !fs.existsSync(uiEntry)) {
    throw new Error('Built assets missing. Run: pnpm build')
  }
}

function checkPortFree(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port })
    socket.once('connect', () => {
      socket.destroy()
      resolve(false)
    })
    socket.once('error', () => resolve(true))
  })
}

async function assertPortsFree() {
  const busy = []
  for (const port of REQUIRED_PORTS) {
    const free = await checkPortFree(port)
    if (!free) busy.push(port)
  }
  if (busy.length > 0) {
    throw new Error(`Required ports are busy: ${busy.join(', ')}. Run: pnpm heiwa:stop`)
  }
}

async function waitFor(url, timeoutMs) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(url)
      if (res.ok) return res
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 350))
  }
  throw new Error(`Timed out waiting for ${url}`)
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
  let payload = null
  try {
    payload = await res.json()
  } catch {
    payload = null
  }
  return { status: res.status, ok: res.ok, json: payload }
}

async function waitForStatusEvent(timeoutMs) {
  if (typeof WebSocket === 'undefined') {
    throw new Error('Node runtime does not provide WebSocket global.')
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.close()
      reject(new Error(`Timed out waiting for websocket status event from ${WS_URL}`))
    }, timeoutMs)

    const ws = new WebSocket(WS_URL)

    ws.addEventListener('error', (err) => {
      clearTimeout(timer)
      reject(new Error(`WebSocket error: ${String(err.message ?? err.type ?? 'unknown')}`))
    })

    ws.addEventListener('message', (evt) => {
      try {
        const parsed = JSON.parse(String(evt.data))
        if (parsed?.type === 'status') {
          clearTimeout(timer)
          ws.close()
          resolve(parsed)
        }
      } catch {
        // ignore parse errors
      }
    })
  })
}

function pushCheck(name, ok, details) {
  checks.push({ name, ok, details, ts: new Date().toISOString() })
}

function buildArtifact(stdoutLogs, stderrLogs, startedAt, endedAt) {
  return {
    command: 'pnpm app:smoke:windows',
    startedAt,
    endedAt,
    durationMs: new Date(endedAt).getTime() - new Date(startedAt).getTime(),
    checks,
    processLogs: {
      stdoutTail: stdoutLogs.slice(-80),
      stderrTail: stderrLogs.slice(-80)
    }
  }
}

async function main() {
  const startedAt = new Date().toISOString()
  const stdoutLogs = []
  const stderrLogs = []
  let child = null

  try {
    const serverEntry = findServerEntry()
    assertBuildAssets(serverEntry)
    await assertPortsFree()

    child = spawn('node', [serverEntry, '--local', '--embedded-engine'], {
      cwd: ROOT_DIR,
      env: {
        ...process.env,
        HEIWA_DJ_SERVE_UI_DIST: '1',
        HEIWA_DJ_NO_AUTO_OPEN: '1',
        HEIWA_DJ_ROOT_DIR: ROOT_DIR,
        HEIWA_DJ_UI_DIST_DIR: path.join(ROOT_DIR, 'packages', 'ui', 'dist'),
        HEIWA_DJ_MODEL_CANDIDATES: 'qwen2.5-coder:7b'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })

    child.stdout.on('data', (chunk) => {
      stdoutLogs.push(String(chunk))
    })
    child.stderr.on('data', (chunk) => {
      stderrLogs.push(String(chunk))
    })

    const statusRes = await waitFor(`${API_BASE}/api/status`, TIMEOUT_MS)
    const statusJson = await statusRes.json()
    pushCheck('startup-health', statusRes.ok && typeof statusJson?.activeModel === 'string', {
      statusCode: statusRes.status,
      activeModel: statusJson?.activeModel ?? null,
      clientState: statusJson?.clientState ?? null
    })

    const rootRes = await waitFor(`${API_BASE}/`, TIMEOUT_MS)
    const rootHtml = await rootRes.text()
    pushCheck('launch-readiness-ui', rootRes.ok && /Heiwa DJ/i.test(rootHtml), {
      statusCode: rootRes.status,
      containsHeiwaDj: /Heiwa DJ/i.test(rootHtml)
    })

    const snippetRes = await waitFor(`${API_BASE}/snippet`, TIMEOUT_MS)
    const snippetText = await snippetRes.text()
    pushCheck('snippet-availability', snippetRes.ok && snippetText.includes('heiwaSocketInitialized'), {
      statusCode: snippetRes.status,
      containsInitializer: snippetText.includes('heiwaSocketInitialized')
    })

    const wsEvent = await waitForStatusEvent(12000)
    pushCheck('ws-transport', wsEvent?.type === 'status', {
      type: wsEvent?.type ?? null,
      clientState: wsEvent?.clientState ?? null
    })

    const smokeText = `window smoke ping ${Date.now()}`
    const requestRes = await postJson(`${API_BASE}/api/request`, {
      text: smokeText,
      priority: 'P1',
      source: 'ui'
    })
    pushCheck('chat-request-acceptance', requestRes.ok && requestRes.json?.ok === true, {
      statusCode: requestRes.status,
      bodyOk: requestRes.json?.ok ?? false
    })

    const volumeRes = await postJson(`${API_BASE}/api/control/volume`, { value: 0.8 })
    pushCheck('transport-control-volume', volumeRes.ok && volumeRes.json?.ok === true, {
      statusCode: volumeRes.status,
      bodyOk: volumeRes.json?.ok ?? false
    })

    const historyRes = await waitFor(`${API_BASE}/api/history`, TIMEOUT_MS)
    const historyJson = await historyRes.json()
    const hasChat = Array.isArray(historyJson?.chat) &&
      historyJson.chat.some((entry) => entry?.text === smokeText)
    pushCheck('chat-history-recorded', historyRes.ok && hasChat, {
      statusCode: historyRes.status,
      hasSmokeText: hasChat
    })

    const failed = checks.filter((item) => !item.ok)
    if (failed.length > 0) {
      throw new Error(`Smoke checks failed: ${failed.map((item) => item.name).join(', ')}`)
    }

    const endedAt = new Date().toISOString()
    fs.mkdirSync(ARTIFACT_DIR, { recursive: true })
    const artifactPath = path.join(ARTIFACT_DIR, `smoke-${Date.now()}.json`)
    fs.writeFileSync(artifactPath, JSON.stringify(buildArtifact(stdoutLogs, stderrLogs, startedAt, endedAt), null, 2))
    console.log(`[app-window-smoke] PASS`)
    console.log(`[app-window-smoke] artifact=${artifactPath}`)
  } finally {
    if (child && !child.killed) {
      child.kill('SIGTERM')
      await new Promise((resolve) => setTimeout(resolve, 800))
      if (!child.killed) child.kill('SIGKILL')
    }
  }
}

main().catch((err) => {
  console.error(`[app-window-smoke] FAIL ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})

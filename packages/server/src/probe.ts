import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export type ProbeMode = 'tool' | 'json' | 'safe_groove_only'

export interface ProbeResult {
  model: string
  mode: 'tool' | 'json'
  hasToolsCapability: boolean
  successfulToolCalls: number
  totalAttempts: number
  details: string
}

export interface ModelSelection {
  activeModel: string
  mode: ProbeMode
  probes: ProbeResult[]
  installedModels: string[]
  warning?: string
}

export async function listInstalledModels(): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('ollama', ['list'])
    const lines = stdout.split('\n').map((line) => line.trim()).filter(Boolean)
    if (lines.length <= 1) return []

    return lines
      .slice(1)
      .map((line) => line.split(/\s+/)[0])
      .filter(Boolean)
  } catch {
    return []
  }
}

async function hasToolCapability(model: string): Promise<{ hasTools: boolean; details: string }> {
  try {
    const { stdout } = await execFileAsync('ollama', ['show', model])
    const hasTools = /Capabilities[\s\S]*\btools\b/i.test(stdout)
    return {
      hasTools,
      details: hasTools ? 'ollama show reports tools capability' : 'ollama show missing tools capability'
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'ollama show failed'
    return { hasTools: false, details: msg }
  }
}

async function singleToolProbe(model: string): Promise<boolean> {
  const payload = {
    model,
    stream: false,
    messages: [{ role: 'user', content: 'Call test_tool with value 42 now.' }],
    tools: [
      {
        type: 'function',
        function: {
          name: 'test_tool',
          description: 'test probe tool',
          parameters: {
            type: 'object',
            properties: { value: { type: 'number' } },
            required: ['value']
          }
        }
      }
    ]
  }

  try {
    const res = await fetch('http://localhost:11434/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })

    if (!res.ok) return false
    const json = (await res.json()) as {
      message?: { tool_calls?: Array<unknown> }
    }

    return Boolean(json.message?.tool_calls && json.message.tool_calls.length > 0)
  } catch {
    return false
  }
}

export async function probeModel(model: string): Promise<ProbeResult> {
  const cap = await hasToolCapability(model)
  const attempts = 10
  let ok = 0

  if (cap.hasTools) {
    for (let i = 0; i < attempts; i += 1) {
      if (await singleToolProbe(model)) ok += 1
    }
  }

  const mode: 'tool' | 'json' = cap.hasTools && ok >= 8 ? 'tool' : 'json'
  return {
    model,
    mode,
    hasToolsCapability: cap.hasTools,
    successfulToolCalls: ok,
    totalAttempts: attempts,
    details: `${cap.details}; tool_call_success=${ok}/${attempts}`
  }
}

export async function selectActiveModel(models: string[] = ['qwen2.5-coder:7b']): Promise<ModelSelection> {
  const installedModels = await listInstalledModels()
  const installedSet = new Set(installedModels)

  const candidates = models.filter((model) => installedSet.has(model))
  if (candidates.length === 0) {
    return {
      activeModel: 'qwen2.5-coder:7b',
      mode: 'safe_groove_only',
      probes: [],
      installedModels,
      warning: 'No required model installed. Run: ollama pull qwen2.5-coder:7b'
    }
  }

  const probes: ProbeResult[] = []

  for (const model of candidates) {
    const result = await probeModel(model)
    probes.push(result)

    if (result.mode === 'tool') {
      return {
        activeModel: result.model,
        mode: 'tool',
        probes,
        installedModels
      }
    }
  }

  const jsonCandidate = probes.find((p) => p.mode === 'json')
  if (jsonCandidate) {
    return {
      activeModel: jsonCandidate.model,
      mode: 'json',
      probes,
      installedModels
    }
  }

  return {
    activeModel: candidates[0],
    mode: 'safe_groove_only',
    probes,
    installedModels,
    warning: 'No usable model responses from Ollama. Running safe groove only mode.'
  }
}

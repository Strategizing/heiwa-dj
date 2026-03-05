import fs from 'node:fs'
import path from 'node:path'

const BANNED_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /\bsetBPM\s*\(/i, reason: 'setBPM() is invalid in Strudel; use setcpm()' },
  { re: /\bfetch\s*\(/i, reason: 'fetch() is not allowed in generated Strudel code' },
  { re: /\bXMLHttpRequest\b/i, reason: 'XMLHttpRequest is not allowed in generated code' },
  { re: /\bimport\s*\(/i, reason: 'dynamic import() is not allowed in generated code' },
  { re: /\brequire\s*\(/i, reason: 'require() is not allowed in generated code' },
  { re: /https?:\/\//i, reason: 'external URLs are not allowed in generated code' }
]

const BUILTIN_SYNTHS = new Set(['sawtooth', 'square', 'sine', 'triangle'])

export function loadAllowedSamples(sampleMapPath: string): string[] {
  try {
    const abs = path.resolve(sampleMapPath)
    const raw = fs.readFileSync(abs, 'utf8')
    const json = JSON.parse(raw) as Record<string, unknown>
    return Object.keys(json).filter((k) => !k.startsWith('_'))
  } catch {
    return ['bd', 'sd', 'hh', 'cp']
  }
}

export function extractSampleNames(code: string): string[] {
  const regex = /s\(\s*["'`]([^"'`]+)["'`]\s*\)/g
  const names = new Set<string>()
  let match: RegExpExecArray | null

  while ((match = regex.exec(code)) !== null) {
    const src = match[1]
    const tokens = src
      .split(/[\s,<>\[\]\(\){}|!@*\/:~]+/)
      .map((t) => t.trim())
      .filter(Boolean)

    for (const token of tokens) {
      if (/^[0-9.]+$/.test(token)) continue
      names.add(token)
    }
  }

  return [...names]
}

export function lintStrudelCode(code: string, allowedSamples: string[]): string | null {
  if (!code.trim()) return 'empty code string'
  if (code.length > 8000) return 'code payload too large'

  for (const rule of BANNED_PATTERNS) {
    if (rule.re.test(code)) return rule.reason
  }

  if (!/\bsetcp[ms]\s*\(/i.test(code)) {
    return 'missing tempo declaration: expected setcpm(...) or setcps(...)'
  }

  const allowed = new Set(allowedSamples)
  const found = extractSampleNames(code)
  const invalid = found.filter((name) => !allowed.has(name) && !BUILTIN_SYNTHS.has(name))

  if (invalid.length > 0) {
    return `unknown samples: ${invalid.join(', ')}`
  }

  return null
}

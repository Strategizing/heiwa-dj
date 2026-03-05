import fs from 'node:fs'
import path from 'node:path'
import * as acorn from 'acorn'

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
  const names = new Set<string>()
  try {
    const ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module' })
    
    // Recursive AST walk to find 's("sample")' calls
    function walk(node: any) {
      if (!node) return
      if (node.type === 'CallExpression' && node.callee && node.callee.name === 's') {
        if (node.arguments && node.arguments.length > 0) {
          const arg = node.arguments[0]
          if (arg.type === 'Literal' && typeof arg.value === 'string') {
             const tokens = arg.value.split(/[\s,<>\[\]\(\){}|!@*\/:~]+/).map((t: string) => t.trim()).filter(Boolean)
             for (const t of tokens) {
               if (/^[0-9.]+$/.test(t)) continue
               names.add(t)
             }
          }
        }
      }
      for (const key in node) {
        if (typeof node[key] === 'object') {
          walk(node[key])
        }
      }
    }
    walk(ast)
  } catch (e) {
    // If it fails to parse, lintStrudelCode will catch the syntax error later
  }
  return [...names]
}

export function lintStrudelCode(code: string, allowedSamples: string[]): string | null {
  if (!code.trim()) return 'empty code string'
  if (code.length > 8000) return 'code payload too large'

  // 1. Strict Syntax Validation
  try {
    acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module' })
  } catch (e: any) {
    return `Syntax Error: ${e.message}`
  }

  // 2. Banned Patterns Check
  for (const rule of BANNED_PATTERNS) {
    if (rule.re.test(code)) return rule.reason
  }

  if (!/\bsetcp[ms]\s*\(/i.test(code)) {
    return 'missing tempo declaration: expected setcpm(...) or setcps(...)'
  }

  // 3. Allowed Samples Validation
  const allowed = new Set(allowedSamples)
  const found = extractSampleNames(code)
  const invalid = found.filter((name) => !allowed.has(name) && !BUILTIN_SYNTHS.has(name))

  if (invalid.length > 0) {
    return `unknown samples: ${invalid.join(', ')}`
  }

  return null
}

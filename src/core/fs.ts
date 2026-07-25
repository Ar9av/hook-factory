import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, resolve, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import type { ConfigFormat } from './types.js'

export function expandPath(p: string, projectDir: string): string {
  if (p.startsWith('~/') || p === '~') return resolve(homedir(), p.slice(2))
  if (isAbsolute(p)) return p
  return resolve(projectDir, p)
}

/**
 * Parse a config file we're about to merge into. We're deliberately permissive:
 * a comment in a JSON5 file or a trailing comma shouldn't make `hf sync` refuse
 * to run, and a file that doesn't exist yet is just `{}`.
 */
export async function readConfigFile(path: string, format: ConfigFormat): Promise<unknown> {
  if (!existsSync(path)) return {}
  const text = await readFile(path, 'utf8')
  if (!text.trim()) return {}
  switch (format) {
    case 'json':
    case 'json5':
      return parseJsonish(text)
    case 'toml':
      return parseToml(text)
    case 'yaml':
      return parseYamlShallow(text)
    default:
      return {}
  }
}

export async function writeConfigFile(path: string, format: ConfigFormat, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const text = serialize(format, value)
  // Write-then-rename so a crash mid-write can't leave a half-written config
  // that bricks the user's agent.
  const tmp = `${path}.hf-tmp`
  await writeFile(tmp, text, 'utf8')
  await rename(tmp, path)
}

export function serialize(format: ConfigFormat, value: unknown): string {
  switch (format) {
    case 'json':
    case 'json5':
      return JSON.stringify(value, null, 2) + '\n'
    case 'toml':
      return emitToml(value as Record<string, unknown>)
    case 'yaml':
      return emitYaml(value) + '\n'
    default:
      return String(value)
  }
}

/** JSON5-lite: strips comments and trailing commas, then uses JSON.parse. */
export function parseJsonish(text: string): unknown {
  let out = ''
  let inStr: string | null = null
  let esc = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (inStr) {
      out += c
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === inStr) inStr = null
      continue
    }
    if (c === '"' || c === "'") {
      inStr = c
      out += c
      continue
    }
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      out += '\n'
      continue
    }
    if (c === '/' && text[i + 1] === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++
      i++
      continue
    }
    out += c
  }
  out = out.replace(/,(\s*[}\]])/g, '$1')
  try {
    return JSON.parse(out)
  } catch {
    // Single-quoted strings are legal JSON5 but not JSON. One more attempt.
    try {
      return JSON.parse(out.replace(/'([^'\\]*(\\.[^'\\]*)*)'/g, (_m, s: string) => JSON.stringify(s)))
    } catch (e) {
      throw new Error(`could not parse config as JSON: ${(e as Error).message}`)
    }
  }
}

// --- TOML ------------------------------------------------------------------
// Only what hook-factory needs: top-level key/values, [tables], and
// [[array-of-tables]] — which is exactly the shape Kimi Code and Codex use.

export function parseToml(text: string): Record<string, unknown> {
  const root: Record<string, unknown> = {}
  let cur: Record<string, unknown> = root
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const arrTable = /^\[\[([^\]]+)\]\]$/.exec(line)
    if (arrTable) {
      const key = arrTable[1]!.trim()
      const arr = (root[key] as unknown[]) ?? []
      cur = {}
      arr.push(cur)
      root[key] = arr
      continue
    }
    const table = /^\[([^\]]+)\]$/.exec(line)
    if (table) {
      const key = table[1]!.trim()
      const t = (root[key] as Record<string, unknown>) ?? {}
      root[key] = t
      cur = t
      continue
    }
    const kv = /^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/.exec(line)
    if (kv) cur[kv[1]!] = parseTomlValue(kv[2]!.trim())
  }
  return root
}

function parseTomlValue(v: string): unknown {
  if (v.startsWith('"') || v.startsWith("'")) return v.slice(1, -1)
  if (v === 'true') return true
  if (v === 'false') return false
  if (/^-?\d+$/.test(v)) return Number(v)
  if (/^-?\d*\.\d+$/.test(v)) return Number(v)
  if (v.startsWith('[')) {
    try {
      return JSON.parse(v.replace(/'/g, '"').replace(/,\s*\]/, ']'))
    } catch {
      return v
    }
  }
  return v
}

export function emitToml(obj: Record<string, unknown>): string {
  const scalars: string[] = []
  const tables: string[] = []
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue
    if (Array.isArray(v) && v.every((e) => typeof e === 'object' && e !== null && !Array.isArray(e))) {
      for (const entry of v as Record<string, unknown>[]) {
        tables.push(`[[${k}]]`)
        for (const [ek, ev] of Object.entries(entry)) {
          if (ev !== undefined) tables.push(`${ek} = ${tomlValue(ev)}`)
        }
        tables.push('')
      }
    } else if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      tables.push(`[${k}]`)
      for (const [ek, ev] of Object.entries(v as Record<string, unknown>)) {
        if (ev !== undefined) tables.push(`${ek} = ${tomlValue(ev)}`)
      }
      tables.push('')
    } else {
      scalars.push(`${k} = ${tomlValue(v)}`)
    }
  }
  return [...scalars, scalars.length ? '' : null, ...tables].filter((l) => l !== null).join('\n').replace(/\n{3,}/g, '\n\n')
}

function tomlValue(v: unknown): string {
  if (typeof v === 'string') return JSON.stringify(v)
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) return `[${v.map(tomlValue).join(', ')}]`
  return JSON.stringify(v)
}

// --- YAML ------------------------------------------------------------------
// A shallow reader (enough to detect an existing `hooks:` block and refuse to
// clobber it) plus a full emitter for the snippets we print.

export function parseYamlShallow(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const line of text.split('\n')) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (m) out[m[1]!] = m[2]!.trim() === '' ? {} : m[2]!.trim()
  }
  return out
}

export function emitYaml(value: unknown, indent = 0): string {
  const pad = '  '.repeat(indent)
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'string') return needsQuote(value) ? JSON.stringify(value) : value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    return value
      .map((v) => {
        const body = emitYaml(v, indent + 1)
        if (typeof v === 'object' && v !== null) {
          return `${pad}- ${body.trimStart()}`
        }
        return `${pad}- ${body}`
      })
      .join('\n')
  }
  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined)
  if (entries.length === 0) return '{}'
  return entries
    .map(([k, v], i) => {
      const prefix = i === 0 && indent > 0 ? '' : pad
      if (typeof v === 'object' && v !== null) {
        const nested = emitYaml(v, indent + 1)
        if (nested === '{}' || nested === '[]') return `${prefix}${k}: ${nested}`
        return `${prefix}${k}:\n${nested}`
      }
      return `${prefix}${k}: ${emitYaml(v, indent + 1)}`
    })
    .join('\n')
}

function needsQuote(s: string): boolean {
  return (
    s === '' ||
    /^[\s>|*&!%@`{}[\]#,]/.test(s) ||
    /[:#]\s/.test(s) ||
    /^(true|false|null|yes|no|on|off|~)$/i.test(s) ||
    /^-?\d/.test(s) ||
    s.includes('\n')
  )
}

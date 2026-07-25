import { appendFileSync, existsSync, mkdirSync, statSync, readFileSync, renameSync, openSync, readSync, closeSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Decision, HookEvent } from './types.js'
import type { DispatchResult } from './runtime.js'

/**
 * A journal of everything the hooks saw and decided.
 *
 * Hooks are otherwise invisible: they run in a subprocess the agent spawns, and
 * when a rule doesn't behave you can't tell whether it never matched, matched
 * and passed, or threw. One JSONL line per dispatch makes all of that
 * observable — and it's what `hf watch` reads.
 */

export const JOURNAL_DIR = '.hookfactory'
export const JOURNAL_FILE = 'events.jsonl'

/** Rotate at 5 MB. One dispatch is a few hundred bytes, so that's a long tail. */
const MAX_BYTES = 5 * 1024 * 1024

export interface JournalEntry {
  ts: string
  agent: string
  /** Canonical event. */
  event: string
  /** The agent's own name for it. */
  native: string
  session?: string
  tool?: string
  command?: string
  path?: string
  prompt?: string
  /** The reduced verdict: allow / deny / ask / context / warn / continue, or 'none'. */
  verdict: string
  reason?: string
  /** Total wall time for the whole dispatch. */
  ms: number
  /** Which hooks ran, and what each of them decided. */
  hooks: { id: string; hit: boolean; ms: number; error?: string }[]
  /** How many hooks were registered for this event but filtered out by a matcher. */
  skipped: number
}

export function journalPath(projectDir: string): string {
  return join(projectDir, JOURNAL_DIR, JOURNAL_FILE)
}

/**
 * Credentials routinely appear in the very commands a guardrail inspects, so
 * the journal must not become the leak it exists to prevent. These are the same
 * shapes secret-guard looks for, duplicated deliberately: journalling sits on
 * the hot path and must not import the plugin layer.
 */
const REDACT: [RegExp, string][] = [
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, 'AKIA…redacted'],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, 'ghp_…redacted'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g, 'xox…redacted'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, 'AIza…redacted'],
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/g, 'sk-…redacted'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, 'jwt…redacted'],
  [/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '…private key redacted…'],
  // Anything shaped like an inline assignment of a long opaque token.
  [/\b([A-Z_]*(?:TOKEN|SECRET|PASSWORD|APIKEY|API_KEY)[A-Z_]*)\s*=\s*\S+/gi, '$1=…redacted'],
]

export function redact(s: string | undefined, max = 400): string | undefined {
  if (s === undefined) return undefined
  let out = s
  for (const [re, rep] of REDACT) out = out.replace(re, rep)
  return out.length > max ? out.slice(0, max) + '…' : out
}

function verdictOf(d: Decision): string {
  return d ? d.kind : 'none'
}

function reasonOf(d: Decision): string | undefined {
  if (!d) return undefined
  if (d.kind === 'deny') return d.reason
  if (d.kind === 'warn') return d.message
  if (d.kind === 'continue') return d.message
  if (d.kind === 'context') return d.text
  return d.reason
}

export function toEntry(ev: HookEvent, result: DispatchResult, ms: number, candidates: number): JournalEntry {
  return {
    ts: new Date().toISOString(),
    agent: ev.agent,
    event: ev.event,
    native: ev.nativeEvent,
    session: ev.sessionId,
    tool: ev.toolName,
    command: redact(ev.command ?? (typeof ev.toolInput?.command === 'string' ? ev.toolInput.command : undefined)),
    path: ev.filePath,
    prompt: redact(ev.prompt, 200),
    verdict: verdictOf(result.decision),
    reason: redact(reasonOf(result.decision), 300),
    ms,
    hooks: result.ran.map((r) => ({ id: r.id, hit: Boolean(r.decision), ms: r.ms, error: r.error })),
    skipped: Math.max(0, candidates - result.ran.length),
  }
}

/**
 * Append one record. Every failure is swallowed: a full disk or a read-only
 * checkout must not turn into a broken tool call. Observability is never worth
 * more than the thing being observed.
 */
export function write(projectDir: string, entry: JournalEntry): void {
  try {
    const path = journalPath(projectDir)
    mkdirSync(dirname(path), { recursive: true })
    if (existsSync(path) && statSync(path).size > MAX_BYTES) {
      renameSync(path, path + '.1')
    }
    appendFileSync(path, JSON.stringify(entry) + '\n', 'utf8')
  } catch {
    // Deliberately silent — stderr here would surface as hook noise in the
    // agent's UI on every single tool call.
  }
}

/** Read the last `limit` entries without loading a large file into memory. */
export function tail(projectDir: string, limit = 200): JournalEntry[] {
  const path = journalPath(projectDir)
  if (!existsSync(path)) return []
  try {
    const size = statSync(path).size
    const want = Math.min(size, 512 * 1024)
    const buf = Buffer.alloc(want)
    const fd = openSync(path, 'r')
    try {
      readSync(fd, buf, 0, want, size - want)
    } finally {
      closeSync(fd)
    }
    return parse(buf.toString('utf8'), size > want).slice(-limit)
  } catch {
    return []
  }
}

/** Byte offset of the end of the file, for incremental reads. */
export function size(projectDir: string): number {
  try {
    return statSync(journalPath(projectDir)).size
  } catch {
    return 0
  }
}

/** Read everything written after `from`. Returns the new offset alongside. */
export function readSince(projectDir: string, from: number): { entries: JournalEntry[]; offset: number } {
  const path = journalPath(projectDir)
  if (!existsSync(path)) return { entries: [], offset: 0 }
  try {
    const end = statSync(path).size
    // A rotation (or a `hf watch --clear`) shrinks the file; start over rather
    // than reading from a stale offset past the new end.
    if (end < from) return { entries: parse(readFileSync(path, 'utf8'), false), offset: end }
    if (end === from) return { entries: [], offset: end }
    const buf = Buffer.alloc(end - from)
    const fd = openSync(path, 'r')
    try {
      readSync(fd, buf, 0, end - from, from)
    } finally {
      closeSync(fd)
    }
    return { entries: parse(buf.toString('utf8'), false), offset: end }
  } catch {
    return { entries: [], offset: from }
  }
}

/** `dropFirst` discards a leading partial line from a mid-file read. */
export function parse(text: string, dropFirst: boolean): JournalEntry[] {
  const lines = text.split('\n').filter((l) => l.trim())
  if (dropFirst) lines.shift()
  const out: JournalEntry[] = []
  for (const l of lines) {
    try {
      const v = JSON.parse(l) as JournalEntry
      if (v && typeof v.agent === 'string') out.push(v)
    } catch {
      // A torn final line just means we caught a write mid-flight.
    }
  }
  return out
}

import { exec as nodeExec } from 'node:child_process'
import type { Adapter, Decision, ExecResult, Hook, HookContext, HookEvent, ResolvedConfig } from './types.js'

const DEFAULT_TIMEOUT_MS = 30_000

export function makeContext(ev: HookEvent, projectDir: string, options: Record<string, unknown>): HookContext {
  return {
    projectDir,
    options,
    log: (...args) => {
      process.stderr.write(args.map((a) => (typeof a === 'string' ? a : inspect(a))).join(' ') + '\n')
    },
    exec: (cmd, opts) => execShell(cmd, opts?.cwd ?? ev.cwd, opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  }
}

function inspect(v: unknown): string {
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

export function execShell(cmd: string, cwd: string, timeoutMs: number): Promise<ExecResult> {
  return new Promise((resolvePromise) => {
    nodeExec(cmd, { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolvePromise({
        code: err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : 1) : 0,
        stdout: stdout?.toString() ?? '',
        stderr: stderr?.toString() ?? '',
      })
    })
  })
}

/**
 * Decisions compose by severity, not by order — a `deny` from the third hook
 * must not be overwritten by an `allow` from the fourth. `context` and `warn`
 * accumulate, since injecting two notes is meaningful; `deny` short-circuits.
 */
export function reduceDecisions(decisions: Decision[]): Decision {
  const real = decisions.filter(Boolean) as Exclude<Decision, undefined | void>[]
  if (real.length === 0) return undefined

  const deny = real.find((d) => d.kind === 'deny')
  if (deny) return deny

  const ask = real.find((d) => d.kind === 'ask')
  if (ask) return ask

  const cont = real.find((d) => d.kind === 'continue')
  if (cont) return cont

  const contexts = real.filter((d) => d.kind === 'context') as { kind: 'context'; text: string }[]
  const warns = real.filter((d) => d.kind === 'warn') as { kind: 'warn'; message: string }[]
  if (contexts.length) {
    const text = [...contexts.map((c) => c.text), ...warns.map((w) => w.message)].join('\n')
    return { kind: 'context', text }
  }
  if (warns.length) return { kind: 'warn', message: warns.map((w) => w.message).join('\n') }

  return real.find((d) => d.kind === 'allow')
}

export interface DispatchOptions {
  config: ResolvedConfig
  adapter: Adapter
  nativeEvent: string
  raw: Record<string, unknown>
  /** Set by `hf test`, so a dry run never fires real side effects. */
  dryRun?: boolean
}

export interface DispatchResult {
  event: HookEvent
  decision: Decision
  ran: { id: string; decision: Decision; ms: number; error?: string }[]
}

export async function dispatch(opts: DispatchOptions): Promise<DispatchResult> {
  const { config, adapter, nativeEvent, raw } = opts
  const ev = adapter.parse(raw, nativeEvent)

  const candidates = config.hooks.filter((h) => {
    if (h.enabled === false) return false
    if (h.event !== ev.event) return false
    if (h.agents && !h.agents.includes(adapter.id)) return false
    return true
  })

  const ran: DispatchResult['ran'] = []
  const decisions: Decision[] = []

  for (const hook of candidates) {
    if (hook.match && !safeMatch(hook, ev)) continue
    const started = Date.now()
    try {
      const decision = opts.dryRun
        ? ({ kind: 'allow', reason: 'dry-run' } as Decision)
        : await withTimeout(
            Promise.resolve(hook.handler(ev, makeContext(ev, config.projectDir, hookOptions(config, hook)))),
            hook.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            hook.id,
          )
      ran.push({ id: hook.id, decision, ms: Date.now() - started })
      decisions.push(decision)
      if (decision && decision.kind === 'deny') break
    } catch (e) {
      // Fail open. A crashing hook must never wedge someone's agent — we
      // surface it on stderr and let the tool call proceed.
      const error = e instanceof Error ? e.message : String(e)
      ran.push({ id: hook.id, decision: undefined, ms: Date.now() - started, error })
      process.stderr.write(`[hook-factory] hook "${hook.id}" failed: ${error}\n`)
    }
  }

  return { event: ev, decision: reduceDecisions(decisions), ran }
}

function hookOptions(config: ResolvedConfig, hook: Hook): Record<string, unknown> {
  if (!hook.plugin) return {}
  const plugin = config.plugins?.find((p) => p.name === hook.plugin)
  return plugin?.options ?? {}
}

function safeMatch(hook: Hook, ev: HookEvent): boolean {
  try {
    return hook.match!(ev)
  } catch (e) {
    process.stderr.write(`[hook-factory] matcher for "${hook.id}" threw: ${String(e)}\n`)
    return false
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, id: string): Promise<T> {
  return new Promise((resolvePromise, reject) => {
    const t = setTimeout(() => reject(new Error(`hook "${id}" timed out after ${ms}ms`)), ms)
    p.then(
      (v) => {
        clearTimeout(t)
        resolvePromise(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      },
    )
  })
}

export async function readStdin(): Promise<Record<string, unknown>> {
  if (process.stdin.isTTY) return {}
  const chunks: Buffer[] = []
  for await (const c of process.stdin) chunks.push(Buffer.from(c))
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (!text) return {}
  try {
    const v = JSON.parse(text)
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : { value: v }
  } catch {
    // Some agents pass plain text rather than JSON on some events.
    return { text }
  }
}

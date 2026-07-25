import type { Decision, HookContext, HookEvent, HookHandler, MaybePromise } from './types.js'

/**
 * Actions are just handlers. Every one of these returns a `HookHandler`, so
 * `onPreToolUse(match.bash(/rm -rf/), deny('nope'))` works — `deny('nope')` is a
 * function that ignores its arguments and returns a deny decision.
 */

function template(s: string, ev: HookEvent): string {
  return s.replace(/\{\{(\w+)\}\}/g, (_, k: string) => {
    const v = (ev as unknown as Record<string, unknown>)[k]
    return typeof v === 'string' ? v : v === undefined ? '' : JSON.stringify(v)
  })
}

/** Block the action. On agents that can't block this event, degrades to a warning. */
export function deny(reason: string | ((ev: HookEvent) => string)): HookHandler {
  return (ev) => ({
    kind: 'deny',
    reason: typeof reason === 'function' ? reason(ev) : template(reason, ev),
  })
}

/** Explicitly approve, skipping the agent's own permission prompt where supported. */
export function allow(reason?: string): HookHandler {
  return () => ({ kind: 'allow', reason })
}

/** Force the agent to ask the user, even in an auto-approve mode. */
export function ask(reason?: string): HookHandler {
  return () => ({ kind: 'ask', reason })
}

/** Inject text into the agent's context. */
export function inject(text: string | ((ev: HookEvent) => MaybePromise<string>)): HookHandler {
  return async (ev) => ({
    kind: 'context',
    text: typeof text === 'function' ? await text(ev) : template(text, ev),
  })
}

/** Surface a message to the user without blocking anything. */
export function warn(message: string | ((ev: HookEvent) => string)): HookHandler {
  return (ev) => ({
    kind: 'warn',
    message: typeof message === 'function' ? message(ev) : template(message, ev),
  })
}

/** On a `stop` hook: refuse to stop and push the agent to keep working. */
export function keepGoing(message: string): HookHandler {
  return (ev) => ({ kind: 'continue', message: template(message, ev) })
}

export interface ShellOptions {
  /** Treat a non-zero exit as a deny, using stderr as the reason. */
  denyOnFailure?: boolean
  /** Feed the command's stdout back into the agent as context. */
  injectStdout?: boolean
  cwd?: string
  timeoutMs?: number
}

/**
 * Run a shell command. `{{filePath}}`, `{{command}}`, `{{toolName}}` etc. are
 * interpolated from the event, which is how `auto-format` stays a one-liner.
 */
export function shell(cmd: string, opts: ShellOptions = {}): HookHandler {
  return async (ev, ctx) => {
    const resolved = template(cmd, ev)
    const res = await ctx.exec(resolved, { cwd: opts.cwd ?? ev.cwd, timeoutMs: opts.timeoutMs })
    if (res.code !== 0 && opts.denyOnFailure) {
      return { kind: 'deny', reason: (res.stderr || res.stdout || `\`${resolved}\` exited ${res.code}`).trim() }
    }
    if (opts.injectStdout && res.stdout.trim()) {
      return { kind: 'context', text: res.stdout.trim() }
    }
    return undefined
  }
}

/** Append a line to a file. The whole of the `audit-log` plugin, basically. */
export function appendFile(path: string, line: string | ((ev: HookEvent) => string)): HookHandler {
  return async (ev) => {
    const { appendFile: append, mkdir } = await import('node:fs/promises')
    const { dirname, resolve } = await import('node:path')
    const target = resolve(ev.cwd, template(path, ev))
    await mkdir(dirname(target), { recursive: true })
    const text = typeof line === 'function' ? line(ev) : template(line, ev)
    await append(target, text.endsWith('\n') ? text : text + '\n', 'utf8')
    return undefined
  }
}

export type NotifyTarget = 'desktop' | 'slack' | 'stderr'

export interface NotifyOptions {
  target?: NotifyTarget
  title?: string
  /** Slack incoming-webhook URL, or the name of an env var holding one. */
  webhook?: string
}

/** Send a notification. Desktop uses osascript/notify-send; no dependencies. */
export function notify(message: string, opts: NotifyOptions = {}): HookHandler {
  return async (ev, ctx) => {
    const text = template(message, ev)
    const title = opts.title ?? 'hook-factory'
    const target = opts.target ?? 'desktop'
    if (target === 'stderr') {
      ctx.log(`${title}: ${text}`)
      return undefined
    }
    if (target === 'slack') {
      const url = opts.webhook?.startsWith('http') ? opts.webhook : process.env[opts.webhook ?? 'SLACK_WEBHOOK_URL']
      if (!url) {
        ctx.log('notify(slack): no webhook configured, skipping')
        return undefined
      }
      try {
        await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: `*${title}*\n${text}` }),
        })
      } catch (e) {
        ctx.log('notify(slack) failed:', e)
      }
      return undefined
    }
    const esc = (s: string) => s.replace(/"/g, '\\"')
    if (process.platform === 'darwin') {
      await ctx.exec(`osascript -e 'display notification "${esc(text)}" with title "${esc(title)}"'`)
    } else if (process.platform === 'linux') {
      await ctx.exec(`notify-send "${esc(title)}" "${esc(text)}"`)
    } else {
      ctx.log(`${title}: ${text}`)
    }
    return undefined
  }
}

/** Compose handlers; the first one to return a decision wins. */
export function all(...handlers: HookHandler[]): HookHandler {
  return async (ev, ctx) => {
    for (const h of handlers) {
      const d = await h(ev, ctx)
      if (d) return d
    }
    return undefined
  }
}

/** Run a handler only when a predicate holds. */
export function when(pred: (ev: HookEvent, ctx: HookContext) => MaybePromise<boolean>, handler: HookHandler): HookHandler {
  return async (ev, ctx) => ((await pred(ev, ctx)) ? handler(ev, ctx) : undefined)
}

/** Explicit no-op, handy while iterating. */
export const noop: HookHandler = () => undefined

export type { Decision }

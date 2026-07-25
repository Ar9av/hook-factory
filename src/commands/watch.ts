import { existsSync, rmSync, watch as fsWatch } from 'node:fs'
import type { Args } from '../cli.js'
import { loadConfig } from '../core/config.js'
import { journalPath, readSince, size as journalSize, tail, type JournalEntry } from '../core/journal.js'
import { c, truncate, visibleLength } from '../core/ui.js'

/**
 * A live monitor for hook activity.
 *
 * The problem this solves: hooks run in a subprocess the agent spawns, so when
 * a rule misbehaves there's nothing to look at. You can't tell a matcher that
 * never fired from a handler that passed from one that threw. This puts all
 * three on screen as they happen, across every agent at once.
 *
 * Rendered with plain ANSI and no dependencies, so it ships in the npm tarball
 * and runs anywhere `npx` does.
 */

const ALT_ON = '\x1b[?1049h'
const ALT_OFF = '\x1b[?1049l'
const HIDE_CURSOR = '\x1b[?25l'
const SHOW_CURSOR = '\x1b[?25h'
const CLEAR = '\x1b[2J\x1b[H'

type Filter = 'all' | 'blocked' | 'acted'

const FILTER_LABEL: Record<Filter, string> = {
  all: 'everything',
  blocked: 'blocked only',
  acted: 'hooks that did something',
}

export async function cmdWatch(args: Args): Promise<void> {
  const config = await loadConfig(args.flags.config as string | undefined)
  const dir = config.projectDir

  if (args.flags.clear) {
    const p = journalPath(dir)
    if (existsSync(p)) rmSync(p)
    process.stdout.write(`${c.green('✓')} cleared ${c.gray(p)}\n`)
    return
  }

  // Piped or --plain: stream one line per event and let the user grep it.
  if (args.flags.plain || args.flags.json || !process.stdout.isTTY) {
    return streamPlain(dir, Boolean(args.flags.json), args)
  }

  return interactive(dir, args)
}

// --- plain / pipe mode -----------------------------------------------------

async function streamPlain(dir: string, json: boolean, args: Args): Promise<void> {
  const history = Number(args.flags.tail ?? 20)
  let offset = 0
  for (const e of tail(dir, history)) {
    process.stdout.write(json ? JSON.stringify(e) + '\n' : plainLine(e) + '\n')
  }
  offset = journalSize(dir)

  if (args.flags.once) return

  await follow(dir, () => {
    const { entries, offset: next } = readSince(dir, offset)
    offset = next
    for (const e of entries) {
      process.stdout.write(json ? JSON.stringify(e) + '\n' : plainLine(e) + '\n')
    }
  })
}

function plainLine(e: JournalEntry): string {
  const what = e.command ?? e.path ?? e.prompt ?? ''
  return [
    e.ts,
    e.agent,
    e.event,
    e.tool ?? '-',
    e.verdict,
    `${e.ms}ms`,
    what.replace(/\s+/g, ' ').slice(0, 120),
    e.reason ? `— ${e.reason.replace(/\s+/g, ' ').slice(0, 120)}` : '',
  ]
    .filter(Boolean)
    .join('\t')
}

// --- interactive mode ------------------------------------------------------

async function interactive(dir: string, args: Args): Promise<void> {
  const state = {
    entries: tail(dir, 500),
    offset: journalSize(dir),
    filter: (args.flags.filter as Filter) ?? 'all',
    paused: false,
    detail: false,
    startedAt: Date.now(),
  }

  const out = process.stdout
  out.write(ALT_ON + HIDE_CURSOR)

  let stopped = false
  const restore = () => {
    if (stopped) return
    stopped = true
    out.write(SHOW_CURSOR + ALT_OFF)
    if (process.stdin.isTTY) process.stdin.setRawMode(false)
    process.stdin.pause()
  }
  process.on('exit', restore)
  process.on('SIGINT', () => {
    restore()
    process.exit(0)
  })

  const render = () => out.write(CLEAR + view(state, dir))

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (key: string) => {
      switch (key) {
        case 'q':
        case '':
          restore()
          process.exit(0)
          break
        case 'p':
          state.paused = !state.paused
          break
        case 'f':
          state.filter = state.filter === 'all' ? 'acted' : state.filter === 'acted' ? 'blocked' : 'all'
          break
        case 'd':
          state.detail = !state.detail
          break
        case 'c':
          state.entries = []
          break
        case 'x': {
          const p = journalPath(dir)
          if (existsSync(p)) rmSync(p)
          state.entries = []
          state.offset = 0
          break
        }
      }
      render()
    })
  }

  out.on('resize', render)
  render()

  await follow(dir, () => {
    if (state.paused) return
    const { entries, offset } = readSince(dir, state.offset)
    state.offset = offset
    if (entries.length) {
      state.entries.push(...entries)
      if (state.entries.length > 2000) state.entries = state.entries.slice(-1000)
      render()
    }
  })
}

/**
 * fs.watch is the fast path, but it misses events on some network and
 * container filesystems, so a slow poll backs it up. Both funnel into the same
 * offset-based read, which makes duplicate triggers harmless.
 */
async function follow(dir: string, onChange: () => void): Promise<void> {
  const target = journalPath(dir)
  const parent = target.slice(0, target.lastIndexOf('/'))

  let watcher: ReturnType<typeof fsWatch> | undefined
  const attach = () => {
    if (watcher || !existsSync(parent)) return
    try {
      watcher = fsWatch(parent, (_e, name) => {
        if (!name || name.toString().startsWith('events.jsonl')) onChange()
      })
    } catch {
      // Fall back to polling alone.
    }
  }
  attach()

  const poll = setInterval(() => {
    attach()
    onChange()
  }, 500)

  // Runs until the process is killed; `q` and SIGINT both exit directly.
  await new Promise<void>(() => {})
  clearInterval(poll)
  watcher?.close()
}

// --- rendering -------------------------------------------------------------

function view(
  state: { entries: JournalEntry[]; filter: Filter; paused: boolean; detail: boolean; startedAt: number },
  dir: string,
): string {
  // `|| ` not `?? ` on purpose: a pty that hasn't been told its size reports 0,
  // which is not nullish, and a height of 0 collapses the feed to a few rows.
  const width = Math.max(60, process.stdout.columns || 100)
  const height = Math.max(12, process.stdout.rows || 30)
  const lines: string[] = []

  const shown = state.entries.filter((e) => passes(e, state.filter))

  lines.push(header(state, shown, width, dir))
  lines.push('')

  // A single event can render as one line or three (reason, hook breakdown),
  // so the budget has to be counted in rendered lines. Fill from the newest
  // backwards and stop when the next entry wouldn't fit — otherwise the
  // terminal scrolls and eats the header.
  const HEADER_LINES = 6
  const FOOTER_LINES = 2
  const budget = Math.max(1, height - HEADER_LINES - FOOTER_LINES)
  const rendered: string[] = []
  let used = 0
  for (let i = shown.length - 1; i >= 0; i--) {
    const text = row(shown[i]!, width, state.detail)
    const cost = text.split('\n').length
    if (used + cost > budget) break
    rendered.unshift(text)
    used += cost
  }
  const visible = rendered

  if (visible.length === 0) {
    lines.push('')
    lines.push(c.gray('  waiting for hook activity…'))
    lines.push('')
    lines.push(c.gray('  Run your agent in another terminal. Every tool call it makes'))
    lines.push(c.gray('  shows up here with the verdict your hooks reached.'))
    if (state.entries.length > 0) {
      lines.push('')
      lines.push(c.gray(`  (${state.entries.length} event(s) hidden by the "${FILTER_LABEL[state.filter]}" filter — press f)`))
    }
  } else {
    lines.push(...visible)
  }

  const used2 = lines.join('\n').split('\n').length
  for (let i = 0; i < height - used2 - 2; i++) lines.push('')

  lines.push(footer(state, width))
  return lines.join('\n')
}

function passes(e: JournalEntry, f: Filter): boolean {
  if (f === 'all') return true
  if (f === 'blocked') return e.verdict === 'deny'
  return e.verdict !== 'none'
}

function header(
  state: { entries: JournalEntry[]; paused: boolean; startedAt: number },
  shown: JournalEntry[],
  width: number,
  dir: string,
): string {
  const all = state.entries
  const denied = all.filter((e) => e.verdict === 'deny').length
  const acted = all.filter((e) => e.verdict !== 'none' && e.verdict !== 'deny').length
  const quiet = all.length - denied - acted

  const title = c.bold(' hook-factory watch ')
  const status = state.paused ? c.yellow('paused') : c.green('live')
  const agents = [...new Set(all.map((e) => e.agent))]

  const counts =
    `${c.bold(String(all.length))} ${c.gray('calls')}   ` +
    `${denied ? c.red(String(denied)) : c.gray('0')} ${c.gray('blocked')}   ` +
    `${acted ? c.blue(String(acted)) : c.gray('0')} ${c.gray('acted')}   ` +
    `${c.gray(`${quiet} passed`)}`

  const l1 = `${title}${c.gray('·')} ${status}  ${c.gray(dir.replace(process.env.HOME ?? '', '~'))}`
  const l2 = `  ${counts}${agents.length ? c.gray(`   ${agents.join(' ')}`) : ''}`

  // A 60-second activity strip: the fastest way to see whether hooks are
  // firing at all, and whether a burst just happened.
  const spark = sparkline(all, 40)
  const l3 = `  ${c.gray('last 60s')} ${spark}  ${c.gray(`${shown.length} shown`)}`

  return [clip(l1, width), clip(l2, width), clip(l3, width), c.gray('─'.repeat(width))].join('\n')
}

const BARS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']

function sparkline(entries: JournalEntry[], buckets: number): string {
  const now = Date.now()
  const windowMs = 60_000
  const per = windowMs / buckets
  const counts = new Array<number>(buckets).fill(0)
  const denied = new Array<number>(buckets).fill(0)
  for (const e of entries) {
    const age = now - Date.parse(e.ts)
    if (!(age >= 0 && age < windowMs)) continue
    const i = buckets - 1 - Math.floor(age / per)
    if (i < 0 || i >= buckets) continue
    counts[i] = (counts[i] ?? 0) + 1
    if (e.verdict === 'deny') denied[i] = (denied[i] ?? 0) + 1
  }
  const max = Math.max(1, ...counts)
  return counts
    .map((n, i) => {
      if (n === 0) return c.gray('·')
      const bar = BARS[Math.min(BARS.length - 1, Math.floor((n / max) * (BARS.length - 1)))]!
      return denied[i] ? c.red(bar) : c.green(bar)
    })
    .join('')
}

function row(e: JournalEntry, width: number, detail: boolean): string {
  const time = c.gray(new Date(e.ts).toTimeString().slice(0, 8))
  const { icon, label } = verdictStyle(e)
  const agent = c.gray(pad(e.agent.slice(0, 14), 14))
  const tool = pad(c.cyan((e.tool ?? e.event).slice(0, 16)), 16)
  const what = (e.command ?? e.path ?? e.prompt ?? c.gray(e.event)).replace(/\s+/g, ' ')

  const slow = e.ms >= 250
  const timing = slow ? c.yellow(`${e.ms}ms`) : c.gray(`${e.ms}ms`)

  const head = `${icon} ${time} ${agent} ${tool} `
  const room = width - visibleLength(head) - visibleLength(timing) - 3
  const main = `${head}${clip(what, Math.max(10, room))}  ${timing}`

  const extra: string[] = []
  if (e.verdict === 'deny' && e.reason) {
    extra.push(`${' '.repeat(11)}${c.red('└')} ${clip(e.reason.replace(/\s+/g, ' '), width - 14)}`)
  } else if (label && e.verdict !== 'none' && e.reason) {
    extra.push(`${' '.repeat(11)}${c.gray('└')} ${c.gray(clip(e.reason.replace(/\s+/g, ' '), width - 14))}`)
  }

  if (detail) {
    // Which hooks ran, which one actually decided, and where the time went.
    // This is the view that answers "why didn't my rule fire?".
    const hooks = e.hooks
      .map((h) => {
        const mark = h.error ? c.red('err') : h.hit ? c.cyan('hit') : c.gray('pass')
        return `${mark} ${c.gray(h.id)}${h.ms >= 100 ? c.yellow(` ${h.ms}ms`) : ''}`
      })
      .join(c.gray('  '))
    const none = e.hooks.length === 0 ? c.gray(`no hook matched${e.skipped ? ` (${e.skipped} filtered out by matchers)` : ''}`) : hooks
    extra.push(`${' '.repeat(11)}${c.gray('·')} ${clip(none, width - 14)}`)
  }

  return [main, ...extra].join('\n')
}

function verdictStyle(e: JournalEntry): { icon: string; label: string } {
  switch (e.verdict) {
    case 'deny':
      return { icon: c.red('■'), label: 'blocked' }
    case 'ask':
      return { icon: c.yellow('?'), label: 'ask' }
    case 'context':
      return { icon: c.blue('+'), label: 'injected' }
    case 'continue':
      return { icon: c.magenta('↻'), label: 'kept going' }
    case 'warn':
      return { icon: c.yellow('!'), label: 'warned' }
    case 'allow':
      return { icon: c.green('✓'), label: 'allowed' }
    default:
      return { icon: c.gray('·'), label: '' }
  }
}

function footer(state: { filter: Filter; paused: boolean; detail: boolean }, width: number): string {
  const key = (k: string, label: string, on?: boolean) =>
    `${c.cyan(k)} ${on === undefined ? c.gray(label) : on ? c.green(label) : c.gray(label)}`
  const keys = [
    key('f', FILTER_LABEL[state.filter]),
    key('d', 'detail', state.detail),
    key('p', state.paused ? 'resume' : 'pause', state.paused),
    key('c', 'clear view'),
    key('x', 'wipe journal'),
    key('q', 'quit'),
  ].join(c.gray('  ·  '))
  return c.gray('─'.repeat(width)) + '\n  ' + keys
}

function clip(s: string, n: number): string {
  return n <= 1 ? '' : truncate(s, n)
}

function pad(s: string, n: number): string {
  const w = visibleLength(s)
  return w >= n ? s : s + ' '.repeat(n - w)
}

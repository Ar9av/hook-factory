import { readFile, writeFile } from 'node:fs/promises'
import type { Args } from '../cli.js'
import { findConfig, loadConfig } from '../core/config.js'
import { BUILTIN_ADAPTERS, buildRegistry, resolveAgentId } from '../adapters/index.js'
import { detectAgents } from './detect.js'
import { c, statusBadge, sym, table } from '../core/ui.js'
import type { CanonicalEvent } from '../core/types.js'

const MATRIX_EVENTS: CanonicalEvent[] = ['sessionStart', 'userPromptSubmit', 'preToolUse', 'postToolUse', 'preShell', 'stop']

const USAGE = `${c.bold('usage')} hook-factory agent <subcommand>

  ${c.cyan('list')}              Every supported agent, and which ones you've enabled
  ${c.cyan('add <id...>')}       Enable an agent — its native config gets written on next sync
  ${c.cyan('remove <id...>')}    Disable an agent — run \`sync\` after to clean its config up
  ${c.cyan('detect')}            Scan this machine for agents you already have installed
  ${c.cyan('info <id>')}         Events, blocking capability, config paths, and known caveats

${c.bold('examples')}
  ${c.dim('$')} hook-factory agent add cursor gemini-cli
  ${c.dim('$')} hook-factory agent add --detected      ${c.gray('# everything found on this machine')}
  ${c.dim('$')} hook-factory agent info codex
`

export async function cmdAgent(args: Args): Promise<void> {
  const sub = args._[1]
  switch (sub) {
    case 'list':
    case 'ls':
    case undefined:
      return agentList(args)
    case 'add':
      return agentAdd(args)
    case 'remove':
    case 'rm':
      return agentRemove(args)
    case 'detect':
      return agentDetect(args)
    case 'info':
    case 'show':
      return agentInfo(args)
    default:
      process.stdout.write(USAGE)
      process.exitCode = 1
  }
}

// --- list ------------------------------------------------------------------

async function agentList(args: Args): Promise<void> {
  const config = await loadConfig(args.flags.config as string | undefined).catch(() => undefined)
  const enabled = new Set((config?.agents ?? []).map(resolveAgentId))
  const detected = new Map(detectAgents().map((d) => [d.id, d.found]))

  if (args.flags.json) {
    process.stdout.write(
      JSON.stringify(
        BUILTIN_ADAPTERS.map((a) => ({
          id: a.id,
          name: a.name,
          status: a.status,
          install: a.install,
          enabled: enabled.has(a.id),
          detected: detected.get(a.id) ?? false,
        })),
        null,
        2,
      ) + '\n',
    )
    return
  }

  process.stdout.write(`\n${c.bold('Agents')} ${c.gray(`— ${enabled.size} enabled of ${BUILTIN_ADAPTERS.length}`)}\n\n`)
  const rows = BUILTIN_ADAPTERS.map((a) => {
    const on = enabled.has(a.id)
    const box = on ? c.green('[✓]') : c.gray('[ ]')
    const here = detected.get(a.id) ? c.gray('installed') : c.gray('—')
    const caps = MATRIX_EVENTS.map((e) => (!a.events[e] ? c.gray('·') : a.blocking.includes(e) ? c.magenta('■') : c.green('●')))
    return [box, on ? c.cyan(a.id) : c.gray(a.id), a.name, statusBadge(a.status), here, ...caps]
  })
  process.stdout.write(
    table(rows, { head: ['', 'id', 'name', 'hooks', 'local', ...MATRIX_EVENTS.map((e) => e.slice(0, 6))] }) + '\n',
  )
  process.stdout.write(
    `\n  ${c.magenta('■')} ${c.gray('can block')}   ${c.green('●')} ${c.gray('fires, cannot block')}   ${c.gray('·')} ${c.gray('unsupported')}\n`,
  )
  process.stdout.write(`\n  ${c.gray('enable one with')} ${c.dim('hook-factory agent add <id>')}\n\n`)
}

// --- add / remove ----------------------------------------------------------

async function agentAdd(args: Args): Promise<void> {
  const registry = buildRegistry()
  let ids: string[]

  if (args.flags.detected || args.flags.all) {
    ids = detectAgents()
      .filter((d) => d.found)
      .map((d) => d.id)
      .filter((id) => registry.get(id)?.install !== 'none')
    if (ids.length === 0) throw new Error('no agents detected on this machine')
  } else {
    ids = args._.slice(2).map(resolveAgentId)
  }
  if (ids.length === 0) {
    process.stdout.write(USAGE)
    return
  }

  for (const id of ids) {
    if (!registry.has(id)) {
      throw new Error(`unknown agent "${id}" — run \`hook-factory agent list\` to see them all`)
    }
  }

  const { path, src, current } = await readAgents(args)
  const added: string[] = []
  const skipped: string[] = []
  for (const id of ids) {
    if (current.includes(id)) skipped.push(id)
    else {
      current.push(id)
      added.push(id)
    }
  }

  if (added.length) await writeFile(path, replaceAgents(src, current), 'utf8')

  for (const id of skipped) process.stdout.write(`${sym.dot} ${c.gray(`${id} was already enabled`)}\n`)
  for (const id of added) {
    const a = registry.get(id)!
    let note = ''
    if (a.install === 'snippet') note = c.yellow(' — sync will print a block to paste, not write it')
    if (a.install === 'none') note = c.red(' — this agent has no hook system; hooks will not run there')
    process.stdout.write(`${sym.ok} enabled ${c.cyan(id)}${note}\n`)
    for (const n of a.notes ?? []) process.stdout.write(`  ${c.gray('·')} ${c.gray(n)}\n`)
  }
  if (added.length) process.stdout.write(`\n  ${c.gray('then run')} ${c.dim('hook-factory sync')}\n`)
}

async function agentRemove(args: Args): Promise<void> {
  const ids = args._.slice(2).map(resolveAgentId)
  if (ids.length === 0) {
    process.stdout.write(USAGE)
    return
  }
  const { path, src, current } = await readAgents(args)
  const kept = current.filter((a) => !ids.includes(a))
  const removed = current.filter((a) => ids.includes(a))

  if (removed.length) await writeFile(path, replaceAgents(src, kept), 'utf8')

  for (const id of ids) {
    if (removed.includes(id)) process.stdout.write(`${sym.ok} disabled ${c.cyan(id)}\n`)
    else process.stdout.write(`${sym.dot} ${c.gray(`${id} was not enabled`)}\n`)
  }
  if (removed.length) {
    // Dropping it from the array stops future syncs, but the config we already
    // wrote is still sitting in that agent's settings file.
    process.stdout.write(
      `\n  ${c.yellow('!')} ${c.gray('its config file still has a hook-factory block. Clean it up with')} ` +
        `${c.dim(`hook-factory unsync --agent ${removed[0]}`)}\n`,
    )
  }
}

// --- detect ----------------------------------------------------------------

async function agentDetect(args: Args): Promise<void> {
  const detections = detectAgents()
  const found = detections.filter((d) => d.found)
  const config = await loadConfig(args.flags.config as string | undefined).catch(() => undefined)
  const enabled = new Set((config?.agents ?? []).map(resolveAgentId))

  if (args.flags.json) {
    process.stdout.write(JSON.stringify(detections, null, 2) + '\n')
    return
  }

  process.stdout.write(`\n${c.bold('Found on this machine')}\n\n`)
  if (found.length === 0) {
    process.stdout.write(`  ${c.gray('nothing detected')}\n\n`)
    return
  }
  for (const d of found) {
    const mark = enabled.has(d.id) ? c.green('enabled') : c.gray('not enabled')
    process.stdout.write(`  ${sym.ok} ${c.cyan(d.id.padEnd(22))} ${mark.padEnd(20)} ${c.gray(d.evidence.join(', '))}\n`)
  }
  const missing = found.filter((d) => !enabled.has(d.id))
  if (missing.length) {
    process.stdout.write(`\n  ${c.gray('enable them all:')} ${c.dim('hook-factory agent add --detected')}\n`)
  }
  process.stdout.write('\n')
}

// --- info ------------------------------------------------------------------

async function agentInfo(args: Args): Promise<void> {
  const id = resolveAgentId(args._[2] ?? '')
  const adapter = buildRegistry().get(id)
  if (!adapter) throw new Error(`unknown agent "${args._[2] ?? ''}" — run \`hook-factory agent list\``)

  if (args.flags.json) {
    process.stdout.write(JSON.stringify(adapter, (k, v) => (typeof v === 'function' ? undefined : v), 2) + '\n')
    return
  }

  process.stdout.write(`\n${c.bold(adapter.name)} ${c.gray(`(${adapter.id})`)}  ${statusBadge(adapter.status)}\n`)
  if (adapter.docs) process.stdout.write(`${c.gray(adapter.docs)}\n`)

  const how =
    adapter.install === 'write'
      ? c.green('sync writes its config directly')
      : adapter.install === 'snippet'
        ? c.yellow('sync prints a block for you to paste')
        : c.red('no hook system — nothing to install')
  process.stdout.write(`\n${how}\n`)

  const scopes = Object.entries(adapter.scopes)
  if (scopes.length) {
    process.stdout.write(`\n${c.bold('Config')}\n`)
    for (const [scope, s] of scopes) process.stdout.write(`  ${c.gray(scope.padEnd(8))} ${s!.file} ${c.gray(`(${s!.format})`)}\n`)
  }

  const events = Object.entries(adapter.events)
  if (events.length) {
    process.stdout.write(`\n${c.bold('Events')} ${c.gray(`— ${events.length} mapped, ${adapter.blocking.length} can block`)}\n`)
    process.stdout.write(
      table(
        events.map(([canonical, native]) => {
          const blocks = adapter.blocking.includes(canonical as CanonicalEvent)
          return [blocks ? c.magenta('■') : c.green('●'), c.cyan(canonical), c.gray('→'), native ?? '', blocks ? c.gray('can block') : c.gray('observe only')]
        }),
      )
        .split('\n')
        .map((l) => '  ' + l)
        .join('\n') + '\n',
    )
  }

  if (adapter.notes?.length) {
    process.stdout.write(`\n${c.bold('Worth knowing')}\n`)
    for (const n of adapter.notes) process.stdout.write(`  ${c.yellow('·')} ${n}\n`)
  }
  process.stdout.write('\n')
}

// --- config surgery --------------------------------------------------------

/**
 * We rewrite the `agents: [...]` array in place rather than regenerating the
 * config, so comments, formatting, and everything else the user wrote survive.
 */
async function readAgents(args: Args): Promise<{ path: string; src: string; current: string[] }> {
  const path = (args.flags.config as string) ?? findConfig()
  if (!path) throw new Error('no hooks.config found — run `hook-factory init` first')
  const src = await readFile(path, 'utf8')
  const m = /agents\s*:\s*\[([\s\S]*?)\]/.exec(src)
  if (!m) throw new Error(`could not find an \`agents: [...]\` array in ${path} — edit it by hand`)
  const current = [...m[1]!.matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]!)
  return { path, src, current }
}

function replaceAgents(src: string, agents: string[]): string {
  const body = agents.length ? agents.map((a) => `\n    '${a}',`).join('') + '\n  ' : ''
  return src.replace(/agents\s*:\s*\[[\s\S]*?\]/, `agents: [${body}]`)
}

import type { Args } from '../cli.js'
import { loadConfig } from '../core/config.js'
import { BUILTIN_ADAPTERS, buildRegistry, capabilities } from '../adapters/index.js'
import { PLUGIN_CATALOG } from '../plugins/index.js'
import { CANONICAL_EVENTS, EVENT_DOCS } from '../core/events.js'
import { c, statusBadge, sym, table } from '../core/ui.js'
import type { CanonicalEvent } from '../core/types.js'

/** The events worth putting in a terminal-width matrix. */
const MATRIX_EVENTS: CanonicalEvent[] = [
  'sessionStart',
  'userPromptSubmit',
  'preToolUse',
  'postToolUse',
  'preShell',
  'subagentStop',
  'stop',
]

export async function cmdList(args: Args): Promise<void> {
  const json = Boolean(args.flags.json)
  const wantAgents = Boolean(args.flags.agents)
  const wantPlugins = Boolean(args.flags.plugins)
  const wantEvents = Boolean(args.flags.events)
  const showAll = !wantAgents && !wantPlugins && !wantEvents

  if (json) {
    const config = await loadConfig(args.flags.config as string | undefined).catch(() => undefined)
    process.stdout.write(
      JSON.stringify(
        {
          agents: BUILTIN_ADAPTERS.map((a) => ({
            id: a.id,
            name: a.name,
            status: a.status,
            install: a.install,
            docs: a.docs,
            notes: a.notes ?? [],
            events: a.events,
            blocking: a.blocking,
            capabilities: capabilities(a, CANONICAL_EVENTS),
          })),
          plugins: PLUGIN_CATALOG,
          events: CANONICAL_EVENTS.map((e) => ({ name: e, doc: EVENT_DOCS[e] })),
          config: config
            ? {
                path: config.configPath,
                scope: config.scope,
                agents: config.agents,
                hooks: config.hooks.map((h) => ({
                  id: h.id,
                  event: h.event,
                  description: h.description,
                  plugin: h.plugin,
                  enabled: h.enabled !== false,
                  agents: h.agents ?? null,
                })),
              }
            : null,
        },
        null,
        2,
      ) + '\n',
    )
    return
  }

  if (showAll || wantAgents) {
    process.stdout.write(`\n${c.bold('Agents')} ${c.gray(`(${BUILTIN_ADAPTERS.length})`)}\n\n`)
    const rows = BUILTIN_ADAPTERS.map((a) => {
      const caps = MATRIX_EVENTS.map((e) => {
        if (!a.events[e]) return c.gray('·')
        return a.blocking.includes(e) ? c.magenta('■') : c.green('●')
      })
      return [c.cyan(a.id), a.name, statusBadge(a.status), ...caps]
    })
    process.stdout.write(
      table(rows, { head: ['id', 'name', 'hooks', ...MATRIX_EVENTS.map((e) => e.slice(0, 8))] }) + '\n',
    )
    process.stdout.write(
      `\n  ${c.magenta('■')} ${c.gray('can block')}   ${c.green('●')} ${c.gray('fires, cannot block')}   ${c.gray('·')} ${c.gray('unsupported')}\n`,
    )
  }

  if (showAll || wantPlugins) {
    process.stdout.write(`\n${c.bold('Built-in plugins')}\n\n`)
    process.stdout.write(
      table(
        PLUGIN_CATALOG.map((p) => [c.cyan(p.name), p.description, c.dim(p.example)]),
        { head: ['name', 'what it does', 'usage'] },
      ) + '\n',
    )
    process.stdout.write(`\n  ${c.gray('add one with')} ${c.dim('npx hook-factory add <name>')}\n`)
  }

  if (wantEvents) {
    process.stdout.write(`\n${c.bold('Canonical events')}\n\n`)
    process.stdout.write(
      table(
        CANONICAL_EVENTS.map((e) => {
          const supporting = BUILTIN_ADAPTERS.filter((a) => a.events[e]).length
          const blocking = BUILTIN_ADAPTERS.filter((a) => a.blocking.includes(e)).length
          return [c.cyan(e), EVENT_DOCS[e], c.gray(`${supporting} agents, ${blocking} can block`)]
        }),
        { head: ['event', 'when', 'coverage'] },
      ) + '\n',
    )
  }

  if (showAll) {
    const config = await loadConfig(args.flags.config as string | undefined).catch(() => undefined)
    if (!config) {
      process.stdout.write(`\n${c.gray('no hooks.config.ts here — run')} ${c.dim('npx hook-factory init')}\n\n`)
      return
    }
    const registry = buildRegistry(config.adapters ?? [])
    process.stdout.write(`\n${c.bold('Your hooks')} ${c.gray(config.configPath)}\n\n`)
    process.stdout.write(
      table(
        config.hooks.map((h) => {
          const targets = (h.agents ?? config.agents).filter((a) => registry.get(a)?.events[h.event])
          return [
            h.enabled === false ? c.gray(h.id) : c.cyan(h.id),
            c.gray(h.event),
            h.description ?? '',
            c.gray(`${targets.length}/${config.agents.length} agents`),
          ]
        }),
        { head: ['id', 'event', 'description', 'reach'] },
      ) + '\n\n',
    )
  }
  void sym
}

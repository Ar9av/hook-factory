import type { Args } from '../cli.js'
import { loadConfig } from '../core/config.js'
import { buildRegistry, resolveAgentId } from '../adapters/index.js'
import { dispatch } from '../core/runtime.js'
import { CANONICAL_EVENTS } from '../core/events.js'
import { c, sym } from '../core/ui.js'
import type { CanonicalEvent } from '../core/types.js'

/**
 * Fire a synthetic event through the real hook chain. This is the difference
 * between "I think my regex is right" and knowing — and it runs against every
 * configured agent at once, so you see where a rule silently doesn't apply.
 */
export async function cmdTest(args: Args): Promise<void> {
  const config = await loadConfig(args.flags.config as string | undefined)
  const registry = buildRegistry(config.adapters ?? [])
  const json = Boolean(args.flags.json)

  const event = (args._[1] ?? 'preToolUse') as CanonicalEvent
  if (!CANONICAL_EVENTS.includes(event)) {
    throw new Error(`unknown event "${event}". One of: ${CANONICAL_EVENTS.join(', ')}`)
  }

  const raw: Record<string, unknown> = {
    hook_event_name: event,
    session_id: 'hf-test',
    cwd: config.projectDir,
    tool_name: (args.flags.tool as string) ?? 'Bash',
    tool_input: {} as Record<string, unknown>,
  }
  const input = raw.tool_input as Record<string, unknown>
  if (args.flags.command) input.command = String(args.flags.command)
  if (args.flags.file) input.file_path = String(args.flags.file)
  if (args.flags.content) input.content = String(args.flags.content)
  if (args.flags.prompt) raw.prompt = String(args.flags.prompt)

  const agentFilter = args.flags.agent ? resolveAgentId(String(args.flags.agent)) : undefined
  const targets = config.agents.map(resolveAgentId).filter((a) => !agentFilter || a === agentFilter)

  const results: unknown[] = []

  if (!json) {
    process.stdout.write(`\n${c.bold(`test ${event}`)} ${c.gray(JSON.stringify({ ...input, prompt: raw.prompt }))}\n\n`)
  }

  for (const id of targets) {
    const adapter = registry.get(id)
    if (!adapter) continue
    const native = adapter.events[event]
    if (!native) {
      if (!json) process.stdout.write(`  ${c.gray('·')} ${c.bold(adapter.name.padEnd(22))} ${c.gray(`no ${event} event — skipped`)}\n`)
      results.push({ agent: id, skipped: true, reason: `no ${event} event` })
      continue
    }

    const result = await dispatch({ config, adapter, nativeEvent: native, raw })
    const out = adapter.emit(result.decision, result.event)
    const d = result.decision

    if (!json) {
      const verdict = !d
        ? c.gray('no opinion')
        : d.kind === 'deny'
          ? adapter.blocking.includes(event)
            ? c.red(`DENY — ${d.reason}`)
            : c.yellow(`deny requested, but ${adapter.name} cannot block ${event} → warning only`)
          : d.kind === 'context'
            ? c.blue(`inject: ${d.text.slice(0, 60)}`)
            : d.kind === 'continue'
              ? c.magenta(`keep going: ${d.message ?? ''}`)
              : d.kind === 'warn'
                ? c.yellow(`warn: ${d.message}`)
                : c.green(d.kind)
      const icon = d?.kind === 'deny' ? sym.block : d ? sym.ok : sym.dot
      process.stdout.write(`  ${icon} ${c.bold(adapter.name.padEnd(22))} ${verdict}\n`)
      for (const r of result.ran) {
        const mark = r.error ? c.red('err') : r.decision ? c.cyan('hit') : c.gray('pass')
        process.stdout.write(`      ${mark} ${c.gray(r.id)} ${c.gray(`${r.ms}ms`)}${r.error ? c.red(` ${r.error}`) : ''}\n`)
      }
      process.stdout.write(`      ${c.gray(`exit ${out.code}`)}${out.stdout ? c.gray(` stdout ${out.stdout.slice(0, 80)}`) : ''}\n`)
    }

    results.push({
      agent: id,
      nativeEvent: native,
      decision: result.decision,
      canBlock: adapter.blocking.includes(event),
      exitCode: out.code,
      stdout: out.stdout,
      ran: result.ran,
    })
  }

  if (json) process.stdout.write(JSON.stringify({ event, input: raw, results }, null, 2) + '\n')
  else process.stdout.write('\n')
}

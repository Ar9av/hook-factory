import type { Args } from '../cli.js'
import { loadConfig } from '../core/config.js'
import { buildRegistry, resolveAgentId } from '../adapters/index.js'
import { dispatch, readStdin } from '../core/runtime.js'

/**
 * The dispatcher every agent invokes. Correctness bar here is different from the
 * rest of the CLI: this runs inside someone's agent loop, on every tool call, so
 * it has to be fast and it must never crash in a way that wedges the agent. Any
 * internal failure exits 0 and lets the tool call through.
 */
export async function cmdRun(args: Args): Promise<void> {
  const agentId = resolveAgentId(String(args.flags.agent ?? ''))
  const nativeEvent = String(args.flags.event ?? '')

  if (!agentId || !nativeEvent) {
    process.stderr.write('hook-factory run: --agent and --event are required\n')
    process.exitCode = 0
    return
  }

  const raw = await readStdin()

  try {
    const config = await loadConfig(args.flags.config as string | undefined)
    const registry = buildRegistry(config.adapters ?? [])
    const adapter = registry.get(agentId)
    if (!adapter) {
      process.stderr.write(`hook-factory: no adapter for "${agentId}"\n`)
      return
    }

    const result = await dispatch({ config, adapter, nativeEvent, raw })

    if (args.flags.debug) {
      process.stderr.write(
        `[hook-factory] ${agentId}/${nativeEvent} matched ${result.ran.length} hook(s): ` +
          result.ran.map((r) => `${r.id}(${r.ms}ms${r.error ? ' ERR' : ''})`).join(', ') +
          '\n',
      )
    }

    const out = adapter.emit(result.decision, result.event)
    if (out.stdout) process.stdout.write(out.stdout)
    if (out.stderr) process.stderr.write(out.stderr)
    process.exitCode = out.code
  } catch (e) {
    // Fail open, loudly. A misconfigured hooks.config.ts should be annoying,
    // not a hard stop on someone's coding session.
    process.stderr.write(`[hook-factory] ${e instanceof Error ? e.message : String(e)}\n`)
    process.exitCode = 0
  }
}

import type { Args } from '../cli.js'
import { loadConfig } from '../core/config.js'
import { buildRegistry, resolveAgentId } from '../adapters/index.js'
import { applyPlan, diff, displayPath, planSync } from '../core/sync.js'
import { c, colorDiff, statusBadge, sym } from '../core/ui.js'

export async function cmdSync(args: Args, mode: 'sync' | 'remove'): Promise<void> {
  const config = await loadConfig(args.flags.config as string | undefined)
  if (args.flags.scope === 'user' || args.flags.scope === 'project') config.scope = args.flags.scope
  const only = args.flags.agent ? resolveAgentId(String(args.flags.agent)) : undefined
  if (only) config.agents = config.agents.filter((a) => resolveAgentId(a) === only)

  const registry = buildRegistry(config.adapters ?? [])
  const plan = await planSync(config, registry, mode)
  const dryRun = Boolean(args.flags['dry-run'])
  const json = Boolean(args.flags.json)

  if (json) {
    process.stdout.write(
      JSON.stringify(
        {
          mode,
          scope: plan.scope,
          runner: plan.runner,
          unknownAgents: plan.unknownAgents,
          agents: plan.agents.map((a) => ({
            ...a,
            writes: a.writes.map((w) => ({ path: w.path, changed: w.changed, diff: diff(w.before, w.after) })),
          })),
        },
        null,
        2,
      ) + '\n',
    )
    if (!dryRun) await applyPlan(plan, { removeEmpty: mode === 'remove' })
    return
  }

  for (const unknown of plan.unknownAgents) {
    process.stdout.write(`${sym.fail} unknown agent ${c.bold(unknown)} — run \`hook-factory list --agents\`\n`)
  }

  let changedCount = 0
  process.stdout.write(`\n${c.bold(mode === 'sync' ? 'Sync plan' : 'Removal plan')}  ${c.gray(`scope=${plan.scope}`)}\n`)
  process.stdout.write(`${c.gray('runner')} ${c.dim(plan.runner)}\n\n`)

  for (const agent of plan.agents) {
    const head = `${c.bold(agent.name)} ${c.gray(`(${agent.agent})`)}  ${statusBadge(agent.status)}`
    process.stdout.write(`${head}\n`)

    if (agent.install === 'none') {
      process.stdout.write(`  ${c.gray('no hook system — nothing to write')}\n`)
      for (const n of agent.notes) process.stdout.write(`  ${sym.dot} ${c.gray(n)}\n`)
      process.stdout.write('\n')
      continue
    }

    for (const w of agent.writes) {
      const p = displayPath(w.path, config.projectDir)
      if (!w.changed) {
        process.stdout.write(`  ${sym.dot} ${c.gray(p)} ${c.gray('up to date')}\n`)
        continue
      }
      changedCount++
      process.stdout.write(`  ${sym.ok} ${c.cyan(p)}${w.before ? '' : c.gray(' (new)')}\n`)
      if (dryRun || args.flags.verbose) {
        const d = diff(w.before, w.after)
        if (d) process.stdout.write(indent(colorDiff(d), 6) + '\n')
      }
    }

    for (const s of agent.snippets) {
      process.stdout.write(`  ${sym.warn} ${c.yellow('paste required')} ${c.gray(s.path)}\n`)
      process.stdout.write(`    ${c.gray(s.instructions)}\n`)
      process.stdout.write(indent(c.dim(s.content.trimEnd()), 6) + '\n')
    }

    if (agent.unsupportedHooks.length) {
      const events = [...new Set(agent.unsupportedHooks.map((h) => h.event))]
      process.stdout.write(`  ${sym.warn} ${c.yellow(`skipped ${agent.unsupportedHooks.length} hook(s)`)} ${c.gray(`— ${agent.name} has no ${events.join(', ')} event`)}\n`)
    }
    for (const n of agent.notes) process.stdout.write(`  ${sym.dot} ${c.gray(n)}\n`)
    process.stdout.write('\n')
  }

  if (dryRun) {
    process.stdout.write(`${c.gray(`dry run — ${changedCount} file(s) would change. Drop --dry-run to write.`)}\n\n`)
    return
  }

  const written = await applyPlan(plan, { removeEmpty: mode === 'remove' })
  process.stdout.write(
    written.length
      ? `${sym.ok} ${c.bold(`${written.length} file(s) written`)}\n\n`
      : `${sym.dot} ${c.gray('everything already up to date')}\n\n`,
  )
}

function indent(s: string, n: number): string {
  const pad = ' '.repeat(n)
  return s
    .split('\n')
    .map((l) => pad + l)
    .join('\n')
}

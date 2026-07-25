import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import type { Args } from '../cli.js'
import { loadConfig } from '../core/config.js'
import { buildRegistry } from '../adapters/index.js'
import { planSync, displayPath, resolveRunner } from '../core/sync.js'
import { detectAgents } from './detect.js'
import { c, statusBadge, sym } from '../core/ui.js'

interface Finding {
  level: 'ok' | 'warn' | 'error'
  message: string
  fix?: string
}

/**
 * `doctor` answers the question the other commands don't: is this actually
 * wired up right now? It checks the config loads, the runner resolves, the
 * native files really contain our block, and flags hooks that will silently
 * never fire on an agent you listed.
 */
export async function cmdDoctor(args: Args): Promise<void> {
  const findings: Finding[] = []
  const json = Boolean(args.flags.json)

  const nodeMajor = Number(process.versions.node.split('.')[0])
  const nodeMinor = Number(process.versions.node.split('.')[1])
  if (nodeMajor < 20 || (nodeMajor === 20 && nodeMinor < 11)) {
    findings.push({ level: 'error', message: `Node ${process.version} is below the supported minimum (20.11)`, fix: 'upgrade Node' })
  } else if (nodeMajor < 22) {
    findings.push({
      level: 'warn',
      message: `Node ${process.version} cannot import hooks.config.ts directly`,
      fix: 'upgrade to Node >= 22.6, or rename your config to hooks.config.mjs',
    })
  } else {
    findings.push({ level: 'ok', message: `Node ${process.version}` })
  }

  let config
  try {
    config = await loadConfig(args.flags.config as string | undefined)
    findings.push({ level: 'ok', message: `config loaded: ${config.configPath}` })
  } catch (e) {
    findings.push({ level: 'error', message: e instanceof Error ? e.message : String(e), fix: 'npx hook-factory init' })
    return report(findings, json, [])
  }

  if (config.agents.length === 0) {
    findings.push({ level: 'error', message: 'no agents configured', fix: 'add ids to `agents: []` in hooks.config.ts' })
  }
  if (config.hooks.length === 0) {
    findings.push({ level: 'warn', message: 'no hooks defined', fix: 'npx hook-factory add secret-guard' })
  }

  const runner = resolveRunner(config)
  if (runner.startsWith('npx')) {
    findings.push({
      level: 'warn',
      message: 'hooks will invoke hook-factory through npx',
      fix: 'install it locally (`npm i -D hook-factory`) so PreToolUse does not pay npx resolution on every tool call',
    })
  } else {
    findings.push({ level: 'ok', message: `runner: ${runner}` })
  }

  const registry = buildRegistry(config.adapters ?? [])
  const detected = new Map(detectAgents(config.projectDir).map((d) => [d.id, d]))
  const plan = await planSync(config, registry, 'sync')

  for (const unknown of plan.unknownAgents) {
    findings.push({ level: 'error', message: `unknown agent "${unknown}"`, fix: 'npx hook-factory list --agents' })
  }

  const agentReports: {
    agent: string
    name: string
    status: string
    installed: boolean
    detected: boolean
    hookCount: number
    issues: string[]
  }[] = []

  for (const a of plan.agents) {
    const adapter = registry.get(a.agent)!
    const issues: string[] = []

    if (adapter.install === 'none') {
      issues.push(`${a.name} has no hook system — these hooks will not run there`)
    }
    if (!detected.get(a.agent)?.found) {
      issues.push(`no local install detected (config will still be written)`)
    }

    // The real check: is our managed block actually in the file right now?
    let installed = a.writes.length === 0
    for (const w of a.writes) {
      if (!existsSync(w.path)) {
        issues.push(`${displayPath(w.path, config.projectDir)} does not exist yet — run \`hook-factory sync\``)
        continue
      }
      const text = await readFile(w.path, 'utf8')
      if (!text.includes('_hookFactory') && !text.includes('hook-factory')) {
        issues.push(`${displayPath(w.path, config.projectDir)} has no hook-factory block — run \`hook-factory sync\``)
      } else {
        installed = true
        if (w.changed) issues.push(`${displayPath(w.path, config.projectDir)} is stale — run \`hook-factory sync\``)
      }
    }

    if (a.unsupportedHooks.length) {
      const byEvent = new Map<string, string[]>()
      for (const h of a.unsupportedHooks) {
        byEvent.set(h.event, [...(byEvent.get(h.event) ?? []), h.id])
      }
      for (const [event, ids] of byEvent) {
        issues.push(`${a.name} has no \`${event}\` event — ${ids.join(', ')} will never fire here`)
      }
    }

    // A deny() on a non-blocking event is the subtlest failure mode in this
    // whole space: the hook fires, does nothing, and looks like it worked.
    for (const hook of config.hooks) {
      if (!adapter.events[hook.event]) continue
      if (hook.agents && !hook.agents.includes(a.agent)) continue
      if (!adapter.blocking.includes(hook.event) && mentionsDeny(hook.id)) {
        issues.push(`${hook.id} looks like it blocks, but ${a.name} cannot block on \`${hook.event}\` — it will degrade to a warning`)
      }
    }

    agentReports.push({
      agent: a.agent,
      name: a.name,
      status: a.status,
      installed,
      detected: detected.get(a.agent)?.found ?? false,
      hookCount: a.hookCount,
      issues,
    })
  }

  report(findings, json, agentReports)
}

function mentionsDeny(id: string): boolean {
  return /block|deny|guard|protect|refuse|no-/.test(id)
}

function report(
  findings: Finding[],
  json: boolean,
  agents: { agent: string; name: string; status: string; installed: boolean; detected: boolean; hookCount: number; issues: string[] }[],
): void {
  if (json) {
    process.stdout.write(JSON.stringify({ findings, agents }, null, 2) + '\n')
    if (findings.some((f) => f.level === 'error')) process.exitCode = 1
    return
  }

  process.stdout.write(`\n${c.bold('Environment')}\n`)
  for (const f of findings) {
    const icon = f.level === 'ok' ? sym.ok : f.level === 'warn' ? sym.warn : sym.fail
    process.stdout.write(`  ${icon} ${f.message}\n`)
    if (f.fix) process.stdout.write(`      ${c.gray(f.fix)}\n`)
  }

  if (agents.length) {
    process.stdout.write(`\n${c.bold('Agents')}\n`)
    for (const a of agents) {
      const state = a.installed ? c.green('wired up') : c.yellow('not synced')
      const local = a.detected ? c.gray('installed locally') : c.gray('not detected locally')
      process.stdout.write(
        `  ${a.issues.length === 0 ? sym.ok : sym.warn} ${c.bold(a.name)} ${c.gray(`(${a.agent})`)} ` +
          `${statusBadge(a.status as 'supported')} ${state} ${c.gray('·')} ${local} ${c.gray(`· ${a.hookCount} hook(s)`)}\n`,
      )
      for (const i of a.issues) process.stdout.write(`      ${c.gray('·')} ${c.gray(i)}\n`)
    }
  }

  const errors = findings.filter((f) => f.level === 'error').length
  const warns = findings.filter((f) => f.level === 'warn').length + agents.reduce((n, a) => n + a.issues.length, 0)
  process.stdout.write(
    `\n${errors ? c.red(`${errors} error(s)`) : c.green('no errors')}${warns ? c.gray(`, ${warns} thing(s) to look at`) : ''}\n\n`,
  )
  if (errors) process.exitCode = 1
}

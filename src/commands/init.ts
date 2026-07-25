import { existsSync } from 'node:fs'
import { writeFile, mkdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { Args } from '../cli.js'
import { detectAgents } from './detect.js'
import { resolveAgentId } from '../adapters/index.js'
import { c, sym } from '../core/ui.js'

const TEMPLATE = (agents: string[]) => `import {
  defineHooks,
  onPreToolUse,
  onStop,
  match,
  deny,
} from 'hook-factory'
import { secretGuard, dangerousCommands, auditLog } from 'hook-factory/plugins'

export default defineHooks({
  // Every agent listed here gets the same hooks, translated into its own format.
  // Run \`hook-factory list --agents\` to see what else is available.
  agents: [${agents.map((a) => `\n    '${a}',`).join('')}
  ],

  hooks: [
    // Plugins are just bundles of hooks. Drop them in anywhere.
    secretGuard(),
    dangerousCommands(),
    auditLog(),

    // Or write your own. \`match\` normalizes across agents, so this one rule
    // covers Bash on Claude Code, terminal on OpenHands, run_shell_command on
    // Gemini, and shell on goose — without you knowing any of that.
    onPreToolUse(
      match.shell(/\\bsudo\\b/),
      deny('No sudo from the agent. Run it yourself if you really mean it.'),
      { description: 'Block sudo' },
    ),

    // Handlers are just functions — do whatever you want in here.
    onStop(async (ev, ctx) => {
      const { code } = await ctx.exec('git diff --quiet')
      if (code !== 0) ctx.log('heads up: you have uncommitted changes')
    }, { description: 'Warn about uncommitted work' }),
  ],
})
`

/**
 * Node decides whether a file is ESM from the nearest package.json `type`. In a
 * CommonJS project `hooks.config.ts` is loaded as CJS and every `import` line
 * throws, so we write `hooks.config.mts` there instead — `.mts` is unambiguously
 * ESM+TypeScript regardless of what package.json says.
 */
async function pickExtension(cwd: string): Promise<'ts' | 'mts'> {
  const pkgPath = join(cwd, 'package.json')
  if (!existsSync(pkgPath)) return 'mts'
  try {
    const pkg = JSON.parse(await readFile(pkgPath, 'utf8')) as { type?: string }
    return pkg.type === 'module' ? 'ts' : 'mts'
  } catch {
    return 'mts'
  }
}

export async function cmdInit(args: Args): Promise<void> {
  const cwd = process.cwd()
  const ext = await pickExtension(cwd)
  const target = resolve(cwd, (args.flags.config as string) ?? `hooks.config.${ext}`)
  const json = Boolean(args.flags.json)

  const detections = detectAgents(cwd)
  const found = detections.filter((d) => d.found)

  const explicit = args._.slice(1).map(resolveAgentId)
  const agents = explicit.length ? explicit : found.map((d) => d.id)

  if (json) {
    process.stdout.write(JSON.stringify({ target, exists: existsSync(target), detections, agents }, null, 2) + '\n')
    if (existsSync(target) && !args.flags.force) return
  } else {
    if (existsSync(target) && !args.flags.force) {
      process.stdout.write(`${sym.warn} ${c.bold(rel(target, cwd))} already exists. Pass ${c.cyan('--force')} to overwrite.\n`)
      return
    }
    process.stdout.write(`\n${c.bold('Detected agents')}\n`)
    if (found.length === 0) {
      process.stdout.write(`  ${c.gray('none found — listing all agents with `hook-factory list --agents`')}\n`)
    }
    for (const d of found) {
      process.stdout.write(`  ${sym.ok} ${d.name.padEnd(24)} ${c.gray(d.evidence.join(', '))}\n`)
    }
  }

  if (agents.length === 0) agents.push('claude-code')

  await mkdir(join(target, '..'), { recursive: true })
  await writeFile(target, TEMPLATE(agents), 'utf8')

  await ensureGitignore(cwd)

  if (!json) {
    process.stdout.write(`\n${sym.ok} wrote ${c.bold(rel(target, cwd))} for ${c.cyan(agents.join(', '))}\n`)
    process.stdout.write(`\n${c.bold('Next')}\n`)
    process.stdout.write(`  ${c.dim('$')} npx hook-factory sync --dry-run   ${c.gray('# see exactly what it would write')}\n`)
    process.stdout.write(`  ${c.dim('$')} npx hook-factory sync\n`)
    process.stdout.write(`  ${c.dim('$')} npx hook-factory ui               ${c.gray('# or do it all interactively')}\n\n`)
  }
}

/** The audit log and any local state belong to the machine, not the repo. */
async function ensureGitignore(cwd: string): Promise<void> {
  const path = join(cwd, '.gitignore')
  const entry = '.hookfactory/'
  if (!existsSync(path)) return
  const text = await readFile(path, 'utf8')
  if (text.includes(entry)) return
  await writeFile(path, `${text.replace(/\n*$/, '\n')}\n# hook-factory local state\n${entry}\n`, 'utf8')
}

function rel(p: string, cwd: string): string {
  return p.startsWith(cwd) ? p.slice(cwd.length + 1) : p
}

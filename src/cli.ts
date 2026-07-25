#!/usr/bin/env node
import { cmdInit } from './commands/init.js'
import { cmdSync } from './commands/sync.js'
import { cmdList } from './commands/list.js'
import { cmdDoctor } from './commands/doctor.js'
import { cmdRun } from './commands/run.js'
import { cmdAdd, cmdRemovePlugin } from './commands/add.js'
import { cmdAgent } from './commands/agent.js'
import { cmdTest } from './commands/test.js'
import { c } from './core/ui.js'

const HELP = `${c.bold('hook-factory')} — one hook config, every coding agent

${c.bold('Usage')}
  hook-factory <command> [options]        ${c.dim('(aliased as `hf`)')}

${c.bold('Getting started')}
  init [agents...]      Create hooks.config, detecting agents you already use
  sync                  Compile your hooks into every agent's native config
  doctor                Check what's installed, wired up, and actually blocking

${c.bold('Agents')}
  agent list            Every supported agent, and which ones you've enabled
  agent add <id...>     Enable an agent  ${c.dim('(--detected for everything on this machine)')}
  agent remove <id...>  Disable an agent
  agent detect          Scan this machine for agents you already have
  agent info <id>       Events, blocking capability, config paths, caveats

${c.bold('Hooks')}
  add <plugin>          Add a built-in plugin to your config
  remove <plugin>       Take one back out
  list                  Show hooks, plugins, agents, and the capability matrix
  test <event>          Fire a synthetic event through your hooks, changing nothing

${c.bold('Runtime')}
  run --agent <id> --event <name>
                        Dispatcher the agents call. You won't run this by hand.
  unsync                Remove every hook-factory block from agent configs

${c.bold('Options')}
  --config <path>       Use a specific hooks.config file
  --scope project|user  Write repo-local or home-dir config (default: project)
  --agent <id>          Limit to one agent
  --dry-run             Show what would change, write nothing
  --json                Machine-readable output
  -h, --help            This
  -v, --version         Print version

${c.bold('Examples')}
  ${c.dim('$')} npx hook-factory init
  ${c.dim('$')} npx hook-factory agent add cursor gemini-cli
  ${c.dim('$')} npx hook-factory add secret-guard
  ${c.dim('$')} npx hook-factory sync --dry-run
  ${c.dim('$')} npx hook-factory test preToolUse --tool Bash --command "rm -rf /"
`

export interface Args {
  _: string[]
  flags: Record<string, string | boolean>
}

export function parseArgs(argv: string[]): Args {
  const _: string[] = []
  const flags: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a.startsWith('--')) {
      const [k, inline] = a.slice(2).split('=', 2)
      if (!k) continue
      if (inline !== undefined) flags[k] = inline
      else if (argv[i + 1] && !argv[i + 1]!.startsWith('-')) flags[k] = argv[++i]!
      else flags[k] = true
    } else if (a.startsWith('-') && a.length > 1) {
      const k = a.slice(1)
      flags[k] = true
    } else {
      _.push(a)
    }
  }
  return { _, flags }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const cmd = args._[0]

  if (args.flags.v || args.flags.version) {
    const { readFile } = await import('node:fs/promises')
    const { fileURLToPath } = await import('node:url')
    const { dirname, join } = await import('node:path')
    const pkgPath = join(dirname(dirname(fileURLToPath(import.meta.url))), 'package.json')
    const pkg = JSON.parse(await readFile(pkgPath, 'utf8')) as { version: string }
    process.stdout.write(`${pkg.version}\n`)
    return
  }

  if (!cmd || args.flags.h || args.flags.help) {
    process.stdout.write(HELP)
    return
  }

  switch (cmd) {
    case 'init':
      return cmdInit(args)
    case 'sync':
      return cmdSync(args, 'sync')
    case 'unsync':
      return cmdSync(args, 'remove')
    case 'agent':
    case 'agents':
      return cmdAgent(args)
    case 'list':
    case 'ls':
      return cmdList(args)
    case 'doctor':
    case 'check':
      return cmdDoctor(args)
    case 'run':
      return cmdRun(args)
    case 'add':
      return cmdAdd(args)
    case 'remove':
    case 'rm':
      return cmdRemovePlugin(args)
    case 'test':
      return cmdTest(args)
    default:
      process.stderr.write(`${c.red('unknown command')} \`${cmd}\`\n\n${HELP}`)
      process.exitCode = 1
  }
}

main().catch((e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e)
  process.stderr.write(`${c.red('error')} ${msg}\n`)
  process.exitCode = 1
})

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { arch, platform } from 'node:os'
import type { Args } from '../cli.js'
import { c, sym } from '../core/ui.js'

/**
 * The TUI is a Go binary (Bubble Tea) that drives this same CLI over its `--json`
 * interface. Shipping it separately keeps `npx hook-factory sync` a dependency-free
 * Node process while the interactive surface gets a real terminal UI framework.
 */
export async function cmdUi(args: Args): Promise<void> {
  const bin = findBinary()
  if (!bin) {
    process.stderr.write(
      `${sym.warn} ${c.bold('TUI binary not found')}\n\n` +
        `  The interactive UI is a small Go program built with Bubble Tea.\n` +
        `  Build it from a checkout:\n\n` +
        `    ${c.dim('$')} cd tui && go build -o ../bin/hook-factory-tui .\n\n` +
        `  Or set ${c.cyan('HOOK_FACTORY_TUI')} to its path.\n` +
        `  Everything the TUI does is available as a flag-driven command:\n` +
        `    ${c.dim('$')} hook-factory list      ${c.gray('# agents, plugins, capability matrix')}\n` +
        `    ${c.dim('$')} hook-factory sync --dry-run\n` +
        `    ${c.dim('$')} hook-factory doctor\n\n`,
    )
    process.exitCode = 1
    return
  }

  const self = process.argv[1] ?? 'hook-factory'
  const child = spawn(bin, args._.slice(1), {
    stdio: 'inherit',
    env: {
      ...process.env,
      // The TUI shells back into this exact CLI so the two can never drift.
      HOOK_FACTORY_CLI: `${process.execPath} ${self}`,
      HOOK_FACTORY_CWD: process.cwd(),
    },
  })
  await new Promise<void>((resolve) => {
    child.on('close', (code) => {
      process.exitCode = code ?? 0
      resolve()
    })
    child.on('error', (e) => {
      process.stderr.write(`${c.red('could not launch TUI')} ${e.message}\n`)
      process.exitCode = 1
      resolve()
    })
  })
}

function findBinary(): string | undefined {
  if (process.env.HOOK_FACTORY_TUI && existsSync(process.env.HOOK_FACTORY_TUI)) return process.env.HOOK_FACTORY_TUI
  const here = dirname(fileURLToPath(import.meta.url))
  const root = dirname(here) // dist/
  const candidates = [
    join(root, '..', 'bin', 'hook-factory-tui'),
    join(root, '..', 'bin', `hook-factory-tui-${platform()}-${arch()}`),
    join(root, '..', 'tui', 'hook-factory-tui'),
  ]
  return candidates.find((p) => existsSync(p))
}

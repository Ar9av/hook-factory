import { readFile, writeFile } from 'node:fs/promises'
import type { Args } from '../cli.js'
import { findConfig } from '../core/config.js'
import { PLUGIN_CATALOG, type BuiltinPluginName } from '../plugins/index.js'
import { c, sym } from '../core/ui.js'

/** camelCase export name for a kebab-case plugin id. */
const EXPORT_NAMES: Record<BuiltinPluginName, string> = {
  'secret-guard': 'secretGuard',
  'no-rm-rf': 'dangerousCommands',
  'protect-paths': 'protectPaths',
  'audit-log': 'auditLog',
  'auto-format': 'autoFormat',
  'test-gate': 'testGate',
  'notify-on-finish': 'notifyOnFinish',
  'context-inject': 'contextInject',
  'branch-guard': 'branchGuard',
  'prompt-scrub': 'promptScrub',
}

/**
 * Editing someone's config file for them is a small thing that removes a real
 * papercut — nobody should have to look up an import path to switch a guardrail
 * on. We do it with targeted string surgery so formatting and comments survive.
 */
export async function cmdAdd(args: Args): Promise<void> {
  const name = args._[1] as BuiltinPluginName | undefined
  if (!name) {
    process.stdout.write(`${c.bold('usage')} hook-factory add <plugin>\n\n`)
    for (const p of PLUGIN_CATALOG) process.stdout.write(`  ${c.cyan(p.name.padEnd(18))} ${c.gray(p.description)}\n`)
    process.stdout.write('\n')
    return
  }
  const entry = PLUGIN_CATALOG.find((p) => p.name === name)
  if (!entry) throw new Error(`no built-in plugin "${name}". Run \`hook-factory add\` to see the list.`)

  const path = (args.flags.config as string) ?? findConfig()
  if (!path) throw new Error('no hooks.config.ts found — run `hook-factory init` first')

  const src = await readFile(path, 'utf8')
  const exportName = EXPORT_NAMES[name]

  if (new RegExp(`\\b${exportName}\\s*\\(`).test(src)) {
    process.stdout.write(`${sym.dot} ${c.gray(`${name} is already in ${path}`)}\n`)
    return
  }

  let next = addImport(src, exportName)
  next = addToHooks(next, entry.example)
  await writeFile(path, next, 'utf8')

  process.stdout.write(`${sym.ok} added ${c.cyan(name)} to ${c.bold(path)}\n`)
  if (entry.needsOptions) {
    process.stdout.write(`  ${c.yellow('!')} ${c.gray(`${name} needs options — edit the call: ${entry.example}`)}\n`)
  }
  process.stdout.write(`  ${c.gray('then run')} ${c.dim('npx hook-factory sync')}\n`)
}

export async function cmdRemovePlugin(args: Args): Promise<void> {
  const name = args._[1] as BuiltinPluginName | undefined
  if (!name) throw new Error('usage: hook-factory remove <plugin>')
  const exportName = EXPORT_NAMES[name]
  if (!exportName) throw new Error(`no built-in plugin "${name}"`)

  const path = (args.flags.config as string) ?? findConfig()
  if (!path) throw new Error('no hooks.config.ts found')
  const src = await readFile(path, 'utf8')

  // Drop the call line and the named import, leaving everything else alone.
  const withoutCall = src
    .split('\n')
    .filter((l) => !new RegExp(`^\\s*${exportName}\\s*\\(.*\\),?\\s*$`).test(l))
    .join('\n')
  const withoutImport = withoutCall.replace(
    /(import\s*\{)([^}]*)(\}\s*from\s*['"]hook-factory\/plugins['"])/,
    (_m, a: string, names: string, z: string) => {
      const kept = names
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s && s !== exportName)
      return kept.length ? `${a} ${kept.join(', ')} ${z}` : ''
    },
  )

  if (withoutImport === src) {
    process.stdout.write(`${sym.dot} ${c.gray(`${name} was not in ${path}`)}\n`)
    return
  }
  await writeFile(path, withoutImport.replace(/\n{3,}/g, '\n\n'), 'utf8')
  process.stdout.write(`${sym.ok} removed ${c.cyan(name)} from ${c.bold(path)}\n`)
}

function addImport(src: string, exportName: string): string {
  const re = /(import\s*\{)([^}]*)(\}\s*from\s*['"]hook-factory\/plugins['"])/
  if (re.test(src)) {
    return src.replace(re, (_m, a: string, names: string, z: string) => {
      const list = names
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      if (!list.includes(exportName)) list.push(exportName)
      return `${a} ${list.join(', ')} ${z}`
    })
  }
  const line = `import { ${exportName} } from 'hook-factory/plugins'\n`
  const lastImport = [...src.matchAll(/^import .*$/gm)].pop()
  if (lastImport?.index !== undefined) {
    const end = lastImport.index + lastImport[0].length
    return src.slice(0, end) + '\n' + line.trimEnd() + src.slice(end)
  }
  return line + src
}

function addToHooks(src: string, call: string): string {
  const i = src.indexOf('hooks: [')
  if (i === -1) throw new Error('could not find a `hooks: [` array in your config — add the plugin by hand')
  const insertAt = i + 'hooks: ['.length
  return `${src.slice(0, insertAt)}\n    ${call},${src.slice(insertAt)}`
}

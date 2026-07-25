import { existsSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { HookFactoryConfig, ResolvedConfig } from './types.js'

export const CONFIG_NAMES = [
  'hooks.config.ts',
  'hooks.config.mts',
  'hooks.config.js',
  'hooks.config.mjs',
  '.hookfactory/hooks.config.ts',
  '.hookfactory/hooks.config.js',
]

/** Walk up from `start` looking for a config, stopping at the git root or `/`. */
export function findConfig(start = process.cwd()): string | undefined {
  let dir = resolve(start)
  for (;;) {
    for (const name of CONFIG_NAMES) {
      const p = join(dir, name)
      if (existsSync(p)) return p
    }
    if (existsSync(join(dir, '.git'))) break
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

/**
 * Load the user's config. `.ts` works without a build step on Node >=22.6 via
 * native type stripping; older Node gets a clear message rather than a stack
 * trace about unexpected token `:`.
 */
export async function loadConfig(path?: string): Promise<ResolvedConfig> {
  const configPath = path ?? findConfig()
  if (!configPath) {
    throw new Error('no hooks.config.ts found — run `hook-factory init` to create one')
  }
  if (!existsSync(configPath)) {
    throw new Error(`config not found: ${configPath}`)
  }

  let mod: { default?: HookFactoryConfig }
  try {
    mod = (await import(pathToFileURL(configPath).href)) as { default?: HookFactoryConfig }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    // Two different failures produce confusing messages here, and both have a
    // one-line fix, so it's worth telling people which one they hit.
    if (/Cannot use import statement outside a module|ERR_REQUIRE_ESM/.test(msg)) {
      throw new Error(
        `could not load ${configPath}: this project is CommonJS, so Node loads a .ts file as CommonJS and the imports fail.\n` +
          `Fix it either way:\n` +
          `  · rename it to hooks.config.mts  (always ESM, no package.json change)\n` +
          `  · or add "type": "module" to package.json`,
      )
    }
    if (/\.[cm]?ts$/.test(configPath) && /Unknown file extension|Unexpected token|ERR_UNKNOWN_FILE_EXTENSION/.test(msg)) {
      throw new Error(
        `could not load ${configPath}: this Node (${process.version}) cannot import TypeScript directly.\n` +
          `Either upgrade to Node >= 22.6, or rename your config to hooks.config.mjs and drop the type annotations.`,
      )
    }
    throw new Error(`could not load ${configPath}: ${msg}`)
  }

  const config = mod.default
  if (!config || !Array.isArray(config.hooks)) {
    throw new Error(`${configPath} must \`export default defineHooks({ ... })\``)
  }

  return {
    ...config,
    hooks: config.hooks,
    scope: config.scope ?? 'project',
    projectDir: dirname(configPath),
    configPath,
  }
}

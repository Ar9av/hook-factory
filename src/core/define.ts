import type { Adapter, Hook, HookFactoryConfig, Plugin } from './types.js'

/**
 * The entrypoint of a `hooks.config.ts`. Accepts hooks and plugins in one flat
 * `hooks` array so people don't have to think about which bucket a thing goes
 * in — a plugin is just a bag of hooks and we flatten it here.
 */
export function defineHooks(config: DefineHooksInput): HookFactoryConfig {
  const hooks: Hook[] = []
  const plugins: Plugin[] = []

  for (const item of config.hooks ?? []) {
    if (isPlugin(item)) {
      plugins.push(item)
      for (const h of item.hooks) {
        hooks.push({ ...h, plugin: item.name, id: h.id.includes('/') ? h.id : `${item.name}/${h.id}` })
      }
    } else {
      hooks.push(item)
    }
  }

  for (const p of config.plugins ?? []) {
    plugins.push(p)
    for (const h of p.hooks) {
      hooks.push({ ...h, plugin: p.name, id: h.id.includes('/') ? h.id : `${p.name}/${h.id}` })
    }
  }

  return {
    agents: config.agents ?? [],
    hooks,
    plugins,
    scope: config.scope ?? 'project',
    runner: config.runner,
    adapters: config.adapters,
  }
}

export interface DefineHooksInput {
  /** Agent ids to install into, e.g. `['claude-code', 'codex']`. */
  agents?: string[]
  /** Hooks and/or plugins, mixed freely. */
  hooks?: (Hook | Plugin)[]
  plugins?: Plugin[]
  scope?: 'project' | 'user'
  runner?: string
  adapters?: Adapter[]
}

function isPlugin(v: Hook | Plugin): v is Plugin {
  return Array.isArray((v as Plugin).hooks)
}

/** Author a shareable plugin. */
export function definePlugin(p: Plugin): Plugin {
  return p
}

/** Author support for an agent hook-factory doesn't ship. */
export function defineAdapter(a: Adapter): Adapter {
  return a
}

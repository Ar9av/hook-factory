/**
 * hook-factory — one hook config, every coding agent.
 *
 * ```ts
 * import { defineHooks, onPreToolUse, match, deny } from 'hook-factory'
 *
 * export default defineHooks({
 *   agents: ['claude-code', 'codex', 'cursor'],
 *   hooks: [onPreToolUse(match.shell(/rm -rf/), deny('not today'))],
 * })
 * ```
 */

export { defineHooks, definePlugin, defineAdapter } from './core/define.js'
export type { DefineHooksInput } from './core/define.js'

export {
  on,
  onSessionStart,
  onSessionEnd,
  onUserPromptSubmit,
  onPreToolUse,
  onPostToolUse,
  onPostToolUseFailure,
  onPermissionRequest,
  onPreShell,
  onPostShell,
  onPreReadFile,
  onPostFileEdit,
  onPreModel,
  onPostModel,
  onSubagentStart,
  onSubagentStop,
  onPreCompact,
  onPostCompact,
  onNotification,
  onStop,
  CANONICAL_EVENTS,
  EVENT_DOCS,
} from './core/events.js'
export type { HookOptions } from './core/events.js'

export { match, commandOf, pathOf, contentOf, globToRegExp, SHELL_TOOLS, EDIT_TOOLS, READ_TOOLS } from './core/match.js'

export { deny, allow, ask, inject, warn, keepGoing, shell, appendFile, notify, all, when, noop } from './core/actions.js'
export type { ShellOptions, NotifyOptions, NotifyTarget } from './core/actions.js'

export {
  BUILTIN_ADAPTERS,
  buildRegistry,
  resolveAgentId,
  capabilities,
  claudeStyle,
  snippetAdapter,
} from './adapters/index.js'
export type { Capability, ClaudeStyleSpec, SnippetSpec } from './adapters/index.js'

export { loadConfig, findConfig, CONFIG_NAMES } from './core/config.js'
export { planSync, applyPlan, resolveRunner, diff } from './core/sync.js'
export type { SyncPlan, AgentPlan, PlannedWrite } from './core/sync.js'
export { dispatch, reduceDecisions, readStdin } from './core/runtime.js'

export { BLOCKABLE_EVENTS } from './core/types.js'
export type {
  Adapter,
  AdapterStatus,
  CanonicalEvent,
  ConfigFormat,
  Decision,
  EmitResult,
  ExecResult,
  Hook,
  HookContext,
  HookEvent,
  HookFactoryConfig,
  HookHandler,
  InstallMode,
  Matcher,
  Plugin,
  PluginFactory,
  RenderContext,
  RenderResult,
  RenderedFile,
  RenderedSnippet,
  ResolvedConfig,
  Scope,
} from './core/types.js'

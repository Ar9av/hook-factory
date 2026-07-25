/**
 * hook-factory core types.
 *
 * The whole framework hangs off one idea: every coding agent's hook system is a
 * different spelling of the same handful of lifecycle moments. We define those
 * moments once (`CanonicalEvent`), let people write handlers against a single
 * normalized payload (`HookEvent`), and let adapters translate both directions.
 */

/** The universal lifecycle moments hook-factory knows how to talk about. */
export const CANONICAL_EVENTS = [
  'sessionStart',
  'sessionEnd',
  'userPromptSubmit',
  'preToolUse',
  'postToolUse',
  'postToolUseFailure',
  'permissionRequest',
  'preShell',
  'postShell',
  'preReadFile',
  'postFileEdit',
  'preModel',
  'postModel',
  'subagentStart',
  'subagentStop',
  'preCompact',
  'postCompact',
  'notification',
  'stop',
] as const

export type CanonicalEvent = (typeof CANONICAL_EVENTS)[number]

/**
 * Events where a `deny()` can actually stop something from happening, on at
 * least one agent. The `post*` entries are the interesting ones: Gemini CLI's
 * `AfterModel` and `AfterTool` accept `decision: deny` to suppress a result the
 * model would otherwise see. That is not prevention, but it is not a no-op
 * either, so hooks there are worth honouring.
 */
export const BLOCKABLE_EVENTS: readonly CanonicalEvent[] = [
  'userPromptSubmit',
  'preToolUse',
  'postToolUse',
  'permissionRequest',
  'preShell',
  'preReadFile',
  'preModel',
  'postModel',
  'subagentStart',
  'subagentStop',
  'stop',
]

/**
 * A normalized hook payload. Adapters fill in whatever their agent gives them;
 * everything is optional because no two agents send the same fields, and a
 * handler that reads `ev.command` should work whether the agent surfaced it as
 * `tool_input.command`, `toolCall.args.CommandLine`, or a dedicated shell event.
 */
export interface HookEvent {
  /** The canonical event this maps to. */
  event: CanonicalEvent
  /** Which agent produced it, e.g. `claude-code`. */
  agent: string
  /** The agent's own name for this event, e.g. `PreToolUse` or `beforeShellExecution`. */
  nativeEvent: string
  /** Agent-side session/conversation id, when provided. */
  sessionId?: string
  /** Working directory the agent is operating in. */
  cwd: string
  /** Tool name as the agent spells it (`Bash`, `terminal`, `run_shell_command`, ...). */
  toolName?: string
  /** Tool arguments, normalized to a plain object. */
  toolInput?: Record<string, unknown>
  /** Tool result, for post-* events. */
  toolOutput?: unknown
  /** Error text, for failure events. */
  error?: string
  /** Shell command, extracted from whichever field the agent used. */
  command?: string
  /** File path touched by the event, extracted the same way. */
  filePath?: string
  /** The user's prompt text, for `userPromptSubmit`. */
  prompt?: string
  /** Model id, when the agent reports it. */
  model?: string
  /** Path to the session transcript, when the agent reports it. */
  transcriptPath?: string
  /** The agent's permission mode string, verbatim. */
  permissionMode?: string
  /** The untouched stdin JSON, for anything we didn't normalize. */
  raw: Record<string, unknown>
}

/** What a handler can decide. `undefined` means "no opinion, carry on". */
export type Decision =
  | { kind: 'allow'; reason?: string }
  | { kind: 'deny'; reason: string }
  | { kind: 'ask'; reason?: string }
  | { kind: 'context'; text: string }
  | { kind: 'warn'; message: string }
  | { kind: 'continue'; message?: string }
  | undefined
  | void

export type MaybePromise<T> = T | Promise<T>

/** Context handed to every handler, so hooks can do useful side effects. */
export interface HookContext {
  /** Log to stderr — safe on every agent, since stdout is the decision channel. */
  log(...args: unknown[]): void
  /** Run a shell command; returns exit code and captured output. */
  exec(cmd: string, opts?: { cwd?: string; timeoutMs?: number }): Promise<ExecResult>
  /** Absolute path to the project root hook-factory resolved. */
  projectDir: string
  /** Per-hook options, as configured in `hooks.config.ts`. */
  options: Record<string, unknown>
}

export interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

export type HookHandler = (ev: HookEvent, ctx: HookContext) => MaybePromise<Decision>

/** A predicate over the normalized event. Returned by everything in `match`. */
export type Matcher = (ev: HookEvent) => boolean

/** One registered hook. This is what `onPreToolUse(...)` and friends produce. */
export interface Hook {
  /** Stable id, used in logs and `hf list`. */
  id: string
  /** Human-facing one-liner. */
  description?: string
  event: CanonicalEvent
  match?: Matcher
  handler: HookHandler
  /** Restrict this hook to specific agents; omit to run on all configured ones. */
  agents?: string[]
  /** Per-hook timeout in ms, passed through to the native config where supported. */
  timeoutMs?: number
  /** Set false to keep it in config but skip execution. */
  enabled?: boolean
  /** Which plugin contributed it, if any. */
  plugin?: string
  /**
   * A hint for adapters that support native tool-name matchers, so we can push
   * filtering down into the agent instead of paying a process spawn per call.
   */
  toolMatcher?: string
}

/** A shareable bundle of hooks. The unit of the plugin ecosystem. */
export interface Plugin {
  name: string
  description?: string
  version?: string
  hooks: Hook[]
  /** Default options merged into every hook's `ctx.options`. */
  options?: Record<string, unknown>
}

export type PluginFactory<O = Record<string, unknown>> = (options?: O) => Plugin

/** Where an adapter writes, and in what dialect. */
export type ConfigFormat = 'json' | 'json5' | 'toml' | 'yaml' | 'js'

export type AdapterStatus = 'supported' | 'partial' | 'unsupported'

/**
 * How hook-factory installs into a given agent.
 * - `write`   — we own a managed block in the agent's real config file.
 * - `snippet` — the format is too lossy/handwritten to edit safely, so we print
 *               a block for the user to paste, and say exactly where.
 * - `none`    — the agent has no hook system; we explain the closest alternative.
 */
export type InstallMode = 'write' | 'snippet' | 'none'

export interface Scope {
  /** Path relative to project root, or absolute (may start with `~`). */
  file: string
  format: ConfigFormat
}

export interface RenderContext {
  /** Hooks that survived agent filtering, already sorted. */
  hooks: Hook[]
  /** The command that invokes the hook-factory runtime, minus event args. */
  runner: string
  projectDir: string
  scope: 'project' | 'user'
}

export interface RenderedFile {
  /** Resolved absolute path we intend to write. */
  path: string
  format: ConfigFormat
  /** Merge our managed content into the file's existing parsed value. */
  apply(existing: unknown): unknown
  /** Strip our managed content back out. Used by `hf remove`. */
  revert(existing: unknown): unknown
}

export interface RenderedSnippet {
  /** Where the user should paste it. */
  path: string
  format: ConfigFormat
  content: string
  instructions: string
}

export interface RenderResult {
  files: RenderedFile[]
  snippets: RenderedSnippet[]
  /** Extra sidecar files (plugin shims, hook scripts) written verbatim. */
  extras: { path: string; content: string; mode?: number }[]
}

export interface EmitResult {
  stdout?: string
  stderr?: string
  code: number
}

export interface Adapter {
  /** Matches the directory name in agent-manual/tools. */
  id: string
  name: string
  status: AdapterStatus
  install: InstallMode
  /** Link to the tool's hook docs. */
  docs?: string
  /** Caveats worth surfacing in `hf doctor` and `hf agent info`. */
  notes?: string[]
  /** canonical -> the agent's native event name. Absent key = unsupported event. */
  events: Partial<Record<CanonicalEvent, string>>
  /** Canonical events where this agent's deny actually blocks. */
  blocking: readonly CanonicalEvent[]
  scopes: Partial<Record<'project' | 'user', Scope>>
  /** Build the native config. */
  render(ctx: RenderContext): RenderResult
  /** Normalize the agent's stdin JSON into a `HookEvent`. */
  parse(raw: Record<string, unknown>, nativeEvent: string): HookEvent
  /** Turn a decision back into the agent's stdout/exit-code contract. */
  emit(decision: Decision, ev: HookEvent): EmitResult
}

export interface HookFactoryConfig {
  /** Agent ids to install into. */
  agents: string[]
  hooks: Hook[]
  plugins?: Plugin[]
  /** `project` writes into the repo, `user` into the home-dir config. */
  scope?: 'project' | 'user'
  /** Override the command used to invoke the runtime from native configs. */
  runner?: string
  /** Extra adapters, for agents hook-factory doesn't ship. */
  adapters?: Adapter[]
}

/** The fully-resolved config, after plugins are flattened into `hooks`. */
export interface ResolvedConfig extends HookFactoryConfig {
  hooks: Hook[]
  scope: 'project' | 'user'
  projectDir: string
  configPath: string
}

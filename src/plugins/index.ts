import { definePlugin } from '../core/define.js'
import { onPostFileEdit, onPostToolUse, onPreToolUse, onSessionStart, onStop, onUserPromptSubmit } from '../core/events.js'
import { commandOf, contentOf, match, pathOf, globToRegExp } from '../core/match.js'
import { appendFile, deny, inject, keepGoing, notify, shell, warn } from '../core/actions.js'
import type { HookEvent, Plugin } from '../core/types.js'

/**
 * The built-in plugin pack. Each of these is a plain `definePlugin` call with no
 * privileged access — they're written against exactly the API a third-party
 * plugin would use, which keeps the public surface honest.
 */

// --- secret-guard ----------------------------------------------------------

const SECRET_PATTERNS: { name: string; re: RegExp }[] = [
  { name: 'AWS access key id', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: 'Slack token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'Stripe secret key', re: /\bsk_live_[0-9a-zA-Z]{16,}\b/ },
  { name: 'OpenAI API key', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/ },
  { name: 'Anthropic API key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'private key block', re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { name: 'JWT', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
]

/** Files that legitimately hold secrets and should never be read into context. */
const DEFAULT_SECRET_FILES = ['.env', '.env.*', '*.pem', '*.key', 'id_rsa', 'id_ed25519', '.npmrc', '.netrc', 'credentials']

export interface SecretGuardOptions {
  /** Extra regexes to treat as secrets. */
  patterns?: { name: string; re: RegExp }[]
  /** Globs the agent must not read. */
  files?: string[]
  /** Warn instead of blocking. */
  warnOnly?: boolean
}

/**
 * Stops credentials moving in either direction: blocks writes that would commit
 * a secret, and blocks reads of files whose whole job is holding one.
 */
export const secretGuard = (options: SecretGuardOptions = {}): Plugin => {
  const patterns = [...SECRET_PATTERNS, ...(options.patterns ?? [])]
  const files = options.files ?? DEFAULT_SECRET_FILES
  const react = options.warnOnly ? warn : deny

  const scan = (ev: HookEvent): string | undefined => {
    const haystack = [contentOf(ev), commandOf(ev)].filter(Boolean).join('\n')
    if (!haystack) return undefined
    for (const p of patterns) if (p.re.test(haystack)) return p.name
    return undefined
  }

  return definePlugin({
    name: 'secret-guard',
    description: 'Block writes containing credentials, and reads of secret-bearing files',
    hooks: [
      onPreToolUse(
        match.where((ev) => scan(ev) !== undefined),
        (ev, ctx) => react(`hook-factory/secret-guard: this looks like a ${scan(ev)}. Do not write credentials into the repo — reference an env var instead.`)(ev, ctx),
        { id: 'block-secret-writes', description: 'Block tool calls whose payload contains a credential' },
      ),
      onPreToolUse(
        match.and(
          match.read(),
          match.where((ev) => {
            const p = pathOf(ev)
            return p !== undefined && files.some((g) => globToRegExp(g).test(p))
          }),
        ),
        react(`hook-factory/secret-guard: reading {{filePath}} would pull credentials into the model's context. Read the variable names from a .env.example instead.`),
        { id: 'block-secret-reads', description: 'Block reads of .env, private keys, and similar' },
      ),
    ],
    options: options as Record<string, unknown>,
  })
}

// --- no-rm-rf --------------------------------------------------------------

export interface DangerousCommandsOptions {
  /** Additional regexes to refuse. */
  patterns?: RegExp[]
  warnOnly?: boolean
}

const DANGEROUS: { re: RegExp; why: string }[] = [
  // Recursive and force can arrive bundled (-rf, -fr), separated (-r -f), or
  // long-form (--recursive --force), in either order. Checking for both flags
  // anywhere in the argument run catches all of it; checking one combined
  // token — which an earlier version did — misses `rm -r -f`.
  { re: /\brm\s+(?=(?:\s*-{1,2}[a-zA-Z-]+)*\s*-{1,2}(?:[a-zA-Z]*[rR]|-recursive))(?=(?:\s*-{1,2}[a-zA-Z-]+)*\s*-{1,2}(?:[a-zA-Z]*[fF]|-force))/, why: 'recursive force delete' },
  { re: /\bgit\s+(push\s+.*--force(?!-with-lease)|push\s+-f\b)/, why: 'force push without --force-with-lease' },
  { re: /\bgit\s+reset\s+--hard\b/, why: 'hard reset discards uncommitted work' },
  { re: /\bgit\s+clean\s+-[a-zA-Z]*f/, why: 'git clean -f deletes untracked files irreversibly' },
  { re: /\b(mkfs|dd)\s+.*\bof=\/dev\//, why: 'writes directly to a block device' },
  { re: />\s*\/dev\/(sd|nvme|disk)/, why: 'redirects into a raw disk' },
  { re: /\bchmod\s+(-R\s+)?777\b/, why: 'world-writable permissions' },
  { re: /\bcurl\b[^|]*\|\s*(sudo\s+)?(ba)?sh\b/, why: 'pipes a remote script straight into a shell' },
  { re: /\bDROP\s+(TABLE|DATABASE)\b/i, why: 'destructive SQL' },
  { re: /\bkubectl\s+delete\s+.*--all\b/, why: 'deletes every resource in the namespace' },
  { re: /\bterraform\s+destroy\b/, why: 'tears down infrastructure' },
]

/** Refuses the shell commands that generate the "wait, no—" moment. */
export const dangerousCommands = (options: DangerousCommandsOptions = {}): Plugin => {
  const extra = (options.patterns ?? []).map((re) => ({ re, why: 'matched a user-configured deny pattern' }))
  const all = [...DANGEROUS, ...extra]
  const find = (ev: HookEvent) => {
    const cmd = commandOf(ev)
    if (!cmd) return undefined
    return all.find((d) => d.re.test(cmd))
  }
  const react = options.warnOnly ? warn : deny
  return definePlugin({
    name: 'no-rm-rf',
    description: 'Refuse destructive shell commands (rm -rf, force push, hard reset, curl | sh, ...)',
    hooks: [
      onPreToolUse(
        match.where((ev) => find(ev) !== undefined),
        (ev, ctx) =>
          react(
            `hook-factory/no-rm-rf: refusing \`${commandOf(ev)}\` — ${find(ev)?.why}. If you genuinely need this, ask the user to run it themselves.`,
          )(ev, ctx),
        { id: 'block-dangerous', description: 'Block destructive shell commands', toolMatcher: '*' },
      ),
    ],
    options: options as Record<string, unknown>,
  })
}

// --- protect-paths ---------------------------------------------------------

export interface ProtectPathsOptions {
  /** Globs the agent may not modify. */
  paths: string[]
  /** Also block reads, not just writes. */
  readToo?: boolean
  reason?: string
}

/** Makes files effectively read-only to the agent. */
export const protectPaths = (options: ProtectPathsOptions): Plugin =>
  definePlugin({
    name: 'protect-paths',
    description: `Make ${options.paths.join(', ')} off-limits to the agent`,
    hooks: [
      onPreToolUse(
        match.and(match.edit(), match.path(...options.paths)),
        deny(options.reason ?? 'hook-factory/protect-paths: {{filePath}} is protected. Change it yourself, or update the protect-paths config.'),
        { id: 'block-writes', description: 'Block edits to protected paths' },
      ),
      ...(options.readToo
        ? [
            onPreToolUse(match.and(match.read(), match.path(...options.paths)), deny('hook-factory/protect-paths: {{filePath}} is not readable by the agent.'), {
              id: 'block-reads',
              description: 'Block reads of protected paths',
            }),
          ]
        : []),
    ],
    options: options as unknown as Record<string, unknown>,
  })

// --- audit-log -------------------------------------------------------------

export interface AuditLogOptions {
  /** Where to append. Relative paths resolve against the project. */
  file?: string
  /** Log every tool call, not just shell and edits. */
  verbose?: boolean
}

/** Appends a JSONL trail of everything the agent did. */
export const auditLog = (options: AuditLogOptions = {}): Plugin => {
  const file = options.file ?? '.hookfactory/audit.jsonl'
  const line = (ev: HookEvent) =>
    JSON.stringify({
      ts: new Date().toISOString(),
      agent: ev.agent,
      event: ev.event,
      session: ev.sessionId,
      tool: ev.toolName,
      command: commandOf(ev),
      path: pathOf(ev),
    })
  return definePlugin({
    name: 'audit-log',
    description: `Append a JSONL record of agent activity to ${file}`,
    hooks: [
      onPreToolUse(options.verbose ? match.all() : match.or(match.shell(), match.edit()), appendFile(file, line), {
        id: 'record',
        description: 'Record tool calls',
      }),
    ],
    options: options as Record<string, unknown>,
  })
}

// --- auto-format -----------------------------------------------------------

export interface AutoFormatOptions {
  /** glob -> formatter command. `{{filePath}}` is interpolated. */
  formatters?: Record<string, string>
}

const DEFAULT_FORMATTERS: Record<string, string> = {
  '*.{ts,tsx,js,jsx,mjs,cjs,json,css,md,yaml,yml}': 'npx --no-install prettier --write "{{filePath}}"',
  '*.py': 'ruff format "{{filePath}}"',
  '*.go': 'gofmt -w "{{filePath}}"',
  '*.rs': 'rustfmt "{{filePath}}"',
}

/** Formats each file right after the agent writes it. */
export const autoFormat = (options: AutoFormatOptions = {}): Plugin => {
  const formatters = options.formatters ?? DEFAULT_FORMATTERS
  return definePlugin({
    name: 'auto-format',
    description: 'Run the right formatter after every file edit',
    hooks: Object.entries(formatters).map(([glob, cmd], i) =>
      onPostToolUse(match.edit(glob), shell(cmd), {
        id: `format-${i}`,
        description: `Format ${glob} with \`${cmd.split(' ')[0]}\``,
      }),
    ),
    options: options as Record<string, unknown>,
  })
}

// --- test-gate -------------------------------------------------------------

export interface TestGateOptions {
  /** Command to run before letting the agent stop. */
  command?: string
  /** Only gate when these globs were touched. Omit to always gate. */
  when?: string[]
}

/**
 * Won't let the agent declare victory while the test suite is red — the `stop`
 * hook feeds the failure back and the agent keeps working.
 */
export const testGate = (options: TestGateOptions = {}): Plugin => {
  const command = options.command ?? 'npm test'
  return definePlugin({
    name: 'test-gate',
    description: `Block the agent from stopping while \`${command}\` fails`,
    hooks: [
      onStop(
        async (ev, ctx) => {
          const res = await ctx.exec(command, { cwd: ev.cwd, timeoutMs: 10 * 60_000 })
          if (res.code === 0) return undefined
          const tail = (res.stderr || res.stdout).split('\n').slice(-40).join('\n')
          return {
            kind: 'continue',
            message: `hook-factory/test-gate: \`${command}\` is failing. Fix it before you stop.\n\n${tail}`,
          }
        },
        { id: 'gate', description: `Run \`${command}\` on stop`, timeoutMs: 10 * 60_000 },
      ),
    ],
    options: options as Record<string, unknown>,
  })
}

// --- notify-on-finish ------------------------------------------------------

export interface NotifyOnFinishOptions {
  target?: 'desktop' | 'slack' | 'stderr'
  webhook?: string
  message?: string
}

/** Pings you when the agent finishes, so long runs stop needing a babysitter. */
export const notifyOnFinish = (options: NotifyOnFinishOptions = {}): Plugin =>
  definePlugin({
    name: 'notify-on-finish',
    description: 'Send a notification when the agent finishes a turn',
    hooks: [
      onStop(notify(options.message ?? '{{agent}} finished in {{cwd}}', { target: options.target, webhook: options.webhook }), {
        id: 'ping',
        description: 'Notify on turn end',
      }),
    ],
    options: options as Record<string, unknown>,
  })

// --- context-inject --------------------------------------------------------

export interface ContextInjectOptions {
  /** Static text added at session start. */
  text?: string
  /** Or a command whose stdout is injected. */
  command?: string
}

/** Puts something in front of the model at the start of every session. */
export const contextInject = (options: ContextInjectOptions): Plugin =>
  definePlugin({
    name: 'context-inject',
    description: 'Inject project context at session start',
    hooks: [
      onSessionStart(
        options.command
          ? shell(options.command, { injectStdout: true })
          : inject(options.text ?? ''),
        { id: 'inject', description: 'Inject context on session start' },
      ),
    ],
    options: options as Record<string, unknown>,
  })

// --- branch-guard ----------------------------------------------------------

export interface BranchGuardOptions {
  /** Branches the agent may not commit to. */
  branches?: string[]
}

/** Keeps the agent from committing straight onto main. */
export const branchGuard = (options: BranchGuardOptions = {}): Plugin => {
  const protectedBranches = options.branches ?? ['main', 'master', 'production', 'release']
  return definePlugin({
    name: 'branch-guard',
    description: `Block commits on ${protectedBranches.join(', ')}`,
    hooks: [
      onPreToolUse(
        match.shell(/\bgit\s+(commit|push)\b/),
        async (ev, ctx) => {
          const res = await ctx.exec('git rev-parse --abbrev-ref HEAD', { cwd: ev.cwd })
          const branch = res.stdout.trim()
          if (!protectedBranches.includes(branch)) return undefined
          return {
            kind: 'deny',
            reason: `hook-factory/branch-guard: you're on \`${branch}\`, which is protected. Create a branch first: \`git checkout -b <name>\`.`,
          }
        },
        { id: 'block-protected-branch', description: 'Block git commit/push on protected branches' },
      ),
    ],
    options: options as Record<string, unknown>,
  })
}

// --- prompt-scrub ----------------------------------------------------------

/** Refuses to send a prompt that has a credential pasted into it. */
export const promptScrub = (): Plugin =>
  definePlugin({
    name: 'prompt-scrub',
    description: 'Block prompts that contain a pasted credential',
    hooks: [
      onUserPromptSubmit(
        match.where((ev) => SECRET_PATTERNS.some((p) => ev.prompt !== undefined && p.re.test(ev.prompt))),
        deny('hook-factory/prompt-scrub: that prompt contains what looks like a live credential. Rotate it, then reference it by name instead of pasting the value.'),
        { id: 'scrub', description: 'Block prompts containing secrets' },
      ),
    ],
  })

export const BUILTIN_PLUGINS = {
  'secret-guard': secretGuard,
  'no-rm-rf': dangerousCommands,
  'protect-paths': protectPaths,
  'audit-log': auditLog,
  'auto-format': autoFormat,
  'test-gate': testGate,
  'notify-on-finish': notifyOnFinish,
  'context-inject': contextInject,
  'branch-guard': branchGuard,
  'prompt-scrub': promptScrub,
} as const

export type BuiltinPluginName = keyof typeof BUILTIN_PLUGINS

/** Metadata for `hf list --plugins` and `hf add`. */
export const PLUGIN_CATALOG: { name: BuiltinPluginName; description: string; needsOptions: boolean; example: string }[] = [
  { name: 'secret-guard', description: 'Block writes containing credentials and reads of .env / key files', needsOptions: false, example: 'secretGuard()' },
  { name: 'no-rm-rf', description: 'Refuse rm -rf, force push, hard reset, curl | sh, terraform destroy', needsOptions: false, example: 'dangerousCommands()' },
  { name: 'protect-paths', description: 'Make chosen globs read-only to the agent', needsOptions: true, example: "protectPaths({ paths: ['migrations/**'] })" },
  { name: 'audit-log', description: 'Append a JSONL trail of every shell command and edit', needsOptions: false, example: 'auditLog()' },
  { name: 'auto-format', description: 'Run prettier/ruff/gofmt/rustfmt after each edit', needsOptions: false, example: 'autoFormat()' },
  { name: 'test-gate', description: "Won't let the agent stop while tests fail", needsOptions: false, example: "testGate({ command: 'npm test' })" },
  { name: 'notify-on-finish', description: 'Desktop or Slack ping when a turn ends', needsOptions: false, example: 'notifyOnFinish()' },
  { name: 'context-inject', description: 'Inject text or command output at session start', needsOptions: true, example: "contextInject({ command: 'git log --oneline -10' })" },
  { name: 'branch-guard', description: 'Block commits and pushes on main/master/production', needsOptions: false, example: 'branchGuard()' },
  { name: 'prompt-scrub', description: 'Refuse prompts with a pasted credential in them', needsOptions: false, example: 'promptScrub()' },
]

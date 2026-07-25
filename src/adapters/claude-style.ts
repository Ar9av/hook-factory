import type {
  Adapter,
  AdapterStatus,
  CanonicalEvent,
  ConfigFormat,
  Decision,
  EmitResult,
  HookEvent,
  RenderContext,
  RenderResult,
  Scope,
} from '../core/types.js'
import { expandPath } from '../core/fs.js'
import { mergeEventMap, revertEventMap, tag } from '../core/merge.js'

/**
 * Claude Code's hook config shape got copied — with small mutations — by about a
 * dozen agents. Rather than write twelve near-identical adapters, this factory
 * parameterises the differences: what the container key is called, whether
 * timeouts are seconds or milliseconds, whether the command field is `command`
 * or `bash`, and which events exist.
 */
export interface ClaudeStyleSpec {
  id: string
  name: string
  status?: AdapterStatus
  docs?: string
  notes?: string[]
  events: Partial<Record<CanonicalEvent, string>>
  blocking: readonly CanonicalEvent[]
  scopes: Partial<Record<'project' | 'user', Scope>>
  /** Key the event map nests under, or null when events sit at the file root. */
  container?: string | null
  /** Key holding the shell command on a hook entry. */
  commandKey?: string
  /** Timeout field name, and its unit. Omit to not emit timeouts at all. */
  timeout?: { key: string; unit: 'ms' | 's' }
  /** Some agents require a display `name` on each hook entry. */
  requireName?: boolean
  /** Extra fields merged into each hook entry. */
  extraHookFields?: Record<string, unknown>
  /** Extra fields merged into each matcher group. */
  extraGroupFields?: Record<string, unknown>
  /** Emitted at the file root, e.g. Cursor's `version: 1`. */
  rootFields?: Record<string, unknown>
  /** Events that ignore matchers, so we omit the key rather than emit a no-op. */
  noMatcherEvents?: string[]
  format?: ConfigFormat
  /** Override how a decision becomes stdout/exit code. */
  emit?: (decision: Decision, ev: HookEvent) => EmitResult
  /** Override payload normalization. */
  parse?: (raw: Record<string, unknown>, nativeEvent: string, id: string) => HookEvent
}

/** The exit-code contract nearly everyone in this family implements. */
export function claudeStyleEmit(decision: Decision, ev: HookEvent): EmitResult {
  if (!decision) return { code: 0 }
  switch (decision.kind) {
    case 'deny':
      // Exit 2 + stderr is the one path verified to actually block on every
      // agent in this family, and it hands the reason to the model so it can
      // adapt. The JSON permissionDecision is emitted alongside for the agents
      // that prefer to read it.
      //
      // Deliberately NOT sending `continue: false`: that ends the whole
      // session. Verified against Claude Code — with it, a blocked `whoami`
      // terminated the run (`terminal_reason: hook_stopped`) and the user got
      // an empty response instead of the model routing around the denial.
      // Blocking one tool call should cost one tool call.
      return {
        code: 2,
        stderr: decision.reason,
        stdout: JSON.stringify({
          decision: 'block',
          reason: decision.reason,
          hookSpecificOutput: {
            hookEventName: ev.nativeEvent,
            permissionDecision: 'deny',
            permissionDecisionReason: decision.reason,
          },
        }),
      }
    case 'ask':
      return {
        code: 0,
        stdout: JSON.stringify({
          hookSpecificOutput: {
            hookEventName: ev.nativeEvent,
            permissionDecision: 'ask',
            permissionDecisionReason: decision.reason ?? 'hook-factory requested confirmation',
          },
        }),
      }
    case 'allow':
      return {
        code: 0,
        stdout: JSON.stringify({
          hookSpecificOutput: {
            hookEventName: ev.nativeEvent,
            permissionDecision: 'allow',
            permissionDecisionReason: decision.reason ?? 'approved by hook-factory',
          },
        }),
      }
    case 'context':
      return {
        code: 0,
        stdout: JSON.stringify({
          hookSpecificOutput: { hookEventName: ev.nativeEvent, additionalContext: decision.text },
          // SessionStart/UserPromptSubmit on several agents inject bare stdout
          // instead of reading the JSON, so we can't rely on one or the other.
        }),
      }
    case 'continue':
      return {
        code: 0,
        stdout: JSON.stringify({ decision: 'block', reason: decision.message ?? 'hook-factory: keep going' }),
      }
    case 'warn':
      return { code: 0, stderr: decision.message, stdout: JSON.stringify({ systemMessage: decision.message }) }
  }
}

/** Pull the common fields out of a Claude-shaped stdin payload. */
export function claudeStyleParse(
  raw: Record<string, unknown>,
  nativeEvent: string,
  agent: string,
  event: CanonicalEvent,
): HookEvent {
  const toolInput = asObject(raw.tool_input ?? raw.toolInput ?? raw.arguments)
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined)
  return {
    event,
    agent,
    nativeEvent,
    sessionId: str(raw.session_id ?? raw.sessionId ?? raw.conversation_id ?? raw.conversationId),
    cwd: str(raw.cwd ?? raw.working_dir ?? raw.workingDir) ?? process.cwd(),
    toolName: str(raw.tool_name ?? raw.toolName),
    toolInput,
    toolOutput: raw.tool_output ?? raw.tool_response ?? raw.toolOutput ?? raw.result,
    error: str(raw.error_message ?? raw.tool_error ?? raw.error),
    command: str(raw.command) ?? str(toolInput?.command) ?? str(toolInput?.cmd),
    filePath: str(raw.file_path ?? raw.filePath) ?? str(toolInput?.file_path) ?? str(toolInput?.path),
    prompt: str(raw.prompt ?? raw.user_prompt ?? raw.message),
    model: str(raw.model),
    transcriptPath: str(raw.transcript_path ?? raw.transcriptPath),
    permissionMode: str(raw.permission_mode ?? raw.permissionMode),
    raw,
  }
}

function asObject(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
}

export function claudeStyle(spec: ClaudeStyleSpec): Adapter {
  const container = spec.container === undefined ? 'hooks' : spec.container
  const commandKey = spec.commandKey ?? 'command'
  const format = spec.format ?? 'json'
  const reverse = new Map<string, CanonicalEvent>()
  for (const [canonical, native] of Object.entries(spec.events)) {
    if (native) reverse.set(native, canonical as CanonicalEvent)
  }

  return {
    id: spec.id,
    name: spec.name,
    status: spec.status ?? 'supported',
    install: 'write',
    docs: spec.docs,
    notes: spec.notes,
    events: spec.events,
    blocking: spec.blocking,
    scopes: spec.scopes,

    render(ctx: RenderContext): RenderResult {
      const scope = spec.scopes[ctx.scope] ?? spec.scopes.project ?? spec.scopes.user
      if (!scope) return { files: [], snippets: [], extras: [] }
      const path = expandPath(scope.file, ctx.projectDir)

      // Group hooks by native event, then by tool matcher. Pushing the matcher
      // into native config means the agent skips spawning us entirely for calls
      // we don't care about — a real latency win on PreToolUse.
      const byEvent: Record<string, Map<string, unknown[]>> = {}
      for (const hook of ctx.hooks) {
        const native = spec.events[hook.event]
        if (!native) continue
        const useMatcher = !spec.noMatcherEvents?.includes(native)
        const matcher = useMatcher ? hook.toolMatcher ?? '*' : ''
        byEvent[native] ??= new Map()
        const groups = byEvent[native]!
        const entry: Record<string, unknown> = {
          type: 'command',
          [commandKey]: `${ctx.runner} run --agent ${spec.id} --event ${native}`,
          ...(spec.requireName ? { name: `hook-factory-${native}` } : {}),
          ...spec.extraHookFields,
        }
        if (spec.timeout) {
          const ms = hook.timeoutMs ?? 30_000
          entry[spec.timeout.key] = spec.timeout.unit === 'ms' ? ms : Math.ceil(ms / 1000)
        }
        if (!groups.has(matcher)) groups.set(matcher, [])
        groups.get(matcher)!.push(tag(entry))
      }

      const eventMap: Record<string, unknown[]> = {}
      for (const [native, groups] of Object.entries(byEvent)) {
        eventMap[native] = [...groups.entries()].map(([matcher, hooks]) =>
          tag({
            ...(matcher ? { matcher } : {}),
            hooks: dedupeEntries(hooks),
            ...spec.extraGroupFields,
          }),
        )
      }

      return {
        files: [
          {
            path,
            format,
            apply: (existing) => {
              const merged = mergeEventMap(existing, container, eventMap)
              return spec.rootFields ? { ...spec.rootFields, ...merged } : merged
            },
            revert: (existing) => revertEventMap(existing, container),
          },
        ],
        snippets: [],
        extras: [],
      }
    },

    parse(raw, nativeEvent) {
      if (spec.parse) return spec.parse(raw, nativeEvent, spec.id)
      const canonical = reverse.get(nativeEvent) ?? 'preToolUse'
      return claudeStyleParse(raw, nativeEvent, spec.id, canonical)
    },

    emit: spec.emit ?? claudeStyleEmit,
  }
}

/**
 * All hooks for the same (event, matcher) invoke the same dispatcher command,
 * so N config-level entries would mean N process spawns for one tool call. Our
 * runtime already runs every matching hook in-process — one entry is enough.
 */
function dedupeEntries(entries: unknown[]): unknown[] {
  const seen = new Set<string>()
  const out: unknown[] = []
  for (const e of entries) {
    const k = JSON.stringify(e)
    if (seen.has(k)) continue
    seen.add(k)
    out.push(e)
  }
  return out
}

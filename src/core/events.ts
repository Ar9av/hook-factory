import type { CanonicalEvent, Hook, HookHandler, Matcher } from './types.js'
import { CANONICAL_EVENTS } from './types.js'

export { CANONICAL_EVENTS }

/** Short, human-facing descriptions used by `hf list` and the TUI. */
export const EVENT_DOCS: Record<CanonicalEvent, string> = {
  sessionStart: 'A session begins or resumes',
  sessionEnd: 'A session terminates',
  userPromptSubmit: 'The user submits a prompt, before the model sees it',
  preToolUse: 'Before any tool call executes',
  postToolUse: 'After a tool call succeeds',
  postToolUseFailure: 'After a tool call fails',
  permissionRequest: 'A permission decision is needed',
  preShell: 'Before a shell command runs',
  postShell: 'After a shell command runs',
  preReadFile: 'Before the agent reads a file',
  postFileEdit: 'After the agent edits a file',
  preModel: 'Before a request is sent to the model',
  postModel: 'After a model response comes back',
  subagentStart: 'A subagent is spawned',
  subagentStop: 'A subagent finishes',
  preCompact: 'Before context compaction',
  postCompact: 'After context compaction',
  notification: 'The agent emits a notification',
  stop: 'The agent finishes a turn and wants to stop',
}

let counter = 0
function autoId(event: CanonicalEvent, description?: string): string {
  if (description) {
    const slug = description
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40)
    if (slug) return `${event}:${slug}`
  }
  return `${event}:${++counter}`
}

export interface HookOptions {
  id?: string
  description?: string
  agents?: string[]
  timeoutMs?: number
  enabled?: boolean
  toolMatcher?: string
}

/**
 * Builds the `on<Event>` family. Every one accepts either
 * `(handler)` or `(matcher, handler)`, plus optional trailing options — the
 * two-arg form is what makes `onPreToolUse(match.bash(/rm -rf/), deny('no'))`
 * read the way it does.
 */
function makeOn(event: CanonicalEvent) {
  function on(handler: HookHandler, opts?: HookOptions): Hook
  function on(matcher: Matcher, handler: HookHandler, opts?: HookOptions): Hook
  function on(a: Matcher | HookHandler, b?: HookHandler | HookOptions, c?: HookOptions): Hook {
    const hasMatcher = typeof b === 'function'
    const matcher = hasMatcher ? (a as Matcher) : undefined
    const handler = (hasMatcher ? b : a) as HookHandler
    const opts = (hasMatcher ? c : (b as HookOptions | undefined)) ?? {}
    return {
      id: opts.id ?? autoId(event, opts.description),
      description: opts.description,
      event,
      match: matcher,
      handler,
      agents: opts.agents,
      timeoutMs: opts.timeoutMs,
      enabled: opts.enabled ?? true,
      toolMatcher: opts.toolMatcher,
    }
  }
  return on
}

export const onSessionStart = makeOn('sessionStart')
export const onSessionEnd = makeOn('sessionEnd')
export const onUserPromptSubmit = makeOn('userPromptSubmit')
export const onPreToolUse = makeOn('preToolUse')
export const onPostToolUse = makeOn('postToolUse')
export const onPostToolUseFailure = makeOn('postToolUseFailure')
export const onPermissionRequest = makeOn('permissionRequest')
export const onPreShell = makeOn('preShell')
export const onPostShell = makeOn('postShell')
export const onPreReadFile = makeOn('preReadFile')
export const onPostFileEdit = makeOn('postFileEdit')
export const onPreModel = makeOn('preModel')
export const onPostModel = makeOn('postModel')
export const onSubagentStart = makeOn('subagentStart')
export const onSubagentStop = makeOn('subagentStop')
export const onPreCompact = makeOn('preCompact')
export const onPostCompact = makeOn('postCompact')
export const onNotification = makeOn('notification')
export const onStop = makeOn('stop')

/** Escape hatch for building a hook on a dynamically-chosen event. */
export function on(event: CanonicalEvent, matcher: Matcher, handler: HookHandler, opts?: HookOptions): Hook
export function on(event: CanonicalEvent, handler: HookHandler, opts?: HookOptions): Hook
export function on(event: CanonicalEvent, a: any, b?: any, c?: any): Hook {
  return (makeOn(event) as any)(a, b, c)
}

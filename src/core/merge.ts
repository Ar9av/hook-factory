/**
 * Everything hook-factory writes into someone else's config file is tagged, so
 * `hf sync` is idempotent and `hf remove` is exact. We never diff-and-guess: a
 * managed entry carries `_hookFactory: true` and we own precisely those.
 */

export const MANAGED_KEY = '_hookFactory'
export const MANAGED_COMMENT = 'managed by hook-factory — edit hooks.config.ts, then run `hf sync`'

export function isManaged(v: unknown): boolean {
  return typeof v === 'object' && v !== null && (v as Record<string, unknown>)[MANAGED_KEY] === true
}

export function tag<T extends Record<string, unknown>>(v: T): T & { [MANAGED_KEY]: true } {
  return { ...v, [MANAGED_KEY]: true }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Merge managed entries into `existing[key]`, an array. Any pre-existing
 * managed entries are dropped first, so re-running sync replaces rather than
 * duplicates. User-authored entries are left exactly where they were.
 */
export function mergeManagedArray(existing: unknown, key: string, entries: unknown[]): Record<string, unknown> {
  const base = isPlainObject(existing) ? { ...existing } : {}
  const prev = Array.isArray(base[key]) ? (base[key] as unknown[]) : []
  const userEntries = prev.filter((e) => !isManaged(e))
  const next = [...userEntries, ...entries]
  if (next.length === 0) delete base[key]
  else base[key] = next
  return base
}

/** Remove our entries from `existing[key]`, leaving the user's alone. */
export function revertManagedArray(existing: unknown, key: string): Record<string, unknown> {
  const base = isPlainObject(existing) ? { ...existing } : {}
  const prev = Array.isArray(base[key]) ? (base[key] as unknown[]) : []
  const kept = prev.filter((e) => !isManaged(e))
  if (kept.length === 0) delete base[key]
  else base[key] = kept
  return base
}

/**
 * The `{ Event: [{ matcher, hooks: [...] }] }` shape shared by Claude Code and
 * the ~10 agents that copied it. We merge per-event and per-matcher so a user's
 * own PreToolUse entries survive untouched.
 */
export function mergeEventMap(
  existing: unknown,
  container: string | null,
  eventMap: Record<string, unknown[]>,
): Record<string, unknown> {
  const root = isPlainObject(existing) ? { ...existing } : {}
  const target = container ? (isPlainObject(root[container]) ? { ...(root[container] as object) } : {}) : root
  const out: Record<string, unknown> = { ...target }

  // Drop every managed entry across all events first — an event we no longer
  // emit must not leave a stale dispatcher behind.
  for (const k of Object.keys(out)) {
    if (!Array.isArray(out[k])) continue
    const kept = (out[k] as unknown[]).filter((e) => !isManagedGroup(e))
    if (kept.length) out[k] = kept
    else delete out[k]
  }

  for (const [event, entries] of Object.entries(eventMap)) {
    const prev = Array.isArray(out[event]) ? (out[event] as unknown[]) : []
    out[event] = [...prev, ...entries]
  }

  if (container) {
    if (Object.keys(out).length === 0) delete root[container]
    else root[container] = out
    return root
  }
  return out
}

export function revertEventMap(existing: unknown, container: string | null): Record<string, unknown> {
  const root = isPlainObject(existing) ? { ...existing } : {}
  const target = container ? (isPlainObject(root[container]) ? { ...(root[container] as object) } : {}) : root
  const out: Record<string, unknown> = { ...target }
  for (const k of Object.keys(out)) {
    if (!Array.isArray(out[k])) continue
    const kept = (out[k] as unknown[]).filter((e) => !isManagedGroup(e))
    if (kept.length) out[k] = kept
    else delete out[k]
  }
  if (container) {
    if (Object.keys(out).length === 0) delete root[container]
    else root[container] = out
    return root
  }
  return out
}

/**
 * A group is ours if the group itself is tagged, or every inner hook is. The
 * second case matters because some agents strip unknown keys from the outer
 * object but keep them on the inner hook entries.
 */
function isManagedGroup(e: unknown): boolean {
  if (isManaged(e)) return true
  if (isPlainObject(e) && Array.isArray(e.hooks)) {
    const hooks = e.hooks as unknown[]
    return hooks.length > 0 && hooks.every((h) => isManaged(h))
  }
  return false
}

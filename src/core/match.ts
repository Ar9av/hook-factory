import type { HookEvent, Matcher } from './types.js'

/**
 * Tool names are the least portable thing in this whole space: the shell tool is
 * `Bash` on Claude Code and Codex, `terminal` on OpenHands, `run_shell_command`
 * on Gemini/Qwen, `execute_bash` on Kiro, `shell` on goose, `bash` on Crush,
 * `launch-process` on Auggie, `run_command` on Antigravity. `match.shell()`
 * exists so nobody has to memorize that table.
 */
export const SHELL_TOOLS = [
  'bash',
  'shell',
  'terminal',
  'run_shell_command',
  'run_command',
  'execute_bash',
  'launch-process',
  'runcommand',
  'exec',
  'run_terminal_cmd',
  'str_replace_editor_bash',
]

export const EDIT_TOOLS = [
  'edit',
  'write',
  'multiedit',
  'apply_patch',
  'applypatch',
  'create',
  'str_replace_editor',
  'write_file',
  'edit_file',
  'replace',
  'fs_write',
  'save-file',
  'str-replace-editor',
]

export const READ_TOOLS = ['read', 'read_file', 'readfile', 'view', 'fs_read', 'cat']

function norm(s: string | undefined): string {
  return (s ?? '').toLowerCase().replace(/[-_\s]/g, '')
}

function testPattern(value: string | undefined, pattern: string | RegExp): boolean {
  if (value === undefined) return false
  if (pattern instanceof RegExp) return pattern.test(value)
  return norm(value) === norm(pattern)
}

/** Best-effort extraction of a shell command out of any agent's payload shape. */
export function commandOf(ev: HookEvent): string | undefined {
  if (ev.command) return ev.command
  const i = ev.toolInput ?? {}
  for (const k of ['command', 'cmd', 'CommandLine', 'commandLine', 'script', 'shell_command']) {
    const v = i[k]
    if (typeof v === 'string') return v
  }
  return undefined
}

/** Same idea for file paths. */
export function pathOf(ev: HookEvent): string | undefined {
  if (ev.filePath) return ev.filePath
  const i = ev.toolInput ?? {}
  for (const k of ['file_path', 'filePath', 'path', 'target_file', 'TargetFile', 'file', 'absolute_path']) {
    const v = i[k]
    if (typeof v === 'string') return v
  }
  return undefined
}

/**
 * Content the agent is about to write. Used by content-scanning hooks
 * (secret detection) so they can inspect an edit before it lands.
 */
export function contentOf(ev: HookEvent): string | undefined {
  const i = ev.toolInput ?? {}
  const parts: string[] = []
  for (const k of ['content', 'new_string', 'newString', 'new_str', 'text', 'patch', 'code_edit']) {
    const v = i[k]
    if (typeof v === 'string') parts.push(v)
  }
  const edits = i.edits
  if (Array.isArray(edits)) {
    for (const e of edits) {
      const s = (e as Record<string, unknown>)?.new_string ?? (e as Record<string, unknown>)?.newString
      if (typeof s === 'string') parts.push(s)
    }
  }
  return parts.length ? parts.join('\n') : undefined
}

/** Minimal glob: supports `*`, `**`, `?`, and `{a,b}`. Matched against the path tail too. */
export function globToRegExp(glob: string): RegExp {
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!
    if (c === '*') {
      if (glob[i + 1] === '*') {
        out += '.*'
        i++
        if (glob[i + 1] === '/') i++
      } else {
        out += '[^/]*'
      }
    } else if (c === '?') out += '[^/]'
    else if (c === '{') out += '('
    else if (c === '}') out += ')'
    else if (c === ',') out += '|'
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`(^|/)${out}$`)
}

export const match = {
  /** Matches everything. Useful as an explicit "audit all of it". */
  all(): Matcher {
    return () => true
  },

  /** Match by tool name — string compare is case/underscore insensitive. */
  tool(...patterns: (string | RegExp)[]): Matcher {
    return (ev) => patterns.some((p) => testPattern(ev.toolName, p))
  },

  /**
   * Any shell-ish tool, on any agent. Pass a pattern to also require the
   * command text to match: `match.shell(/rm -rf/)`.
   */
  shell(pattern?: string | RegExp): Matcher {
    return (ev) => {
      const isShell =
        ev.event === 'preShell' ||
        ev.event === 'postShell' ||
        SHELL_TOOLS.includes(norm(ev.toolName)) ||
        SHELL_TOOLS.some((t) => norm(t) === norm(ev.toolName))
      if (!isShell) return false
      if (!pattern) return true
      const cmd = commandOf(ev)
      if (cmd === undefined) return false
      return pattern instanceof RegExp ? pattern.test(cmd) : cmd.includes(pattern)
    }
  },

  /** Alias that reads better in config files. */
  bash(pattern?: string | RegExp): Matcher {
    return match.shell(pattern)
  },

  /** Any file-writing tool, optionally restricted to paths matching a glob. */
  edit(glob?: string): Matcher {
    return (ev) => {
      const isEdit = ev.event === 'postFileEdit' || EDIT_TOOLS.includes(norm(ev.toolName))
      if (!isEdit) return false
      if (!glob) return true
      const p = pathOf(ev)
      return p !== undefined && globToRegExp(glob).test(p)
    }
  },

  /** Any file-reading tool, optionally restricted by glob. */
  read(glob?: string): Matcher {
    return (ev) => {
      const isRead = ev.event === 'preReadFile' || READ_TOOLS.includes(norm(ev.toolName))
      if (!isRead) return false
      if (!glob) return true
      const p = pathOf(ev)
      return p !== undefined && globToRegExp(glob).test(p)
    }
  },

  /** Match on the file path regardless of which tool touched it. */
  path(...globs: string[]): Matcher {
    const res = globs.map(globToRegExp)
    return (ev) => {
      const p = pathOf(ev)
      return p !== undefined && res.some((r) => r.test(p))
    }
  },

  /** Match on the user's prompt text. */
  prompt(pattern: string | RegExp): Matcher {
    return (ev) => {
      const p = ev.prompt
      if (p === undefined) return false
      return pattern instanceof RegExp ? pattern.test(p) : p.includes(pattern)
    }
  },

  /** Match anywhere in the payload — command, path, content, prompt. */
  content(pattern: RegExp): Matcher {
    return (ev) => {
      const hay = [commandOf(ev), pathOf(ev), contentOf(ev), ev.prompt].filter(Boolean).join('\n')
      return pattern.test(hay)
    }
  },

  /** Restrict a hook to specific agents from inside the matcher chain. */
  agent(...ids: string[]): Matcher {
    return (ev) => ids.includes(ev.agent)
  },

  /**
   * Match MCP tools. Agents namespace them differently — `mcp__server__tool`
   * (Claude Code), `@server/tool` (Amazon Q, Kiro), `tool_server` (Auggie).
   */
  mcp(server?: string): Matcher {
    return (ev) => {
      const n = ev.toolName ?? ''
      const isMcp = n.startsWith('mcp__') || n.startsWith('@') || ev.raw.is_mcp_tool === true
      if (!isMcp) return false
      return server ? n.includes(server) : true
    }
  },

  // --- combinators -------------------------------------------------------

  and(...ms: Matcher[]): Matcher {
    return (ev) => ms.every((m) => m(ev))
  },
  or(...ms: Matcher[]): Matcher {
    return (ev) => ms.some((m) => m(ev))
  },
  not(m: Matcher): Matcher {
    return (ev) => !m(ev)
  },
  /** Arbitrary predicate, for when the built-ins run out. */
  where(fn: (ev: HookEvent) => boolean): Matcher {
    return fn
  },
}

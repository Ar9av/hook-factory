import { claudeStyle } from './claude-style.js'
import type { Adapter } from '../core/types.js'

/**
 * Every agent whose hook config is a dialect of Claude Code's. Event names and
 * field spellings come from each tool's own docs — see the `docs` link on each
 * adapter. Where a doc and a live test disagreed, the live-tested behaviour wins
 * and the discrepancy is recorded in `notes`.
 */

export const claudeCode: Adapter = claudeStyle({
  id: 'claude-code',
  name: 'Claude Code',
  docs: 'https://docs.claude.com/en/docs/claude-code/hooks',
  events: {
    sessionStart: 'SessionStart',
    sessionEnd: 'SessionEnd',
    userPromptSubmit: 'UserPromptSubmit',
    preToolUse: 'PreToolUse',
    postToolUse: 'PostToolUse',
    postToolUseFailure: 'PostToolUseFailure',
    permissionRequest: 'PermissionRequest',
    subagentStart: 'SubagentStart',
    subagentStop: 'SubagentStop',
    preCompact: 'PreCompact',
    postCompact: 'PostCompact',
    notification: 'Notification',
    stop: 'Stop',
  },
  blocking: ['userPromptSubmit', 'preToolUse', 'permissionRequest', 'subagentStop', 'stop'],
  scopes: {
    project: { file: '.claude/settings.json', format: 'json' },
    user: { file: '~/.claude/settings.json', format: 'json' },
  },
  timeout: { key: 'timeout', unit: 's' },
  noMatcherEvents: ['UserPromptSubmit', 'SessionStart', 'SessionEnd', 'Stop', 'Notification'],
})

export const codex: Adapter = claudeStyle({
  id: 'codex',
  name: 'Codex CLI',
  docs: 'https://developers.openai.com/codex/hooks',
  notes: [
    'Codex requires you to trust a hook before it first runs — use `/hooks` in the CLI, or `--dangerously-bypass-hook-trust` for automation.',
    'Blocking is reliable via exit 2 + stderr; the stdout `permissionDecision: deny` path did not block in a live v0.145.0 test.',
  ],
  events: {
    sessionStart: 'SessionStart',
    userPromptSubmit: 'UserPromptSubmit',
    preToolUse: 'PreToolUse',
    postToolUse: 'PostToolUse',
    permissionRequest: 'PermissionRequest',
    subagentStart: 'SubagentStart',
    subagentStop: 'SubagentStop',
    preCompact: 'PreCompact',
    postCompact: 'PostCompact',
    stop: 'Stop',
  },
  blocking: ['userPromptSubmit', 'preToolUse', 'permissionRequest', 'subagentStop', 'stop'],
  scopes: {
    project: { file: '.codex/hooks.json', format: 'json' },
    user: { file: '~/.codex/hooks.json', format: 'json' },
  },
  timeout: { key: 'timeout', unit: 's' },
  noMatcherEvents: ['UserPromptSubmit', 'Stop'],
})

export const geminiCli: Adapter = claudeStyle({
  id: 'gemini-cli',
  name: 'Gemini CLI',
  docs: 'https://google-gemini.github.io/gemini-cli/docs/cli/hooks.html',
  notes: [
    'Gemini fingerprints project-level hooks: changing the command re-triggers the untrusted-hook warning.',
    'Gemini uses Before*/After* naming rather than Pre*/Post* — hook-factory maps this for you.',
  ],
  events: {
    sessionStart: 'SessionStart',
    sessionEnd: 'SessionEnd',
    preToolUse: 'BeforeTool',
    postToolUse: 'AfterTool',
    preModel: 'BeforeModel',
    postModel: 'AfterModel',
    preCompact: 'PreCompress',
    notification: 'Notification',
    stop: 'AfterAgent',
  },
  blocking: ['preToolUse', 'postToolUse', 'preModel', 'postModel', 'stop'],
  scopes: {
    project: { file: '.gemini/settings.json', format: 'json' },
    user: { file: '~/.gemini/settings.json', format: 'json' },
  },
  timeout: { key: 'timeout', unit: 'ms' },
  requireName: true,
  noMatcherEvents: ['SessionStart', 'SessionEnd', 'Notification', 'AfterAgent'],
})

export const qwenCode: Adapter = claudeStyle({
  id: 'qwen-code',
  name: 'Qwen Code',
  docs: 'https://qwenlm.github.io/qwen-code-docs/',
  notes: [
    'Qwen matches on runtime tool ids (`run_shell_command`, `write_file`), not display names.',
    'Non-interactive runs need `-y`/`--yolo` for shell tool calls to execute at all, hooks included.',
    'Set `"disableAllHooks": true` in settings.json to switch every hook off without deleting config.',
  ],
  events: {
    sessionStart: 'SessionStart',
    sessionEnd: 'SessionEnd',
    userPromptSubmit: 'UserPromptSubmit',
    preToolUse: 'PreToolUse',
    postToolUse: 'PostToolUse',
    postToolUseFailure: 'PostToolUseFailure',
    permissionRequest: 'PermissionRequest',
    subagentStart: 'SubagentStart',
    subagentStop: 'SubagentStop',
    preCompact: 'PreCompact',
    postCompact: 'PostCompact',
    notification: 'Notification',
    stop: 'Stop',
  },
  blocking: ['userPromptSubmit', 'preToolUse', 'postToolUse', 'subagentStop', 'stop'],
  scopes: {
    project: { file: '.qwen/settings.json', format: 'json' },
    user: { file: '~/.qwen/settings.json', format: 'json' },
  },
  timeout: { key: 'timeout', unit: 'ms' },
  noMatcherEvents: ['UserPromptSubmit', 'Stop', 'MessageDisplay'],
})

export const auggie: Adapter = claudeStyle({
  id: 'auggie',
  name: 'Auggie (Augment)',
  docs: 'https://docs.augmentcode.com/cli/hooks',
  notes: ['MCP tools are named `{toolName}_{serverName}`; match them with an `mcp:` matcher prefix.'],
  events: {
    sessionStart: 'SessionStart',
    sessionEnd: 'SessionEnd',
    preToolUse: 'PreToolUse',
    postToolUse: 'PostToolUse',
    stop: 'Stop',
  },
  blocking: ['preToolUse', 'stop'],
  scopes: {
    project: { file: '.augment/settings.json', format: 'json' },
    user: { file: '~/.augment/settings.json', format: 'json' },
  },
  timeout: { key: 'timeout', unit: 's' },
  noMatcherEvents: ['SessionStart', 'SessionEnd', 'Stop'],
})

export const factoryDroid: Adapter = claudeStyle({
  id: 'factory-droid',
  name: 'Factory Droid',
  docs: 'https://docs.factory.ai/cli/configuration/hooks',
  notes: ['Droid reads `hooks.json` at the scope root; it falls back to a `hooks` key in settings.json only if that file is absent.'],
  events: {
    sessionStart: 'SessionStart',
    sessionEnd: 'SessionEnd',
    userPromptSubmit: 'UserPromptSubmit',
    preToolUse: 'PreToolUse',
    postToolUse: 'PostToolUse',
    subagentStop: 'SubagentStop',
    preCompact: 'PreCompact',
    notification: 'Notification',
    stop: 'Stop',
  },
  blocking: ['userPromptSubmit', 'preToolUse', 'subagentStop', 'stop'],
  scopes: {
    project: { file: '.factory/hooks.json', format: 'json' },
    user: { file: '~/.factory/hooks.json', format: 'json' },
  },
  container: null,
  timeout: { key: 'timeout', unit: 's' },
  noMatcherEvents: ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'Stop', 'Notification', 'PreCompact'],
})

export const devinCli: Adapter = claudeStyle({
  id: 'devin-cli',
  name: 'Devin CLI',
  docs: 'https://docs.devin.ai/cli/hooks',
  events: {
    sessionStart: 'SessionStart',
    sessionEnd: 'SessionEnd',
    userPromptSubmit: 'UserPromptSubmit',
    preToolUse: 'PreToolUse',
    postToolUse: 'PostToolUse',
    permissionRequest: 'PermissionRequest',
    postCompact: 'PostCompaction',
    stop: 'Stop',
  },
  blocking: ['preToolUse', 'permissionRequest', 'stop'],
  scopes: {
    project: { file: '.devin/hooks.v1.json', format: 'json' },
    user: { file: '~/.config/devin/hooks.v1.json', format: 'json' },
  },
  container: null,
  timeout: { key: 'timeout', unit: 's' },
  noMatcherEvents: ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'Stop', 'PostCompaction'],
})

export const openhands: Adapter = claudeStyle({
  id: 'openhands',
  name: 'OpenHands',
  docs: 'https://docs.all-hands.dev/usage/hooks',
  notes: [
    'OpenHands names its shell tool `terminal` — a matcher of `bash` or `execute_bash` silently never fires.',
    'Hooks marked `"async": true` can never block, regardless of event.',
  ],
  events: {
    sessionStart: 'session_start',
    sessionEnd: 'session_end',
    userPromptSubmit: 'user_prompt_submit',
    preToolUse: 'pre_tool_use',
    postToolUse: 'post_tool_use',
    stop: 'stop',
  },
  blocking: ['userPromptSubmit', 'preToolUse', 'stop'],
  scopes: { project: { file: '.openhands/hooks.json', format: 'json' } },
  container: null,
  timeout: { key: 'timeout', unit: 's' },
  extraHookFields: { async: false },
  noMatcherEvents: ['session_start', 'session_end', 'user_prompt_submit', 'stop'],
})

export const continueCli: Adapter = claudeStyle({
  id: 'continue-cli',
  name: 'Continue CLI (cn)',
  status: 'partial',
  docs: 'https://docs.continue.dev/',
  notes: [
    'Live-tested 2026-07-23 on v1.5.47: hooks did not fire at all in headless (`-p`) mode, for any event or config location. Do not rely on these for CI guardrails.',
    'cn also reads `.claude/settings.json`, so a Claude Code sync may already cover it.',
  ],
  events: {
    sessionStart: 'SessionStart',
    sessionEnd: 'SessionEnd',
    userPromptSubmit: 'UserPromptSubmit',
    preToolUse: 'PreToolUse',
    postToolUse: 'PostToolUse',
    postToolUseFailure: 'PostToolUseFailure',
    permissionRequest: 'PermissionRequest',
    subagentStart: 'SubagentStart',
    subagentStop: 'SubagentStop',
    preCompact: 'PreCompact',
    notification: 'Notification',
    stop: 'Stop',
  },
  blocking: ['userPromptSubmit', 'preToolUse', 'permissionRequest', 'subagentStop', 'stop'],
  scopes: {
    project: { file: '.continue/settings.json', format: 'json' },
    user: { file: '~/.continue/settings.json', format: 'json' },
  },
  timeout: { key: 'timeout', unit: 's' },
  noMatcherEvents: ['UserPromptSubmit', 'Stop', 'SessionStart', 'SessionEnd'],
})

export const googleAntigravity: Adapter = claudeStyle({
  id: 'google-antigravity',
  name: 'Google Antigravity',
  docs: 'https://antigravity.google/docs',
  notes: [
    'Antigravity has no flat `tool_name`/`tool_input` on stdin — it nests them under `toolCall.name`/`toolCall.args`. hook-factory normalizes this.',
    'Valid PreToolUse decisions are allow / deny / ask / force_ask. `block` is not accepted.',
  ],
  events: {
    preToolUse: 'PreToolUse',
    postToolUse: 'PostToolUse',
    preModel: 'PreInvocation',
    postModel: 'PostInvocation',
    stop: 'Stop',
  },
  blocking: ['preToolUse', 'preModel', 'stop'],
  scopes: {
    project: { file: '.agents/hooks.json', format: 'json' },
    user: { file: '~/.gemini/config/hooks.json', format: 'json' },
  },
  container: null,
  timeout: { key: 'timeout', unit: 's' },
  parse: (raw, nativeEvent, id) => {
    const toolCall = (raw.toolCall ?? {}) as Record<string, unknown>
    const args = (toolCall.args ?? {}) as Record<string, unknown>
    const workspaces = Array.isArray(raw.workspacePaths) ? (raw.workspacePaths as string[]) : []
    const canonical =
      nativeEvent === 'PostToolUse'
        ? 'postToolUse'
        : nativeEvent === 'PreInvocation'
          ? 'preModel'
          : nativeEvent === 'PostInvocation'
            ? 'postModel'
            : nativeEvent === 'Stop'
              ? 'stop'
              : 'preToolUse'
    return {
      event: canonical,
      agent: id,
      nativeEvent,
      sessionId: typeof raw.conversationId === 'string' ? raw.conversationId : undefined,
      cwd: (typeof args.Cwd === 'string' ? args.Cwd : workspaces[0]) ?? process.cwd(),
      toolName: typeof toolCall.name === 'string' ? toolCall.name : undefined,
      toolInput: args,
      error: typeof raw.error === 'string' ? raw.error : undefined,
      command: typeof args.CommandLine === 'string' ? args.CommandLine : undefined,
      filePath: typeof args.TargetFile === 'string' ? args.TargetFile : undefined,
      transcriptPath: typeof raw.transcriptPath === 'string' ? raw.transcriptPath : undefined,
      raw,
    }
  },
  emit: (decision, ev) => {
    if (!decision) return { code: 0 }
    switch (decision.kind) {
      case 'deny':
        return { code: 2, stderr: decision.reason, stdout: JSON.stringify({ decision: 'deny', reason: decision.reason }) }
      case 'ask':
        return { code: 0, stdout: JSON.stringify({ decision: 'ask', reason: decision.reason }) }
      case 'allow':
        return { code: 0, stdout: JSON.stringify({ decision: 'allow', reason: decision.reason }) }
      case 'continue':
        return { code: 0, stdout: JSON.stringify({ decision: 'continue', reason: decision.message }) }
      case 'context':
        return { code: 0, stdout: JSON.stringify({ reason: decision.text }) }
      case 'warn':
        return { code: 0, stderr: decision.message }
    }
    return { code: 0, stdout: JSON.stringify({ decision: 'allow' }) satisfies string }
  },
})

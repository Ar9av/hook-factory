import type { Adapter, CanonicalEvent, HookEvent, RenderContext, RenderResult } from '../core/types.js'
import { expandPath } from '../core/fs.js'
import { mergeEventMap, mergeManagedArray, revertEventMap, revertManagedArray, tag } from '../core/merge.js'
import { claudeStyleEmit, claudeStyleParse } from './claude-style.js'

/**
 * Agents whose hook config is its own shape, not a Claude Code dialect.
 */

// --- Cursor ----------------------------------------------------------------
// `.cursor/hooks.json` is `{ version: 1, hooks: { <event>: [{ command }] } }` —
// a flat array of command objects, with no matcher/hooks nesting.

const CURSOR_EVENTS: Partial<Record<CanonicalEvent, string>> = {
  sessionStart: 'sessionStart',
  sessionEnd: 'sessionEnd',
  preToolUse: 'preToolUse',
  postToolUse: 'postToolUse',
  postToolUseFailure: 'postToolUseFailure',
  preShell: 'beforeShellExecution',
  postShell: 'afterShellExecution',
  preReadFile: 'beforeReadFile',
  postFileEdit: 'afterFileEdit',
  userPromptSubmit: 'beforeSubmitPrompt',
  subagentStart: 'subagentStart',
  subagentStop: 'subagentStop',
  preCompact: 'preCompact',
  stop: 'stop',
}

export const cursor: Adapter = {
  id: 'cursor',
  name: 'Cursor',
  status: 'supported',
  install: 'write',
  docs: 'https://cursor.com/docs/agent/hooks',
  notes: [
    'Cursor splits shell and MCP calls into their own events — `preShell` gives you the command directly, without going through `preToolUse`.',
    'Set `failClosed: true` in your hooks.json if you want a crashing hook to block rather than pass through.',
  ],
  events: CURSOR_EVENTS,
  blocking: ['preToolUse', 'preShell', 'preReadFile', 'userPromptSubmit', 'subagentStart'],
  scopes: {
    project: { file: '.cursor/hooks.json', format: 'json' },
    user: { file: '~/.cursor/hooks.json', format: 'json' },
  },
  render(ctx) {
    const scope = ctx.scope === 'user' ? '~/.cursor/hooks.json' : '.cursor/hooks.json'
    const eventMap: Record<string, unknown[]> = {}
    for (const hook of ctx.hooks) {
      const native = CURSOR_EVENTS[hook.event]
      if (!native) continue
      eventMap[native] ??= []
      const entry = tag({ command: `${ctx.runner} run --agent cursor --event ${native}` })
      if (!eventMap[native]!.some((e) => JSON.stringify(e) === JSON.stringify(entry))) eventMap[native]!.push(entry)
    }
    return {
      files: [
        {
          path: expandPath(scope, ctx.projectDir),
          format: 'json',
          apply: (existing) => ({ version: 1, ...mergeEventMap(existing, 'hooks', eventMap) }),
          revert: (existing) => revertEventMap(existing, 'hooks'),
        },
      ],
      snippets: [],
      extras: [],
    }
  },
  parse(raw, nativeEvent) {
    const canonical =
      (Object.entries(CURSOR_EVENTS).find(([, v]) => v === nativeEvent)?.[0] as CanonicalEvent) ?? 'preToolUse'
    const ev = claudeStyleParse(raw, nativeEvent, 'cursor', canonical)
    // Cursor's shell events put the command at the top level, not in tool_input.
    if (typeof raw.command === 'string') ev.command = raw.command
    if (typeof raw.file_path === 'string') ev.filePath = raw.file_path
    if (typeof raw.prompt === 'string') ev.prompt = raw.prompt
    return ev
  },
  emit(decision, ev) {
    if (!decision) return { code: 0 }
    if (decision.kind === 'continue') {
      return { code: 0, stdout: JSON.stringify({ followup_message: decision.message }) }
    }
    if (decision.kind === 'deny') {
      return { code: 2, stderr: decision.reason, stdout: JSON.stringify({ permission: 'deny', userMessage: decision.reason }) }
    }
    if (decision.kind === 'ask') return { code: 0, stdout: JSON.stringify({ permission: 'ask' }) }
    if (decision.kind === 'allow') return { code: 0, stdout: JSON.stringify({ permission: 'allow' }) }
    return claudeStyleEmit(decision, ev)
  },
}

// --- Crush -----------------------------------------------------------------
// `crush.json` -> `hooks.PreToolUse: [{ name, matcher, command, timeout }]`.
// PreToolUse is the only event Crush implements today.

export const crush: Adapter = {
  id: 'crush',
  name: 'Crush',
  status: 'partial',
  install: 'write',
  docs: 'https://github.com/charmbracelet/crush',
  notes: [
    'PreToolUse is the only event Crush supports so far.',
    'Crush spells denial `"decision": "deny"`, not `"block"` — a hook copied from goose will silently lose its reason. hook-factory emits exit 2 + stderr, which is verified to work.',
    'Sub-agent tool calls are not intercepted, only the top-level agent.',
  ],
  events: { preToolUse: 'PreToolUse' },
  blocking: ['preToolUse'],
  scopes: {
    project: { file: 'crush.json', format: 'json' },
    user: { file: '~/.config/crush/crush.json', format: 'json' },
  },
  render(ctx) {
    const file = ctx.scope === 'user' ? '~/.config/crush/crush.json' : 'crush.json'
    const entries = new Map<string, unknown>()
    for (const hook of ctx.hooks) {
      if (hook.event !== 'preToolUse') continue
      const matcher = hook.toolMatcher ?? '.*'
      entries.set(
        matcher,
        tag({
          name: `hook-factory-${matcher.replace(/[^a-z0-9]+/gi, '-')}`,
          matcher,
          command: `${ctx.runner} run --agent crush --event PreToolUse`,
          timeout: Math.ceil((hook.timeoutMs ?? 30_000) / 1000),
        }),
      )
    }
    const eventMap: Record<string, unknown[]> = entries.size ? { PreToolUse: [...entries.values()] } : {}
    return {
      files: [
        {
          path: expandPath(file, ctx.projectDir),
          format: 'json',
          apply: (existing) => mergeEventMap(existing, 'hooks', eventMap),
          revert: (existing) => revertEventMap(existing, 'hooks'),
        },
      ],
      snippets: [],
      extras: [],
    }
  },
  parse(raw, nativeEvent) {
    return claudeStyleParse(raw, nativeEvent, 'crush', 'preToolUse')
  },
  emit(decision) {
    if (!decision) return { code: 0 }
    switch (decision.kind) {
      case 'deny':
        return { code: 2, stderr: decision.reason, stdout: JSON.stringify({ version: 1, decision: 'deny', reason: decision.reason }) }
      case 'context':
        return { code: 0, stdout: JSON.stringify({ version: 1, decision: 'allow', context: decision.text }) }
      case 'warn':
        return { code: 0, stderr: decision.message }
      case 'allow':
        return { code: 0, stdout: JSON.stringify({ version: 1, decision: 'allow', reason: decision.reason }) }
      default:
        return { code: 0 }
    }
  },
}

// --- goose -----------------------------------------------------------------
// Open Plugins spec: a `hooks/hooks.json` inside a plugin directory that goose
// auto-discovers. We write ourselves as a plugin named `hook-factory`.

const GOOSE_EVENTS: Partial<Record<CanonicalEvent, string>> = {
  sessionStart: 'SessionStart',
  sessionEnd: 'SessionEnd',
  userPromptSubmit: 'UserPromptSubmit',
  preToolUse: 'PreToolUse',
  postToolUse: 'PostToolUse',
  postToolUseFailure: 'PostToolUseFailure',
  preReadFile: 'BeforeReadFile',
  postFileEdit: 'AfterFileEdit',
  preShell: 'BeforeShellExecution',
  postShell: 'AfterShellExecution',
  stop: 'Stop',
}

export const goose: Adapter = {
  id: 'goose',
  name: 'goose',
  status: 'supported',
  install: 'write',
  docs: 'https://block.github.io/goose/docs/guides/hooks',
  notes: ['Only PreToolUse and Stop can actually block on goose; every other event is observation-only.'],
  events: GOOSE_EVENTS,
  blocking: ['preToolUse', 'stop'],
  scopes: {
    project: { file: '.agents/plugins/hook-factory/hooks/hooks.json', format: 'json' },
    user: { file: '~/.agents/plugins/hook-factory/hooks/hooks.json', format: 'json' },
  },
  render(ctx) {
    const file =
      ctx.scope === 'user'
        ? '~/.agents/plugins/hook-factory/hooks/hooks.json'
        : '.agents/plugins/hook-factory/hooks/hooks.json'
    const eventMap: Record<string, unknown[]> = {}
    for (const hook of ctx.hooks) {
      const native = GOOSE_EVENTS[hook.event]
      if (!native) continue
      eventMap[native] ??= []
      const entry = tag({
        matcher: hook.toolMatcher ?? '*',
        hooks: [{ type: 'command', command: `${ctx.runner} run --agent goose --event ${native}` }],
      })
      if (!eventMap[native]!.some((e) => JSON.stringify(e) === JSON.stringify(entry))) eventMap[native]!.push(entry)
    }
    return {
      files: [
        {
          path: expandPath(file, ctx.projectDir),
          format: 'json',
          apply: (existing) => mergeEventMap(existing, 'hooks', eventMap),
          revert: (existing) => revertEventMap(existing, 'hooks'),
        },
      ],
      snippets: [],
      extras: [],
    }
  },
  parse(raw, nativeEvent) {
    const canonical = (Object.entries(GOOSE_EVENTS).find(([, v]) => v === nativeEvent)?.[0] as CanonicalEvent) ?? 'preToolUse'
    return claudeStyleParse(raw, nativeEvent, 'goose', canonical)
  },
  emit(decision) {
    if (!decision) return { code: 0 }
    if (decision.kind === 'deny') {
      return { code: 2, stderr: decision.reason, stdout: JSON.stringify({ decision: 'block', reason: decision.reason }) }
    }
    if (decision.kind === 'continue') {
      return { code: 0, stdout: JSON.stringify({ decision: 'block', reason: decision.message }) }
    }
    if (decision.kind === 'warn') return { code: 0, stderr: decision.message }
    return { code: 0 }
  },
}

// --- Kimi Code -------------------------------------------------------------
// TOML `[[hooks]]` array-of-tables in `~/.kimi-code/config.toml`.

const KIMI_EVENTS: Partial<Record<CanonicalEvent, string>> = {
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
}

export const kimiCode: Adapter = {
  id: 'kimi-code',
  name: 'Kimi Code',
  status: 'supported',
  install: 'write',
  docs: 'https://platform.moonshot.ai/docs/kimi-code',
  notes: ['Kimi fails open: a hook that errors never interrupts the workflow.'],
  events: KIMI_EVENTS,
  blocking: ['preToolUse', 'userPromptSubmit', 'stop'],
  scopes: {
    project: { file: '.kimi-code/config.toml', format: 'toml' },
    user: { file: '~/.kimi-code/config.toml', format: 'toml' },
  },
  render(ctx) {
    const file = ctx.scope === 'user' ? '~/.kimi-code/config.toml' : '.kimi-code/config.toml'
    const seen = new Set<string>()
    const entries: unknown[] = []
    for (const hook of ctx.hooks) {
      const native = KIMI_EVENTS[hook.event]
      if (!native) continue
      const matcher = hook.toolMatcher ?? ''
      const key = `${native}|${matcher}`
      if (seen.has(key)) continue
      seen.add(key)
      entries.push(
        tag({
          event: native,
          ...(matcher ? { matcher } : {}),
          command: `${ctx.runner} run --agent kimi-code --event ${native}`,
          timeout: Math.ceil((hook.timeoutMs ?? 30_000) / 1000),
        }),
      )
    }
    return {
      files: [
        {
          path: expandPath(file, ctx.projectDir),
          format: 'toml',
          apply: (existing) => mergeManagedArray(existing, 'hooks', entries),
          revert: (existing) => revertManagedArray(existing, 'hooks'),
        },
      ],
      snippets: [],
      extras: [],
    }
  },
  parse(raw, nativeEvent) {
    const canonical = (Object.entries(KIMI_EVENTS).find(([, v]) => v === nativeEvent)?.[0] as CanonicalEvent) ?? 'preToolUse'
    return claudeStyleParse(raw, nativeEvent, 'kimi-code', canonical)
  },
  emit(decision, ev) {
    // Kimi blocks Stop via JSON stdout with exit 0, not exit 2.
    if (decision?.kind === 'continue' || (decision?.kind === 'deny' && ev.event === 'stop')) {
      const reason = decision.kind === 'continue' ? decision.message : decision.reason
      return { code: 0, stdout: JSON.stringify({ decision: 'block', reason }) }
    }
    return claudeStyleEmit(decision, ev)
  },
}

// --- GitHub Copilot --------------------------------------------------------
// `.github/hooks/*.json`; command hooks use a `bash` key, timeouts are
// `timeoutSec`, and both camelCase and PascalCase event names are accepted.

const COPILOT_EVENTS: Partial<Record<CanonicalEvent, string>> = {
  sessionStart: 'sessionStart',
  sessionEnd: 'sessionEnd',
  userPromptSubmit: 'userPromptSubmitted',
  preToolUse: 'preToolUse',
  postToolUse: 'postToolUse',
  postToolUseFailure: 'postToolUseFailure',
  permissionRequest: 'permissionRequest',
  subagentStart: 'subagentStart',
  subagentStop: 'subagentStop',
  preCompact: 'preCompact',
  notification: 'notification',
  stop: 'agentStop',
}

export const githubCopilot: Adapter = {
  id: 'github-copilot',
  name: 'GitHub Copilot CLI',
  status: 'supported',
  install: 'write',
  docs: 'https://docs.github.com/en/copilot/reference/hooks-reference',
  notes: [
    'Cloud agent sessions load hooks only from `.github/hooks/*.json` on the default branch — a project-scope sync is what reaches them.',
    'HTTP hooks require HTTPS unless you set COPILOT_HOOK_ALLOW_LOCALHOST=1.',
  ],
  events: COPILOT_EVENTS,
  blocking: ['preToolUse', 'permissionRequest', 'stop', 'subagentStop'],
  scopes: {
    project: { file: '.github/hooks/hook-factory.json', format: 'json' },
    user: { file: '~/.copilot/settings.json', format: 'json' },
  },
  render(ctx) {
    const eventMap: Record<string, unknown[]> = {}
    for (const hook of ctx.hooks) {
      const native = COPILOT_EVENTS[hook.event]
      if (!native) continue
      eventMap[native] ??= []
      const entry = tag({
        matcher: hook.toolMatcher ?? '*',
        hooks: [
          {
            type: 'command',
            bash: `${ctx.runner} run --agent github-copilot --event ${native}`,
            timeoutSec: Math.ceil((hook.timeoutMs ?? 30_000) / 1000),
          },
        ],
      })
      if (!eventMap[native]!.some((e) => JSON.stringify(e) === JSON.stringify(entry))) eventMap[native]!.push(entry)
    }
    const userScope = ctx.scope === 'user'
    const file = userScope ? '~/.copilot/settings.json' : '.github/hooks/hook-factory.json'
    const container = userScope ? 'hooks' : null
    return {
      files: [
        {
          path: expandPath(file, ctx.projectDir),
          format: 'json',
          apply: (existing) => mergeEventMap(existing, container, eventMap),
          revert: (existing) => revertEventMap(existing, container),
        },
      ],
      snippets: [],
      extras: [],
    }
  },
  parse(raw, nativeEvent) {
    const canonical = (Object.entries(COPILOT_EVENTS).find(([, v]) => v === nativeEvent)?.[0] as CanonicalEvent) ?? 'preToolUse'
    // Copilot's camelCase events use camelCase field names too.
    const merged = { ...raw, tool_name: raw.tool_name ?? raw.toolName, tool_input: raw.tool_input ?? raw.toolInput }
    return claudeStyleParse(merged, nativeEvent, 'github-copilot', canonical)
  },
  emit: claudeStyleEmit,
}

// --- OpenClaw --------------------------------------------------------------
// Internal hooks are directories with a HOOK.md + handler.ts, loaded by the
// gateway. We generate a handler that shells out to our runtime.

const OPENCLAW_EVENTS: Partial<Record<CanonicalEvent, string>> = {
  sessionStart: 'command:new',
  sessionEnd: 'gateway:shutdown',
  userPromptSubmit: 'message:received',
  preCompact: 'session:compact:before',
  postCompact: 'session:compact:after',
  notification: 'message:sent',
}

export const openclaw: Adapter = {
  id: 'openclaw',
  name: 'OpenClaw',
  status: 'partial',
  install: 'write',
  docs: 'https://openclaw.ai/docs/hooks',
  notes: [
    'OpenClaw internal hooks are event-driven and non-blocking — there is no PreToolUse equivalent, so `deny()` degrades to a logged warning.',
    'For blocking policy on OpenClaw you want a Plugin hook (in-process), which hook-factory does not generate.',
    'Use a throwaway $HOME when testing: `--profile` alone does not fully isolate an existing install.',
  ],
  events: OPENCLAW_EVENTS,
  blocking: [],
  scopes: {
    project: { file: '.openclaw/hooks/hook-factory/handler.ts', format: 'js' },
    user: { file: '~/.openclaw/hooks/hook-factory/handler.ts', format: 'js' },
  },
  render(ctx) {
    const dir = ctx.scope === 'user' ? '~/.openclaw/hooks/hook-factory' : '.openclaw/hooks/hook-factory'
    const base = expandPath(dir, ctx.projectDir)
    const events = [...new Set(ctx.hooks.map((h) => OPENCLAW_EVENTS[h.event]).filter(Boolean))] as string[]
    const handler = `// generated by hook-factory — edit hooks.config.ts and run \`hf sync\`
import { spawn } from "node:child_process";

const EVENTS = ${JSON.stringify(events)};

export default async function handler(event) {
  const type = event.action ? \`\${event.type}:\${event.action}\` : event.type;
  if (!EVENTS.includes(type)) return;
  await new Promise((resolve) => {
    const child = spawn(${JSON.stringify(ctx.runner)}, ["run", "--agent", "openclaw", "--event", type], {
      stdio: ["pipe", "pipe", "inherit"],
      shell: true,
    });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.on("close", () => {
      try {
        const parsed = JSON.parse(out || "{}");
        if (parsed.systemMessage && Array.isArray(event.messages)) event.messages.push(parsed.systemMessage);
      } catch {}
      resolve();
    });
    child.stdin.end(JSON.stringify({ ...event.context, hook_event_name: type }));
  });
}
`
    const hookMd = `---
name: hook-factory
description: hooks compiled by hook-factory
emoji: "\u{1F3ED}"
---

Generated by hook-factory. Edit \`hooks.config.ts\` in your project and run \`hf sync\`.

Events: ${events.join(', ') || '(none)'}
`
    return {
      files: [],
      snippets: [],
      extras: [
        { path: `${base}/handler.ts`, content: handler },
        { path: `${base}/HOOK.md`, content: hookMd },
      ],
    }
  },
  parse(raw, nativeEvent) {
    const canonical = (Object.entries(OPENCLAW_EVENTS).find(([, v]) => v === nativeEvent)?.[0] as CanonicalEvent) ?? 'sessionStart'
    const ev = claudeStyleParse(raw, nativeEvent, 'openclaw', canonical)
    if (typeof raw.content === 'string') ev.prompt = raw.content
    if (typeof raw.workspaceDir === 'string') ev.cwd = raw.workspaceDir
    return ev
  },
  emit(decision) {
    if (!decision) return { code: 0 }
    if (decision.kind === 'deny') {
      return { code: 0, stderr: `hook-factory: ${decision.reason} (OpenClaw internal hooks cannot block)`, stdout: JSON.stringify({ systemMessage: decision.reason }) }
    }
    if (decision.kind === 'context') return { code: 0, stdout: JSON.stringify({ systemMessage: decision.text }) }
    if (decision.kind === 'warn') return { code: 0, stdout: JSON.stringify({ systemMessage: decision.message }) }
    return { code: 0 }
  },
}

// --- OpenCode --------------------------------------------------------------
// Bun plugin module in `.opencode/plugins/`. We write a shim that forwards to
// the hook-factory runtime.

const OPENCODE_EVENTS: Partial<Record<CanonicalEvent, string>> = {
  preToolUse: 'tool.execute.before',
  postToolUse: 'tool.execute.after',
  sessionStart: 'session.created',
  sessionEnd: 'session.deleted',
  postFileEdit: 'file.edited',
  permissionRequest: 'permission.asked',
  postCompact: 'session.compacted',
  stop: 'stop',
}

export const opencode: Adapter = {
  id: 'opencode',
  name: 'OpenCode',
  status: 'supported',
  install: 'write',
  docs: 'https://opencode.ai/docs/plugins/',
  notes: [
    'OpenCode plugins run on Bun. Tool args arrive nested under `output.args`, not on the input object.',
    'Throwing from `tool.execute.before` is how a plugin blocks a call — hook-factory does that for you on deny.',
  ],
  events: OPENCODE_EVENTS,
  blocking: ['preToolUse', 'stop'],
  scopes: {
    project: { file: '.opencode/plugins/hook-factory.js', format: 'js' },
    user: { file: '~/.config/opencode/plugins/hook-factory.js', format: 'js' },
  },
  render(ctx) {
    const file = ctx.scope === 'user' ? '~/.config/opencode/plugins/hook-factory.js' : '.opencode/plugins/hook-factory.js'
    const events = [...new Set(ctx.hooks.map((h) => OPENCODE_EVENTS[h.event]).filter(Boolean))] as string[]
    const src = `// generated by hook-factory — edit hooks.config.ts and run \`hf sync\`
import { spawn } from "node:child_process";

const RUNNER = ${JSON.stringify(ctx.runner)};
const EVENTS = ${JSON.stringify(events)};

function call(event, payload) {
  return new Promise((resolve) => {
    const child = spawn(RUNNER, ["run", "--agent", "opencode", "--event", event, "--raw"], {
      stdio: ["pipe", "pipe", "inherit"],
      shell: true,
    });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.on("close", () => {
      try { resolve(JSON.parse(out || "{}")); } catch { resolve({}); }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

export const HookFactory = async ({ directory }) => {
  const handlers = {};
  if (EVENTS.includes("tool.execute.before")) {
    handlers["tool.execute.before"] = async (input, output) => {
      const res = await call("tool.execute.before", {
        hook_event_name: "tool.execute.before",
        tool_name: input.tool,
        session_id: input.sessionID,
        tool_input: output.args ?? {},
        cwd: directory,
      });
      if (res.decision === "deny") throw new Error("hook-factory: " + (res.reason ?? "blocked"));
    };
  }
  if (EVENTS.includes("tool.execute.after")) {
    handlers["tool.execute.after"] = async (input, output) => {
      await call("tool.execute.after", {
        hook_event_name: "tool.execute.after",
        tool_name: input.tool,
        session_id: input.sessionID,
        tool_output: output,
        cwd: directory,
      });
    };
  }
  for (const e of EVENTS) {
    if (e === "tool.execute.before" || e === "tool.execute.after") continue;
    handlers[e] = async (payload) => { await call(e, { hook_event_name: e, cwd: directory, ...payload }); };
  }
  return handlers;
};

export default HookFactory;
`
    return { files: [], snippets: [], extras: [{ path: expandPath(file, ctx.projectDir), content: src }] }
  },
  parse(raw, nativeEvent) {
    const canonical = (Object.entries(OPENCODE_EVENTS).find(([, v]) => v === nativeEvent)?.[0] as CanonicalEvent) ?? 'preToolUse'
    return claudeStyleParse(raw, nativeEvent, 'opencode', canonical)
  },
  emit(decision) {
    if (!decision) return { code: 0, stdout: '{}' }
    if (decision.kind === 'deny') return { code: 0, stdout: JSON.stringify({ decision: 'deny', reason: decision.reason }) }
    if (decision.kind === 'context') return { code: 0, stdout: JSON.stringify({ context: decision.text }) }
    if (decision.kind === 'warn') return { code: 0, stderr: decision.message, stdout: '{}' }
    return { code: 0, stdout: '{}' }
  },
}

export type { HookEvent, RenderContext, RenderResult }

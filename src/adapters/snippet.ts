import type { Adapter, AdapterStatus, CanonicalEvent, Scope } from '../core/types.js'
import { emitYaml, serialize } from '../core/fs.js'
import { claudeStyleEmit, claudeStyleParse } from './claude-style.js'

/**
 * Some agents keep hooks in a hand-maintained YAML config, or in a format where
 * a machine rewrite would trash the user's comments and layout. For those we
 * generate the exact block and tell people where to paste it, rather than
 * quietly reformatting a file we don't fully own.
 */
export interface SnippetSpec {
  id: string
  name: string
  status?: AdapterStatus
  docs?: string
  notes?: string[]
  events: Partial<Record<CanonicalEvent, string>>
  blocking: readonly CanonicalEvent[]
  scopes: Partial<Record<'project' | 'user', Scope>>
  /** Build the config value to serialize into the snippet. */
  build(events: string[], runner: string): unknown
  instructions: string
}

export function snippetAdapter(spec: SnippetSpec): Adapter {
  const reverse = new Map<string, CanonicalEvent>()
  for (const [c, n] of Object.entries(spec.events)) if (n) reverse.set(n, c as CanonicalEvent)

  return {
    id: spec.id,
    name: spec.name,
    status: spec.status ?? 'partial',
    install: 'snippet',
    docs: spec.docs,
    notes: spec.notes,
    events: spec.events,
    blocking: spec.blocking,
    scopes: spec.scopes,
    render(ctx) {
      const scope = spec.scopes[ctx.scope] ?? spec.scopes.project ?? spec.scopes.user
      if (!scope) return { files: [], snippets: [], extras: [] }
      const events = [...new Set(ctx.hooks.map((h) => spec.events[h.event]).filter(Boolean))] as string[]
      if (events.length === 0) return { files: [], snippets: [], extras: [] }
      const value = spec.build(events, ctx.runner)
      const content = scope.format === 'yaml' ? emitYaml(value) : serialize(scope.format, value)
      return {
        files: [],
        snippets: [{ path: scope.file, format: scope.format, content, instructions: spec.instructions }],
        extras: [],
      }
    },
    parse(raw, nativeEvent) {
      return claudeStyleParse(raw, nativeEvent, spec.id, reverse.get(nativeEvent) ?? 'preToolUse')
    },
    emit: claudeStyleEmit,
  }
}

export const hermes: Adapter = snippetAdapter({
  id: 'hermes',
  name: 'Hermes',
  docs: 'https://hermes.dev/docs/hooks',
  notes: [
    'Hermes shell hooks live in a hand-written `~/.hermes/config.yaml`; hook-factory prints the block rather than rewriting your config.',
    'Hermes records trust by hook hash in `~/.hermes/shell-hooks-allowlist.json` — expect a re-approval prompt after every sync.',
  ],
  events: {
    preToolUse: 'pre_tool_call',
    postToolUse: 'post_tool_call',
    preModel: 'pre_llm_call',
    postModel: 'post_llm_call',
    sessionStart: 'on_session_start',
    sessionEnd: 'on_session_end',
    subagentStart: 'subagent_start',
    subagentStop: 'subagent_stop',
  },
  blocking: ['preToolUse'],
  scopes: { user: { file: '~/.hermes/config.yaml', format: 'yaml' } },
  build(events, runner) {
    const hooks: Record<string, unknown> = {}
    for (const e of events) {
      hooks[e] = [{ command: `${runner} run --agent hermes --event ${e}`, timeout: 30 }]
    }
    return { hooks }
  },
  instructions: 'Merge this into the top-level `hooks:` block of ~/.hermes/config.yaml, then approve the new hook hash on next run.',
})

export const piAgent: Adapter = snippetAdapter({
  id: 'pi-agent',
  name: 'Pi',
  docs: 'https://github.com/earendil-works/pi-coding-agent',
  notes: [
    'Requires the community `pi-yaml-hooks` package: `pi install npm:pi-yaml-hooks`.',
    'Live-tested: firing and exit-2 blocking work, but reading the tool input from inside a bash action is unconfirmed — `$TOOL_INPUT` was empty and `{{...}}` templating did not substitute. hook-factory pipes the payload on stdin instead.',
  ],
  events: {
    preToolUse: 'tool.before.*',
    postToolUse: 'tool.after.*',
    postFileEdit: 'file.changed',
    sessionStart: 'session.created',
  },
  blocking: ['preToolUse'],
  scopes: {
    project: { file: './.pi/hook/hooks.yaml', format: 'yaml' },
    user: { file: '~/.pi/agent/hook/hooks.yaml', format: 'yaml' },
  },
  build(events, runner) {
    return {
      hooks: events.map((e) => ({
        event: e,
        actions: [{ bash: `${runner} run --agent pi-agent --event ${e}` }],
      })),
    }
  },
  instructions: 'Write this to ~/.pi/agent/hook/hooks.yaml (global) or ./.pi/hook/hooks.yaml (project). Note hooks.yaml does NOT live at the project root.',
})

export const kiro: Adapter = snippetAdapter({
  id: 'kiro',
  name: 'Kiro CLI',
  docs: 'https://kiro.dev/docs/cli/',
  notes: ['Kiro keeps hooks inside a hand-written `config.yaml` alongside MCP servers and settings, so hook-factory prints rather than rewrites.'],
  events: {
    sessionStart: 'agentSpawn',
    userPromptSubmit: 'userPromptSubmit',
    preToolUse: 'preToolUse',
    postToolUse: 'postToolUse',
    stop: 'stop',
  },
  blocking: ['preToolUse', 'stop'],
  scopes: {
    project: { file: '.kiro/config.yaml', format: 'yaml' },
    user: { file: '~/.kiro/config.yaml', format: 'yaml' },
  },
  build(events, runner) {
    const hooks: Record<string, unknown> = {}
    for (const e of events) hooks[e] = [{ command: `${runner} run --agent kiro --event ${e}` }]
    return { hooks }
  },
  instructions: 'Merge into the `hooks:` key of .kiro/config.yaml (project) or ~/.kiro/config.yaml (global).',
})

export const amazonQ: Adapter = snippetAdapter({
  id: 'amazon-q-dev-cli',
  name: 'Amazon Q Developer CLI',
  docs: 'https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/command-line-hooks.html',
  notes: [
    'Q declares hooks inside a specific agent JSON, not a standalone hooks file — which agent depends on your setup, so hook-factory prints the block.',
    'Only exit code 2 blocks a preToolUse; there is no structured JSON decision object.',
    '`agentSpawn` hooks are never cached, regardless of cache_ttl_seconds.',
  ],
  events: {
    sessionStart: 'agentSpawn',
    userPromptSubmit: 'userPromptSubmit',
    preToolUse: 'preToolUse',
    postToolUse: 'postToolUse',
    stop: 'stop',
  },
  blocking: ['preToolUse'],
  scopes: {
    project: { file: '.amazonq/cli-agents/<your-agent>.json', format: 'json' },
    user: { file: '~/.aws/amazonq/cli-agents/<your-agent>.json', format: 'json' },
  },
  build(events, runner) {
    const hooks: Record<string, unknown> = {}
    for (const e of events) {
      hooks[e] = [
        {
          command: `${runner} run --agent amazon-q-dev-cli --event ${e}`,
          timeout_ms: 30000,
          cache_ttl_seconds: 0,
        },
      ]
    }
    return { hooks }
  },
  instructions: 'Merge into the `hooks` key of the agent JSON you actually run (e.g. .amazonq/cli-agents/default.json).',
})

export const amp: Adapter = snippetAdapter({
  id: 'amp',
  name: 'Amp',
  docs: 'https://ampcode.com/manual#plugins',
  notes: [
    'Amp has no declarative hooks config — extensibility goes through the TypeScript Plugin API.',
    'This snippet is a plugin that forwards Amp lifecycle events into the hook-factory runtime.',
  ],
  events: {
    preToolUse: 'tool.call',
    postToolUse: 'tool.result',
    sessionStart: 'session.start',
    userPromptSubmit: 'agent.start',
    stop: 'agent.end',
  },
  blocking: ['preToolUse', 'stop'],
  scopes: {
    project: { file: '.amp/plugins/hook-factory.ts', format: 'js' },
    user: { file: '~/.config/amp/plugins/hook-factory.ts', format: 'js' },
  },
  build(events, runner) {
    return `// generated by hook-factory
import { spawn } from "node:child_process";

const RUNNER = ${JSON.stringify(runner)};
const EVENTS = ${JSON.stringify(events)};

function call(event, payload) {
  return new Promise((resolve) => {
    const child = spawn(RUNNER, ["run", "--agent", "amp", "--event", event, "--raw"], {
      stdio: ["pipe", "pipe", "inherit"], shell: true,
    });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.on("close", () => { try { resolve(JSON.parse(out || "{}")); } catch { resolve({}); } });
    child.stdin.end(JSON.stringify(payload));
  });
}

for (const event of EVENTS) {
  amp.on(event, async (e) => {
    const res = await call(event, { hook_event_name: event, tool_name: e.tool, tool_input: e.input, cwd: process.cwd() });
    if (event === "tool.call" && res.decision === "deny") {
      return { action: "reject-and-continue", message: res.reason };
    }
    return { action: "allow" };
  });
}
`
  },
  instructions: 'Save as .amp/plugins/hook-factory.ts, then run `plugins: reload` from the Amp command palette.',
})

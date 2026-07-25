<div align="center">

# 🏭 hook-factory

**One hook config. Every coding agent.**

Write a guardrail once - hook-factory compiles it into Claude Code, Codex, Cursor, Gemini CLI, Copilot, and 21 other agents' native hook formats.

[![npm](https://img.shields.io/npm/v/hook-factory?color=7C3AED)](https://www.npmjs.com/package/hook-factory)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![agents](https://img.shields.io/badge/agents-26-A78BFA)](#supported-agents)

</div>

---

Every agent invented its own hook system. Claude Code calls it `PreToolUse`, Gemini calls it `BeforeTool`, Cursor splits it into `preToolUse` and `beforeShellExecution`, OpenHands calls it `pre_tool_use`. The shell tool is `Bash` here, `terminal` there, `run_shell_command` somewhere else. Denial is exit code 2 on one, `{"decision":"deny"}` on another, `{"decision":"block"}` on a third — and copying the wrong one fails silently.

hook-factory is one config that speaks all of them.

```ts
// hooks.config.ts
import { defineHooks, onPreToolUse, match, deny } from 'hook-factory'
import { secretGuard } from 'hook-factory/plugins'

export default defineHooks({
  agents: ['claude-code', 'codex', 'cursor', 'gemini-cli', 'goose'],

  hooks: [
    secretGuard(),

    onPreToolUse(
      match.shell(/\bsudo\b/),
      deny('No sudo from the agent.'),
    ),
  ],
})
```

```console
$ npx hook-factory sync
✓ .claude/settings.json
✓ .codex/hooks.json
✓ .cursor/hooks.json
✓ .gemini/settings.json
✓ .agents/plugins/hook-factory/hooks/hooks.json
```

That one `match.shell()` now covers `Bash`, `terminal`, `run_shell_command`, `execute_bash`, `launch-process`, and `shell` — because normalizing that table is hook-factory's job, not yours.

---

## Install

Requires **Node ≥ 20.11**. Zero runtime dependencies.

### Per project (recommended)

```bash
npm install --save-dev hook-factory
```

<details>
<summary>pnpm · yarn · bun</summary>

```bash
pnpm add -D hook-factory
yarn add -D hook-factory
bun add -d hook-factory
```
</details>

A local install is worth it: the hooks in your agent configs then point at `node_modules/.bin/hook-factory` directly, instead of resolving through `npx` on **every single tool call**. `doctor` warns you if you're on the slow path.

### Globally

```bash
npm install -g hook-factory
```

Gives you `hook-factory` and the shorter `hf` on your PATH.

### Without installing

```bash
npx hook-factory@latest init
```

Fine for trying it out. Install it properly before relying on it in a real project.

### From source

```bash
git clone https://github.com/Ar9av/hook-factory
cd hook-factory
npm install        # builds automatically via the prepare script
npm test
node dist/cli.js --help
```

Or install the git version straight into a project — it builds on install:

```bash
npm install --save-dev github:Ar9av/hook-factory
```

### Then

```bash
npx hook-factory init      # writes hooks.config, detecting agents you already use
npx hook-factory sync      # compiles into every enabled agent's native config
npx hook-factory doctor    # confirms it's actually wired up
```

`init` writes `hooks.config.ts` in an ESM project and `hooks.config.mts` in a CommonJS one, because Node loads a bare `.ts` file as CommonJS there and every `import` line would throw.

---

## Managing agents

```console
$ hook-factory agent list

Agents — 5 enabled of 26

[✓]  claude-code       Claude Code        full     installed  ●  ■  ■  ●  ·  ■
[✓]  codex             Codex CLI          full     installed  ●  ■  ■  ●  ·  ■
[✓]  cursor            Cursor             full     installed  ●  ■  ■  ●  ■  ●
[ ]  qwen-code         Qwen Code          full     —          ●  ■  ■  ■  ·  ■
[ ]  aider             Aider              none     —          ·  ·  ·  ·  ·  ·

  ■ can block   ● fires, cannot block   · unsupported
```

```bash
hook-factory agent add cursor gemini-cli   # enable agents
hook-factory agent add --detected          # enable everything found on this machine
hook-factory agent remove aider
hook-factory agent detect                  # what's installed here?
hook-factory agent info codex              # events, config paths, known caveats
```

`agent add`/`remove` edit the `agents: []` array in your config in place — comments and formatting survive. `agent info` is the one to reach for before trusting a rule on an unfamiliar agent:

```console
$ hook-factory agent info codex

Codex CLI (codex)  full
https://developers.openai.com/codex/hooks

sync writes its config directly

Config
  project  .codex/hooks.json (json)
  user     ~/.codex/hooks.json (json)

Events — 10 mapped, 5 can block
  ■  preToolUse   →  PreToolUse    can block
  ●  postToolUse  →  PostToolUse   observe only
  …

Worth knowing
  · Codex requires you to trust a hook before it first runs — use `/hooks` in the
    CLI, or `--dangerously-bypass-hook-trust` for automation.
  · Blocking is reliable via exit 2 + stderr; the stdout `permissionDecision: deny`
    path did not block in a live v0.145.0 test.
```

---

## Watching hooks work

Hooks are normally invisible. They run in a subprocess your agent spawns, so when a rule misbehaves there's nothing to look at — you can't tell a matcher that never fired from a handler that passed from one that threw.

```bash
npx hook-factory watch
```

Leave it in a second terminal while you work. Every tool call your agents make shows up live, across all of them at once:

```console
 hook-factory watch · live  ~/code/my-app
  7 calls   5 blocked   0 acted   2 passed   claude-code cursor codex gemini-cli
  last 60s ▁▂▅█▃▂▁·········································  7 shown
──────────────────────────────────────────────────────────────────────────

· 09:14:22 claude-code    Bash             npm test  4ms
■ 09:14:24 claude-code    Bash             rm -rf ./build  1ms
           └ hook-factory/no-rm-rf: refusing `rm -rf ./build` — recursive force delete
■ 09:14:26 claude-code    Write            src/config.ts  1ms
           └ hook-factory/secret-guard: this looks like a AWS access key id
■ 09:14:31 cursor         Read             /proj/.env  0ms
           └ hook-factory/secret-guard: reading /proj/.env would pull credentials…
· 09:14:35 gemini-cli     Bash             ls -la  2ms

──────────────────────────────────────────────────────────────────────────
  f everything  ·  d detail  ·  p pause  ·  c clear view  ·  x wipe journal  ·  q quit
```

Press `d` for the part that answers *why didn't my rule fire?* — every hook that ran, whether it decided anything, and how many were filtered out by their matchers:

```console
· 09:14:22 claude-code    Bash             npm test  4ms
           · pass audit-log/record
■ 09:14:24 claude-code    Bash             rm -rf ./build  1ms
           └ hook-factory/no-rm-rf: refusing `rm -rf ./build` — recursive force delete
           · hit no-rm-rf/block-dangerous
· 09:14:35 gemini-cli     Bash             ls -la  2ms
           · no hook matched (3 filtered out by matchers)
```

Slow hooks are called out in yellow, because a `PreToolUse` hook is latency your agent pays on every single tool call.

It's plain ANSI with no dependencies, so it ships in the tarball and runs anywhere `npx` does.

### Piping it

```bash
hook-factory watch --plain            # tab-separated, follows
hook-factory watch --json             # JSONL, for jq or a log shipper
hook-factory watch --plain --once     # dump history and exit
hook-factory watch --clear            # wipe the journal
```

It writes to `.hookfactory/events.jsonl` (gitignored by `init`), capped at 5 MB with rotation. **Credentials are redacted before anything is written** — an observability tool that logs the secrets it exists to catch would be worse than none. Journalling never throws: a full disk or read-only checkout costs you the log, not the tool call. Disable it per-call with `--no-journal`.

---

## How it works

```
 hooks.config.ts ──► hook-factory sync ──► .claude/settings.json
                                       ├─► .codex/hooks.json
                                       └─► .cursor/hooks.json   (etc.)

 agent fires hook ──► hook-factory run --agent X --event Y
                          │
                     normalize stdin  ─►  your handler  ─►  agent's native
                     (26 dialects)         (one shape)       exit code + JSON
```

Your handlers never see an agent-specific payload and never emit an agent-specific decision. Adapters own both translations.

**Sync is safe to re-run.** Everything hook-factory writes is tagged `_hookFactory: true`, so it merges into config you already have, replaces rather than duplicates on re-sync, and `unsync` removes exactly its own entries and nothing else.

---

## Writing hooks

### Events

19 canonical events, mapped onto whatever each agent calls them:

`sessionStart` `sessionEnd` `userPromptSubmit` `preToolUse` `postToolUse` `postToolUseFailure` `permissionRequest` `preShell` `postShell` `preReadFile` `postFileEdit` `preModel` `postModel` `subagentStart` `subagentStop` `preCompact` `postCompact` `notification` `stop`

If an agent has no equivalent, `sync` says so out loud rather than silently dropping the hook.

### Matchers

```ts
match.shell(/rm -rf/)              // any shell tool on any agent
match.edit('src/**/*.ts')          // any write tool, filtered by glob
match.read('.env*')                // any read tool
match.tool('Write', /^mcp__/)      // by name
match.path('migrations/**')        // by path, whatever the tool
match.prompt(/deploy/)             // on userPromptSubmit
match.mcp('github')                // MCP tools, across all naming schemes
match.and(a, b)  match.or(a, b)  match.not(a)  match.where(ev => ...)
```

### Actions

```ts
deny('reason')          // block it; the reason goes to the model
allow()  ask()          // override the permission prompt
inject('text')          // add to the agent's context
warn('message')         // surface without blocking
keepGoing('not done')   // on `stop`: refuse to finish
shell('prettier {{filePath}}', { denyOnFailure: true })
notify('done', { target: 'slack' })
appendFile('audit.jsonl', ev => JSON.stringify(ev))
```

Or skip them — a handler is just a function:

```ts
onPreToolUse(match.shell(), async (ev, ctx) => {
  const { code } = await ctx.exec('git diff --quiet')
  if (code !== 0) return { kind: 'ask', reason: 'uncommitted changes present' }
})
```

---

## Built-in plugins

```bash
npx hook-factory add secret-guard
```

| Plugin | What it does |
|---|---|
| `secret-guard` | Blocks writes containing credentials, and reads of `.env` / key files |
| `no-rm-rf` | Refuses `rm -rf`, force push, `git reset --hard`, `curl \| sh`, `terraform destroy` |
| `protect-paths` | Makes chosen globs read-only to the agent |
| `branch-guard` | No commits or pushes straight onto `main` |
| `test-gate` | Won't let the agent stop while tests are failing |
| `auto-format` | prettier / ruff / gofmt / rustfmt after each edit |
| `audit-log` | JSONL trail of every shell command and edit |
| `prompt-scrub` | Refuses prompts with a pasted credential in them |
| `notify-on-finish` | Desktop or Slack ping when a turn ends |
| `context-inject` | Text or command output at session start |

A plugin is a `definePlugin({ name, hooks })` call using exactly the public API — nothing is privileged. Publish one to npm and people import it like any other module.

---

## Supported agents

**Auto-installed** — `sync` writes the config directly:

`claude-code` `codex` `cursor` `gemini-cli` `qwen-code` `github-copilot` `factory-droid` `devin-cli` `openhands` `auggie` `goose` `crush` `kimi-code` `opencode` `openclaw` `continue-cli` `google-antigravity`

**Paste-in** — the format is hand-maintained, so `sync` prints an exact block instead of rewriting your file:

`hermes` `pi-agent` `kiro` `amazon-q-dev-cli` `amp`

**No hook system** — registered so hook-factory can tell you the closest alternative:

`aider` (lint/test gates) · `warp` (agent profiles + command allowlist) · `trae` / `trae-cn` (MCP-based validation)

### Caveats hook-factory knows about

Adapters carry the sharp edges as notes, surfaced by `agent info`, `sync`, and `doctor`:

- **Codex** requires trusting a hook before first run (`/hooks`, or `--dangerously-bypass-hook-trust`). Its documented stdout `permissionDecision: deny` path did not block in a live v0.145.0 test — hook-factory uses exit 2, which does.
- **Continue CLI** hooks did not fire at all in headless (`-p`) mode in a live v1.5.47 test, for any event or config location. Don't rely on them in CI.
- **OpenHands** names its shell tool `terminal`; a matcher of `bash` silently never fires.
- **Crush** spells denial `deny`, not `block` — a hook copied from goose loses its reason.
- **Qwen Code** needs `-y` for shell calls to execute non-interactively at all.
- **OpenClaw** internal hooks can't block, so `deny()` degrades to a warning there.
- **Aider** passes `--no-verify` on auto-commits, so your git pre-commit hooks are skipped by default.

---

## Commands

```
init [agents...]      Create hooks.config, detecting agents you already use
sync [--dry-run]      Compile hooks into every agent's native config
unsync                Remove every hook-factory block

agent list            Every supported agent, and which ones you've enabled
agent add <id...>     Enable an agent  (--detected for all found locally)
agent remove <id...>  Disable an agent
agent detect          Scan this machine for agents you already have
agent info <id>       Events, blocking capability, config paths, caveats

add / remove          Toggle a built-in plugin in your config
list                  Hooks, plugins, agents, capability matrix
doctor                What's installed, wired up, and actually blocking
test <event>          Fire a synthetic event through your hooks, changing nothing
watch                 Live monitor: every hook firing, and what it decided
```

`test` is the fastest way to know a rule works before trusting it:

```console
$ npx hook-factory test preToolUse --tool Bash --command "sudo rm -rf /"

  ■ Claude Code    DENY — refusing `sudo rm -rf /` — recursive force delete
  ■ Codex CLI      DENY — refusing `sudo rm -rf /` — recursive force delete
  ■ Cursor         DENY — refusing `sudo rm -rf /` — recursive force delete
  ■ goose          DENY — refusing `sudo rm -rf /` — recursive force delete
```

Add `--json` to any command for machine-readable output.

---

## Adding an agent

```ts
import { defineAdapter, claudeStyle } from 'hook-factory'

// Most agents copied Claude Code's shape with small mutations:
const myAgent = claudeStyle({
  id: 'my-agent',
  name: 'My Agent',
  events: { preToolUse: 'BeforeTool', stop: 'OnFinish' },
  blocking: ['preToolUse'],
  scopes: { project: { file: '.myagent/hooks.json', format: 'json' } },
  timeout: { key: 'timeoutSec', unit: 's' },
})

export default defineHooks({ adapters: [myAgent], agents: ['my-agent'], hooks: [...] })
```

For a genuinely different shape, implement `render` / `parse` / `emit` directly — see `src/adapters/distinct.ts`.

---

## Design notes

**Fail open.** A hook that throws or times out logs to stderr and lets the tool call proceed. A broken guardrail shouldn't be able to wedge someone's coding session.

**Deny never ends the session.** Verified against Claude Code: emitting `continue: false` on a denied tool call terminates the run and the user gets an empty response. hook-factory sends exit 2 + the reason instead, so the model reads why and routes around it. Blocking one tool call costs one tool call.

**Matchers push down where possible.** Tool-name filters go into the native config, so agents skip spawning the dispatcher for calls no hook cares about.

**Severity, not order.** A `deny` from the third hook isn't overwritten by an `allow` from the fourth; `context` injections accumulate.

---

## Provenance

The adapter data comes from [agent-manual](https://github.com/ar9av/agent-manual) — a sourced catalog where each tool's hook system was verified against official docs and, for many, live-tested against a real install. Where docs and observed behaviour disagreed, hook-factory implements what actually worked and records the discrepancy as an adapter note.

## License

MIT

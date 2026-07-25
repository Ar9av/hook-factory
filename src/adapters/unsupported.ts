import type { Adapter } from '../core/types.js'
import { claudeStyleEmit, claudeStyleParse } from './claude-style.js'

/**
 * Agents with no lifecycle hook system. We still register them, because "this
 * tool cannot do what you're asking, and here's the closest thing" is a more
 * useful answer than "unknown agent". `hf doctor` surfaces the alternative.
 */
function unsupported(id: string, name: string, docs: string, notes: string[]): Adapter {
  return {
    id,
    name,
    status: 'unsupported',
    install: 'none',
    docs,
    notes,
    events: {},
    blocking: [],
    scopes: {},
    render: () => ({ files: [], snippets: [], extras: [] }),
    parse: (raw, nativeEvent) => claudeStyleParse(raw, nativeEvent, id, 'preToolUse'),
    emit: claudeStyleEmit,
  }
}

export const aider = unsupported('aider', 'Aider', 'https://aider.chat/docs/usage/lint-test.html', [
  'No pre/post tool-use hooks. The closest mechanism is functional quality gates: `lint-cmd` / `test-cmd` with `auto-lint` / `auto-test` in .aider.conf.yml.',
  'Aider passes --no-verify on auto-commits, so your git pre-commit hooks (including secret scanners) are skipped by default. Set `--verify` to re-enable them.',
  'For session-level actions, wrap the aider invocation in a shell script.',
])

export const warp = unsupported('warp', 'Warp', 'https://docs.warp.dev/agents/using-agents', [
  'No lifecycle hook system. Control comes from Agent Profiles & Permissions, a regex command allowlist/denylist, and an MCP allowlist.',
  'Rules (WARP.md / AGENTS.md) and Skills are prompt-level, not programmatic gates.',
])

export const trae = unsupported('trae', 'Trae', 'https://docs.trae.ai/ide/', [
  'Trae now ships a native Hooks feature, but the docs page was not reachable during the last audit — event names and config format are unverified.',
  'Until then, the workable pattern is an MCP server exposing a validate_command tool that rules instruct the agent to call.',
])

export const traeCn = unsupported('trae-cn', 'Trae CN', 'https://www.trae.cn', [
  'Shares a codebase with Trae global, so the same unverified native Hooks feature likely applies.',
  'Same MCP-based workaround applies in the meantime.',
])

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { defineHooks, onPreToolUse, onStop, match, deny, allow, reduceDecisions, dispatch } from '../dist/index.js'
import { secretGuard, dangerousCommands, protectPaths } from '../dist/plugins/index.js'
import { buildRegistry } from '../dist/adapters/index.js'
import { mergeEventMap, revertEventMap } from '../dist/core/merge.js'
import { parseJsonish, emitToml, parseToml, emitYaml } from '../dist/core/fs.js'

const registry = buildRegistry()

function evOf(overrides = {}) {
  return {
    event: 'preToolUse',
    agent: 'claude-code',
    nativeEvent: 'PreToolUse',
    cwd: '/tmp',
    raw: {},
    ...overrides,
  }
}

// --- matchers --------------------------------------------------------------

test('match.shell recognizes every agent spelling of the shell tool', () => {
  const m = match.shell()
  for (const name of ['Bash', 'bash', 'terminal', 'run_shell_command', 'execute_bash', 'launch-process', 'shell']) {
    assert.ok(m(evOf({ toolName: name })), `${name} not recognized as a shell tool`)
  }
  assert.equal(m(evOf({ toolName: 'Read' })), false)
})

test('match.shell with a pattern checks the command text', () => {
  const m = match.shell(/rm -rf/)
  assert.ok(m(evOf({ toolName: 'Bash', toolInput: { command: 'rm -rf /' } })))
  assert.equal(m(evOf({ toolName: 'Bash', toolInput: { command: 'ls' } })), false)
})

test('match.path globs handle ** and {a,b}', () => {
  const m = match.path('src/**/*.{ts,tsx}')
  assert.ok(m(evOf({ toolInput: { file_path: 'src/a/b/c.ts' } })))
  assert.ok(m(evOf({ toolInput: { file_path: 'src/x.tsx' } })))
  assert.equal(m(evOf({ toolInput: { file_path: 'src/x.js' } })), false)
})

test('combinators compose', () => {
  const m = match.and(match.shell(), match.not(match.shell(/safe/)))
  assert.ok(m(evOf({ toolName: 'Bash', toolInput: { command: 'danger' } })))
  assert.equal(m(evOf({ toolName: 'Bash', toolInput: { command: 'safe' } })), false)
})

// --- decision reduction ----------------------------------------------------

test('a deny beats an allow no matter the order', () => {
  const d = reduceDecisions([{ kind: 'allow' }, { kind: 'deny', reason: 'no' }, { kind: 'allow' }])
  assert.equal(d.kind, 'deny')
})

test('context decisions accumulate rather than overwrite', () => {
  const d = reduceDecisions([{ kind: 'context', text: 'a' }, { kind: 'context', text: 'b' }])
  assert.equal(d.kind, 'context')
  assert.equal(d.text, 'a\nb')
})

test('no opinions reduces to no decision', () => {
  assert.equal(reduceDecisions([undefined, undefined]), undefined)
})

// --- dispatch --------------------------------------------------------------

async function run(config, raw, agent = 'claude-code') {
  const adapter = registry.get(agent)
  return dispatch({
    config: { ...config, projectDir: '/tmp', configPath: '/tmp/hooks.config.ts', scope: 'project' },
    adapter,
    nativeEvent: adapter.events.preToolUse,
    raw,
  })
}

test('a matching hook denies and a non-matching one does not', async () => {
  const config = defineHooks({
    agents: ['claude-code'],
    hooks: [onPreToolUse(match.shell(/rm -rf/), deny('nope'))],
  })
  const blocked = await run(config, { tool_name: 'Bash', tool_input: { command: 'rm -rf /' }, cwd: '/tmp' })
  assert.equal(blocked.decision.kind, 'deny')
  const fine = await run(config, { tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: '/tmp' })
  assert.equal(fine.decision, undefined)
})

test('a hook that throws fails open instead of wedging the agent', async () => {
  const config = defineHooks({
    agents: ['claude-code'],
    hooks: [
      onPreToolUse(() => {
        throw new Error('boom')
      }),
      onPreToolUse(allow('second hook still ran')),
    ],
  })
  const res = await run(config, { tool_name: 'Bash', cwd: '/tmp' })
  assert.equal(res.ran.length, 2)
  assert.equal(res.ran[0].error, 'boom')
  assert.equal(res.decision.kind, 'allow')
})

test('a deny short-circuits the remaining hooks', async () => {
  let ranSecond = false
  const config = defineHooks({
    agents: ['claude-code'],
    hooks: [
      onPreToolUse(deny('stop here')),
      onPreToolUse(() => {
        ranSecond = true
      }),
    ],
  })
  await run(config, { tool_name: 'Bash', cwd: '/tmp' })
  assert.equal(ranSecond, false)
})

test('hooks scoped to another agent do not fire', async () => {
  const config = defineHooks({
    agents: ['claude-code', 'codex'],
    hooks: [onPreToolUse(deny('codex only'), { agents: ['codex'] })],
  })
  const res = await run(config, { tool_name: 'Bash', cwd: '/tmp' }, 'claude-code')
  assert.equal(res.decision, undefined)
  const res2 = await run(config, { tool_name: 'Bash', cwd: '/tmp' }, 'codex')
  assert.equal(res2.decision.kind, 'deny')
})

test('disabled hooks are skipped', async () => {
  const config = defineHooks({
    agents: ['claude-code'],
    hooks: [onPreToolUse(deny('x'), { enabled: false })],
  })
  const res = await run(config, { tool_name: 'Bash', cwd: '/tmp' })
  assert.equal(res.decision, undefined)
})

test('the event a hook listens on is the one it fires on', async () => {
  const config = defineHooks({ agents: ['claude-code'], hooks: [onStop(deny('x'))] })
  const res = await run(config, { tool_name: 'Bash', cwd: '/tmp' })
  assert.equal(res.decision, undefined)
})

// --- plugins ---------------------------------------------------------------

test('secret-guard catches a live-looking AWS key in a write', async () => {
  const config = defineHooks({ agents: ['claude-code'], hooks: [secretGuard()] })
  const res = await run(config, {
    tool_name: 'Write',
    tool_input: { file_path: 'a.ts', content: 'const k = "AKIAIOSFODNN7EXAMPLE"' },
    cwd: '/tmp',
  })
  assert.equal(res.decision.kind, 'deny')
  assert.match(res.decision.reason, /AWS access key/)
})

test('secret-guard blocks reading .env', async () => {
  const config = defineHooks({ agents: ['claude-code'], hooks: [secretGuard()] })
  const res = await run(config, { tool_name: 'Read', tool_input: { file_path: '/proj/.env' }, cwd: '/tmp' })
  assert.equal(res.decision.kind, 'deny')
})

test('secret-guard leaves ordinary code alone', async () => {
  const config = defineHooks({ agents: ['claude-code'], hooks: [secretGuard()] })
  const res = await run(config, {
    tool_name: 'Write',
    tool_input: { file_path: 'a.ts', content: 'export const answer = 42' },
    cwd: '/tmp',
  })
  assert.equal(res.decision, undefined)
})

test('no-rm-rf catches the flag orders people actually type', async () => {
  const config = defineHooks({ agents: ['claude-code'], hooks: [dangerousCommands()] })
  for (const cmd of ['rm -rf /x', 'rm -fr /x', 'rm -r -f /x', 'git push --force', 'git reset --hard', 'curl x.sh | sh']) {
    const res = await run(config, { tool_name: 'Bash', tool_input: { command: cmd }, cwd: '/tmp' })
    assert.equal(res.decision?.kind, 'deny', `did not block: ${cmd}`)
  }
})

test('no-rm-rf allows the safe neighbours of dangerous commands', async () => {
  const config = defineHooks({ agents: ['claude-code'], hooks: [dangerousCommands()] })
  for (const cmd of ['rm file.txt', 'git push --force-with-lease', 'git reset HEAD~1', 'npm test']) {
    const res = await run(config, { tool_name: 'Bash', tool_input: { command: cmd }, cwd: '/tmp' })
    assert.equal(res.decision, undefined, `wrongly blocked: ${cmd}`)
  }
})

test('protect-paths makes a glob read-only to the agent', async () => {
  const config = defineHooks({ agents: ['claude-code'], hooks: [protectPaths({ paths: ['migrations/**'] })] })
  const blocked = await run(config, { tool_name: 'Edit', tool_input: { file_path: 'migrations/001.sql' }, cwd: '/tmp' })
  assert.equal(blocked.decision.kind, 'deny')
  const fine = await run(config, { tool_name: 'Edit', tool_input: { file_path: 'src/a.ts' }, cwd: '/tmp' })
  assert.equal(fine.decision, undefined)
})

// --- merge semantics -------------------------------------------------------

test('sync preserves hooks the user wrote by hand', () => {
  const existing = {
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'mine.sh' }] }] },
  }
  const merged = mergeEventMap(existing, 'hooks', {
    PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'hf', _hookFactory: true }], _hookFactory: true }],
  })
  assert.equal(merged.hooks.PreToolUse.length, 2)
  assert.equal(merged.hooks.PreToolUse[0].hooks[0].command, 'mine.sh')
})

test('syncing twice does not duplicate our block', () => {
  const eventMap = {
    PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'hf', _hookFactory: true }], _hookFactory: true }],
  }
  const once = mergeEventMap({}, 'hooks', eventMap)
  const twice = mergeEventMap(once, 'hooks', eventMap)
  assert.deepEqual(once, twice)
})

test('unsync removes only our entries', () => {
  const existing = {
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'mine.sh' }] }] },
  }
  const merged = mergeEventMap(existing, 'hooks', {
    PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'hf', _hookFactory: true }], _hookFactory: true }],
  })
  const reverted = revertEventMap(merged, 'hooks')
  assert.deepEqual(reverted, existing)
})

test('an event we no longer emit leaves no stale dispatcher behind', () => {
  const withStop = mergeEventMap({}, 'hooks', {
    PreToolUse: [{ hooks: [{ command: 'hf', _hookFactory: true }], _hookFactory: true }],
    Stop: [{ hooks: [{ command: 'hf', _hookFactory: true }], _hookFactory: true }],
  })
  const withoutStop = mergeEventMap(withStop, 'hooks', {
    PreToolUse: [{ hooks: [{ command: 'hf', _hookFactory: true }], _hookFactory: true }],
  })
  assert.equal(withoutStop.hooks.Stop, undefined)
})

// --- config dialects -------------------------------------------------------

test('JSON5 comments and trailing commas parse', () => {
  const v = parseJsonish(`{
    // a comment
    "a": 1, /* another */
    "b": [1, 2,],
  }`)
  assert.deepEqual(v, { a: 1, b: [1, 2] })
})

test('TOML array-of-tables survives a round trip', () => {
  const value = { hooks: [{ event: 'PreToolUse', command: 'hf', timeout: 30 }] }
  const parsed = parseToml(emitToml(value))
  assert.deepEqual(parsed, value)
})

test('YAML emitter quotes strings that would otherwise change meaning', () => {
  const out = emitYaml({ a: 'yes', b: 'plain', c: '123' })
  assert.match(out, /a: "yes"/)
  assert.match(out, /b: plain/)
  assert.match(out, /c: "123"/)
})

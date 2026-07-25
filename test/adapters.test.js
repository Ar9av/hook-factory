import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BUILTIN_ADAPTERS, buildRegistry, resolveAgentId } from '../dist/adapters/index.js'
import { CANONICAL_EVENTS, BLOCKABLE_EVENTS } from '../dist/index.js'

const registry = buildRegistry()

test('every adapter has a unique id', () => {
  const ids = BUILTIN_ADAPTERS.map((a) => a.id)
  assert.equal(new Set(ids).size, ids.length)
})

test('every adapter covers the 26 tools tracked in agent-manual', () => {
  assert.equal(BUILTIN_ADAPTERS.length, 26)
})

test('adapters only claim canonical events', () => {
  for (const a of BUILTIN_ADAPTERS) {
    for (const e of Object.keys(a.events)) {
      assert.ok(CANONICAL_EVENTS.includes(e), `${a.id} declares unknown event ${e}`)
    }
  }
})

test('an adapter can only block on events it actually supports', () => {
  for (const a of BUILTIN_ADAPTERS) {
    for (const e of a.blocking) {
      assert.ok(a.events[e], `${a.id} claims it can block ${e} but has no such event`)
    }
  }
})

test('blocking claims stay within events that are blockable in principle', () => {
  for (const a of BUILTIN_ADAPTERS) {
    for (const e of a.blocking) {
      assert.ok(BLOCKABLE_EVENTS.includes(e), `${a.id} claims blocking on non-blockable ${e}`)
    }
  }
})

test('unsupported adapters declare no events and write nothing', () => {
  for (const a of BUILTIN_ADAPTERS.filter((x) => x.status === 'unsupported')) {
    assert.equal(Object.keys(a.events).length, 0)
    assert.equal(a.install, 'none')
    const r = a.render({ hooks: [], runner: 'hf', projectDir: '/tmp', scope: 'project' })
    assert.equal(r.files.length, 0)
    assert.ok(a.notes && a.notes.length > 0, `${a.id} should explain the alternative`)
  }
})

test('aliases resolve to real adapters', () => {
  for (const alias of ['claude', 'gemini', 'copilot', 'droid', 'qwen', 'cn', 'q']) {
    assert.ok(registry.has(resolveAgentId(alias)), `${alias} did not resolve`)
  }
})

test('a deny emits a blocking exit code on every write-mode adapter', () => {
  for (const a of BUILTIN_ADAPTERS.filter((x) => x.install === 'write' && x.blocking.length)) {
    const ev = a.parse({ tool_name: 'Bash', cwd: '/tmp' }, a.events[a.blocking[0]])
    const out = a.emit({ kind: 'deny', reason: 'nope' }, ev)
    assert.ok(out.code !== 0 || (out.stdout && /deny|block/.test(out.stdout)), `${a.id} deny is a no-op`)
  }
})

test('deny never sets continue:false, which would end the whole session', () => {
  for (const a of BUILTIN_ADAPTERS) {
    const native = a.events.preToolUse ?? 'PreToolUse'
    const ev = a.parse({ tool_name: 'Bash', cwd: '/tmp' }, native)
    const out = a.emit({ kind: 'deny', reason: 'nope' }, ev)
    if (!out.stdout) continue
    const parsed = JSON.parse(out.stdout)
    assert.notEqual(parsed.continue, false, `${a.id} would terminate the session on a single denied tool call`)
  }
})

test('no decision means no interference', () => {
  for (const a of BUILTIN_ADAPTERS) {
    const ev = a.parse({ cwd: '/tmp' }, a.events.preToolUse ?? 'PreToolUse')
    const out = a.emit(undefined, ev)
    assert.equal(out.code, 0, `${a.id} exits non-zero when no hook had an opinion`)
  }
})

test('parse normalizes the shell command out of every payload dialect', () => {
  const cases = [
    ['claude-code', { tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: '/x' }],
    ['openhands', { tool_name: 'terminal', tool_input: { command: 'ls' }, working_dir: '/x' }],
    ['crush', { tool_name: 'bash', tool_input: { command: 'ls' }, cwd: '/x' }],
    ['google-antigravity', { toolCall: { name: 'run_command', args: { CommandLine: 'ls', Cwd: '/x' } } }],
  ]
  for (const [id, raw] of cases) {
    const a = registry.get(id)
    const ev = a.parse(raw, a.events.preToolUse)
    assert.equal(ev.command, 'ls', `${id} did not surface the command`)
    assert.equal(ev.cwd, '/x', `${id} did not surface the cwd`)
  }
})

test('render produces a path for every write-mode adapter', () => {
  const hooks = [{ id: 't', event: 'preToolUse', handler: () => undefined, enabled: true }]
  for (const a of BUILTIN_ADAPTERS.filter((x) => x.install === 'write')) {
    if (!a.events.preToolUse) continue
    const r = a.render({ hooks, runner: 'hf', projectDir: '/tmp/p', scope: 'project' })
    const targets = [...r.files.map((f) => f.path), ...r.extras.map((e) => e.path)]
    assert.ok(targets.length > 0, `${a.id} rendered nothing`)
    for (const p of targets) assert.ok(p.startsWith('/'), `${a.id} produced a relative path: ${p}`)
  }
})

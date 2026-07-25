import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { redact, parse, write, tail, readSince, size, journalPath, toEntry } from '../dist/core/journal.js'
import { truncate, visibleLength, c } from '../dist/core/ui.js'

function tmp() {
  return mkdtempSync(join(tmpdir(), 'hf-journal-'))
}

// --- redaction -------------------------------------------------------------

test('the journal redacts credentials before they hit disk', () => {
  const cases = [
    ['aws s3 ls --key AKIAIOSFODNN7EXAMPLE', 'AKIAIOSFODNN7EXAMPLE'],
    ['curl -H "Authorization: ghp_abcdefghijklmnopqrstuvwxyz0123456789"', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'],
    ['export ANTHROPIC_API_KEY=sk-ant-abcdefghijklmnopqrstuvwx', 'sk-ant-abcdefghijklmnopqrstuvwx'],
    ['SLACK_TOKEN=xoxb-1234567890-abcdefghij', 'xoxb-1234567890-abcdefghij'],
  ]
  for (const [input, secret] of cases) {
    const out = redact(input)
    assert.ok(!out.includes(secret), `leaked into the journal: ${input}`)
  }
})

test('redaction leaves ordinary commands untouched', () => {
  assert.equal(redact('npm test -- --watch'), 'npm test -- --watch')
  assert.equal(redact('git commit -m "fix: off-by-one"'), 'git commit -m "fix: off-by-one"')
})

test('redaction caps length so one huge payload cannot bloat the journal', () => {
  const out = redact('x'.repeat(5000))
  assert.ok(out.length <= 401, `got ${out.length}`)
})

test('a private key block never survives', () => {
  const out = redact('-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----')
  assert.ok(!out.includes('MIIEow'))
})

// --- read/write ------------------------------------------------------------

const entry = (over = {}) => ({
  ts: new Date().toISOString(),
  agent: 'claude-code',
  event: 'preToolUse',
  native: 'PreToolUse',
  verdict: 'none',
  ms: 1,
  hooks: [],
  skipped: 0,
  ...over,
})

test('write then tail round-trips', () => {
  const dir = tmp()
  try {
    write(dir, entry({ tool: 'Bash', command: 'ls' }))
    write(dir, entry({ tool: 'Bash', command: 'pwd', verdict: 'deny', reason: 'no' }))
    const got = tail(dir)
    assert.equal(got.length, 2)
    assert.equal(got[1].verdict, 'deny')
    assert.equal(got[0].command, 'ls')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readSince returns only what is new', () => {
  const dir = tmp()
  try {
    write(dir, entry({ command: 'first' }))
    const offset = size(dir)
    write(dir, entry({ command: 'second' }))
    const { entries, offset: next } = readSince(dir, offset)
    assert.equal(entries.length, 1)
    assert.equal(entries[0].command, 'second')
    assert.ok(next > offset)
    assert.equal(readSince(dir, next).entries.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a shrinking file (rotation or wipe) re-reads instead of seeking past the end', () => {
  const dir = tmp()
  try {
    for (let i = 0; i < 5; i++) write(dir, entry({ command: `cmd${i}` }))
    const offset = size(dir)
    // Simulate a rotation: file is replaced by something much shorter.
    writeFileSync(journalPath(dir), JSON.stringify(entry({ command: 'fresh' })) + '\n')
    const { entries } = readSince(dir, offset)
    assert.equal(entries.length, 1)
    assert.equal(entries[0].command, 'fresh')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a torn final line does not throw away the good records', () => {
  const dir = tmp()
  try {
    write(dir, entry({ command: 'good' }))
    writeFileSync(journalPath(dir), readFileSync(journalPath(dir), 'utf8') + '{"agent":"tru', { flag: 'w' })
    const got = tail(dir)
    assert.equal(got.length, 1)
    assert.equal(got[0].command, 'good')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('reading a journal that was never created is empty, not an error', () => {
  const dir = tmp()
  try {
    assert.deepEqual(tail(dir), [])
    assert.equal(size(dir), 0)
    assert.deepEqual(readSince(dir, 0).entries, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('writing to an unwritable path fails silently rather than breaking the hook', () => {
  // A hook that dies because journalling failed would be worse than no journal.
  assert.doesNotThrow(() => write('/proc/nonexistent-hf-test', entry()))
})

test('parse skips a leading partial line when asked', () => {
  const good = JSON.stringify(entry({ command: 'kept' }))
  assert.equal(parse(`{"agent":"cut off\n${good}\n`, true).length, 1)
  assert.equal(parse(`${good}\n${good}\n`, false).length, 2)
})

// --- entry construction ----------------------------------------------------

test('an entry records which hooks ran and how many matchers filtered out', () => {
  const ev = {
    event: 'preToolUse',
    agent: 'claude-code',
    nativeEvent: 'PreToolUse',
    cwd: '/tmp',
    toolName: 'Bash',
    command: 'rm -rf /',
    raw: {},
  }
  const result = {
    event: ev,
    decision: { kind: 'deny', reason: 'nope' },
    ran: [{ id: 'a', decision: { kind: 'deny', reason: 'nope' }, ms: 2 }],
  }
  const e = toEntry(ev, result, 7, 4)
  assert.equal(e.verdict, 'deny')
  assert.equal(e.reason, 'nope')
  assert.equal(e.ms, 7)
  assert.equal(e.hooks.length, 1)
  assert.equal(e.hooks[0].hit, true)
  assert.equal(e.skipped, 3, 'four candidates, one ran, so three were filtered out')
})

test('a command containing a secret is redacted in the entry', () => {
  const ev = {
    event: 'preToolUse',
    agent: 'codex',
    nativeEvent: 'PreToolUse',
    cwd: '/tmp',
    command: 'export TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    raw: {},
  }
  const e = toEntry(ev, { event: ev, decision: undefined, ran: [] }, 1, 0)
  assert.ok(!e.command.includes('ghp_abcdefghijklmnopqrstuvwxyz0123456789'))
})

// --- ANSI-safe truncation --------------------------------------------------

test('truncate never cuts through an escape sequence', () => {
  const styled = c.green('hello') + ' ' + c.red('world')
  for (let n = 1; n <= visibleLength(styled) + 2; n++) {
    const out = truncate(styled, n)
    // A severed escape leaves a bare ESC with no terminating 'm'.
    for (let i = 0; i < out.length; i++) {
      if (out[i] === '\x1b') {
        assert.ok(out.indexOf('m', i) !== -1, `severed escape at width ${n}`)
      }
    }
    assert.ok(visibleLength(out) <= n, `overflowed at width ${n}`)
  }
})

test('truncate leaves a string that already fits completely alone', () => {
  const styled = c.green('short')
  assert.equal(truncate(styled, 50), styled)
})

test('truncate closes a style it cut inside of', () => {
  const out = truncate(c.green('abcdefghij'), 5)
  if (out.includes('\x1b[32m')) assert.ok(out.endsWith('\x1b[0m') || out.includes('\x1b[39m'))
})

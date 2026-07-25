/** Terminal styling for the CLI. */

const enabled = process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== 'dumb'

function wrap(open: number, close: number) {
  return (s: string) => (enabled ? `\x1b[${open}m${s}\x1b[${close}m` : s)
}

export const c = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  italic: wrap(3, 23),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  gray: wrap(90, 39),
}

export const sym = {
  ok: c.green('✓'),
  fail: c.red('✗'),
  warn: c.yellow('!'),
  dot: c.gray('·'),
  arrow: c.gray('→'),
  block: c.magenta('■'),
}

export function heading(s: string): string {
  return `\n${c.bold(s)}`
}

export function table(rows: string[][], opts: { head?: string[] } = {}): string {
  const all = opts.head ? [opts.head, ...rows] : rows
  if (all.length === 0) return ''
  const widths: number[] = []
  for (const row of all) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, visibleLength(cell))
    })
  }
  const lines = all.map((row, ri) => {
    const line = row.map((cell, i) => cell + ' '.repeat((widths[i] ?? 0) - visibleLength(cell))).join('  ').trimEnd()
    return opts.head && ri === 0 ? c.dim(line) : line
  })
  return lines.join('\n')
}

export function visibleLength(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, '').length
}

/**
 * Truncate to `n` visible columns without cutting through an escape sequence.
 * A naive slice can land mid-`\x1b[32m`, and the surviving fragment doesn't
 * just render as garbage — the terminal keeps consuming bytes looking for the
 * sequence terminator and swallows whatever came next.
 */
export function truncate(s: string, n: number, ellipsis = '…'): string {
  if (n <= 0) return ''
  if (visibleLength(s) <= n) return s
  const limit = Math.max(0, n - ellipsis.length)
  let out = ''
  let visible = 0
  let i = 0
  let open = false
  while (i < s.length && visible < limit) {
    if (s[i] === '\x1b') {
      const end = s.indexOf('m', i)
      if (end === -1) break
      const code = s.slice(i, end + 1)
      out += code
      open = code !== '\x1b[0m' && !/\x1b\[(?:22|23|39|49)m/.test(code)
      i = end + 1
      continue
    }
    out += s[i]
    visible++
    i++
  }
  // Close any style we truncated inside of, so it can't bleed into the next line.
  return out + ellipsis + (open ? '\x1b[0m' : '')
}

export function colorDiff(d: string): string {
  return d
    .split('\n')
    .map((l) => (l.startsWith('+') ? c.green(l) : l.startsWith('-') ? c.red(l) : c.gray(l)))
    .join('\n')
}

export function statusBadge(status: 'supported' | 'partial' | 'unsupported'): string {
  if (status === 'supported') return c.green('supported')
  if (status === 'partial') return c.yellow('partial')
  return c.red('no hooks')
}

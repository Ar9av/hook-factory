import type { Adapter, CanonicalEvent } from '../core/types.js'
import {
  auggie,
  claudeCode,
  codex,
  continueCli,
  devinCli,
  factoryDroid,
  geminiCli,
  googleAntigravity,
  openhands,
  qwenCode,
} from './family.js'
import { crush, cursor, githubCopilot, goose, kimiCode, openclaw, opencode } from './distinct.js'
import { amazonQ, amp, hermes, kiro, piAgent } from './snippet.js'
import { aider, trae, traeCn, warp } from './unsupported.js'

export * from './claude-style.js'
export * from './snippet.js'

/** Every agent hook-factory ships support for, keyed by the id you use in config. */
export const BUILTIN_ADAPTERS: Adapter[] = [
  claudeCode,
  codex,
  cursor,
  geminiCli,
  qwenCode,
  githubCopilot,
  factoryDroid,
  devinCli,
  openhands,
  auggie,
  goose,
  crush,
  kimiCode,
  opencode,
  openclaw,
  continueCli,
  googleAntigravity,
  hermes,
  piAgent,
  kiro,
  amazonQ,
  amp,
  aider,
  warp,
  trae,
  traeCn,
]

export {
  claudeCode,
  codex,
  cursor,
  geminiCli,
  qwenCode,
  githubCopilot,
  factoryDroid,
  devinCli,
  openhands,
  auggie,
  goose,
  crush,
  kimiCode,
  opencode,
  openclaw,
  continueCli,
  googleAntigravity,
  hermes,
  piAgent,
  kiro,
  amazonQ,
  amp,
  aider,
  warp,
  trae,
  traeCn,
}

export function buildRegistry(extra: Adapter[] = []): Map<string, Adapter> {
  const m = new Map<string, Adapter>()
  for (const a of [...BUILTIN_ADAPTERS, ...extra]) m.set(a.id, a)
  return m
}

/** Common misspellings and alternate names, so `hf add cursor-ide` still works. */
const ALIASES: Record<string, string> = {
  claude: 'claude-code',
  claudecode: 'claude-code',
  'codex-cli': 'codex',
  openai: 'codex',
  gemini: 'gemini-cli',
  qwen: 'qwen-code',
  copilot: 'github-copilot',
  'copilot-cli': 'github-copilot',
  droid: 'factory-droid',
  factory: 'factory-droid',
  devin: 'devin-cli',
  'open-hands': 'openhands',
  allhands: 'openhands',
  augment: 'auggie',
  kimi: 'kimi-code',
  'open-code': 'opencode',
  'open-claw': 'openclaw',
  cn: 'continue-cli',
  continue: 'continue-cli',
  antigravity: 'google-antigravity',
  pi: 'pi-agent',
  q: 'amazon-q-dev-cli',
  amazonq: 'amazon-q-dev-cli',
}

export function resolveAgentId(input: string): string {
  const k = input.trim().toLowerCase()
  return ALIASES[k] ?? k
}

export interface Capability {
  event: CanonicalEvent
  supported: boolean
  blocking: boolean
  native?: string
}

/** What a given agent can actually do, for `hf doctor` and the TUI matrix. */
export function capabilities(adapter: Adapter, events: readonly CanonicalEvent[]): Capability[] {
  return events.map((event) => ({
    event,
    supported: Boolean(adapter.events[event]),
    blocking: adapter.blocking.includes(event),
    native: adapter.events[event],
  }))
}

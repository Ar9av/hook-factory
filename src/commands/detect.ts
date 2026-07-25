import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { BUILTIN_ADAPTERS } from '../adapters/index.js'

/**
 * Which agents does this person actually use? We look for the config directories
 * and binaries each one leaves behind, so `hf init` can pre-check the right
 * boxes instead of making someone read a list of 26 names.
 */
const FINGERPRINTS: Record<string, { dirs?: string[]; bins?: string[] }> = {
  'claude-code': { dirs: ['~/.claude', '.claude'], bins: ['claude'] },
  codex: { dirs: ['~/.codex', '.codex'], bins: ['codex'] },
  cursor: { dirs: ['~/.cursor', '.cursor'], bins: ['cursor'] },
  'gemini-cli': { dirs: ['~/.gemini', '.gemini'], bins: ['gemini'] },
  'qwen-code': { dirs: ['~/.qwen', '.qwen'], bins: ['qwen'] },
  'github-copilot': { dirs: ['~/.copilot', '.github/hooks'], bins: ['copilot'] },
  'factory-droid': { dirs: ['~/.factory', '.factory'], bins: ['droid'] },
  'devin-cli': { dirs: ['~/.config/devin', '.devin'], bins: ['devin'] },
  openhands: { dirs: ['~/.openhands', '.openhands'], bins: ['openhands'] },
  auggie: { dirs: ['~/.augment', '.augment'], bins: ['auggie'] },
  goose: { dirs: ['~/.config/goose', '.agents/plugins'], bins: ['goose'] },
  crush: { dirs: ['~/.config/crush'], bins: ['crush'] },
  'kimi-code': { dirs: ['~/.kimi-code', '.kimi-code'], bins: ['kimi'] },
  opencode: { dirs: ['~/.config/opencode', '.opencode'], bins: ['opencode'] },
  openclaw: { dirs: ['~/.openclaw', '.openclaw'], bins: ['openclaw'] },
  'continue-cli': { dirs: ['~/.continue', '.continue'], bins: ['cn'] },
  'google-antigravity': { dirs: ['~/.gemini/antigravity-cli'], bins: [] },
  hermes: { dirs: ['~/.hermes'], bins: ['hermes'] },
  'pi-agent': { dirs: ['~/.pi', '.pi'], bins: ['pi'] },
  kiro: { dirs: ['~/.kiro', '.kiro'], bins: ['kiro'] },
  'amazon-q-dev-cli': { dirs: ['~/.aws/amazonq', '.amazonq'], bins: ['q'] },
  amp: { dirs: ['~/.config/amp', '.amp'], bins: ['amp'] },
  aider: { dirs: ['~/.aider'], bins: ['aider'] },
  warp: { dirs: ['~/.warp'], bins: [] },
  trae: { dirs: ['.trae'], bins: [] },
  'trae-cn': { dirs: [], bins: [] },
}

function expand(p: string, cwd: string): string {
  return p.startsWith('~/') ? join(homedir(), p.slice(2)) : join(cwd, p)
}

let pathCache: Set<string> | undefined
function onPath(bin: string): boolean {
  if (!pathCache) {
    pathCache = new Set()
    for (const dir of (process.env.PATH ?? '').split(':')) {
      if (!dir) continue
      try {
        // Cheaper than shelling out to `which` once per agent.
        for (const f of readdirSync(dir)) pathCache.add(f)
      } catch {
        // Unreadable PATH entries are normal; skip.
      }
    }
  }
  return pathCache.has(bin)
}

export interface Detection {
  id: string
  name: string
  found: boolean
  evidence: string[]
}

export function detectAgents(cwd = process.cwd()): Detection[] {
  return BUILTIN_ADAPTERS.map((a) => {
    const fp = FINGERPRINTS[a.id] ?? {}
    const evidence: string[] = []
    for (const d of fp.dirs ?? []) if (existsSync(expand(d, cwd))) evidence.push(d)
    for (const b of fp.bins ?? []) if (onPath(b)) evidence.push(`${b} on PATH`)
    return { id: a.id, name: a.name, found: evidence.length > 0, evidence }
  })
}

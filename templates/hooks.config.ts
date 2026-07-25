// Reference config — every option hook-factory understands.
// `npx hook-factory init` writes a smaller version of this.
import { defineHooks, onPreToolUse, onPostToolUse, onStop, match, deny, shell } from 'hook-factory'
import { secretGuard, dangerousCommands, protectPaths, testGate } from 'hook-factory/plugins'

export default defineHooks({
  agents: ['claude-code', 'codex', 'cursor', 'gemini-cli'],
  scope: 'project',

  hooks: [
    secretGuard(),
    dangerousCommands(),
    protectPaths({ paths: ['migrations/**', 'infra/**'] }),
    testGate({ command: 'npm test' }),

    onPreToolUse(match.shell(/\bsudo\b/), deny('No sudo from the agent.'), {
      description: 'Block sudo',
    }),

    onPostToolUse(match.edit('**/*.ts'), shell('npx prettier --write "{{filePath}}"'), {
      description: 'Format TypeScript after every edit',
    }),

    onStop(async (ev, ctx) => {
      const { code } = await ctx.exec('git diff --quiet')
      if (code !== 0) ctx.log('heads up: uncommitted changes')
    }),
  ],
})

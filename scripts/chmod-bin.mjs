import { chmod } from 'node:fs/promises'
import { existsSync } from 'node:fs'
const cli = new URL('../dist/cli.js', import.meta.url)
if (existsSync(cli)) await chmod(cli, 0o755)

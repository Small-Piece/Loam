// pnpm dev: start the UI dev server, build main + preload, launch Electron.
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { buildElectronEntries } from '../apps/desktop/scripts/build.mjs'

const desktopDir = fileURLToPath(new URL('../apps/desktop', import.meta.url))
const uiDir = fileURLToPath(new URL('../apps/ui', import.meta.url))

const server = await createServer({ root: uiDir })
await server.listen()
const devServerUrl = server.resolvedUrls?.local[0]
if (!devServerUrl) throw new Error('Vite dev server did not report a URL')

await buildElectronEntries('development')

// The electron package exports the path to its executable.
const electronPath = createRequire(`${desktopDir}/package.json`)('electron')
const electron = spawn(electronPath, [desktopDir], {
  stdio: 'inherit',
  env: { ...process.env, LOAM_DEV_SERVER_URL: devServerUrl },
})

async function shutdown(code) {
  await server.close()
  process.exit(code)
}

electron.on('exit', (code) => void shutdown(code ?? 0))
process.on('SIGINT', () => electron.kill())
process.on('SIGTERM', () => electron.kill())

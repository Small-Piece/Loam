// Builds main.cjs then preload.cjs as separate bundles, then copies the UI bundle.
import { cpSync, existsSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

const desktopDir = fileURLToPath(new URL('..', import.meta.url))
const uiDist = fileURLToPath(new URL('../../ui/dist', import.meta.url))
const rendererDir = fileURLToPath(new URL('../dist/renderer', import.meta.url))

/** Builds main and preload; mode is 'production' or 'development'. */
export async function buildElectronEntries(mode) {
  for (const entry of ['main', 'preload']) {
    process.env.LOAM_ENTRY = entry
    await build({ root: desktopDir, mode, logLevel: 'warn' })
  }
}

function copyRenderer() {
  if (!existsSync(uiDist)) {
    throw new Error('apps/ui/dist not found. Build the UI first.')
  }
  rmSync(rendererDir, { recursive: true, force: true })
  cpSync(uiDist, rendererDir, { recursive: true })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await buildElectronEntries('production')
  copyRenderer()
  console.log('desktop: built dist/main.cjs, dist/preload.cjs and dist/renderer')
}

import { builtinModules } from 'node:module'
import { defineConfig, type UserConfig } from 'vite'

// Bundles one Electron entry per build: LOAM_ENTRY=main or LOAM_ENTRY=preload.
// Each entry is a single self-contained CommonJS file, because the sandboxed
// preload cannot require sibling chunks. Workspace packages and zod are
// inlined; electron and the native better-sqlite3 addon load at runtime.
const entries = { main: 'src/main.ts', preload: 'src/preload.ts' } as const
type Entry = keyof typeof entries

function selectedEntry(): Entry {
  const entry = process.env['LOAM_ENTRY']
  if (entry === 'main' || entry === 'preload') return entry
  throw new Error('Set LOAM_ENTRY to "main" or "preload"')
}

const external = [
  'electron',
  'better-sqlite3',
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]

export default defineConfig((): UserConfig => {
  const entry = selectedEntry()
  return {
    build: {
      outDir: 'dist',
      // The main build runs first and clears dist; preload adds to it.
      emptyOutDir: entry === 'main',
      target: 'node24',
      minify: false,
      sourcemap: true,
      ssr: entries[entry],
      rollupOptions: {
        external,
        output: {
          format: 'cjs',
          entryFileNames: `${entry}.cjs`,
        },
      },
    },
    ssr: {
      noExternal: true,
      external: ['electron', 'better-sqlite3'],
    },
  }
})

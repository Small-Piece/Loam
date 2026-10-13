// pnpm notices: writes THIRD_PARTY_NOTICES.md from the production dependency tree.
// pnpm notices --check: fails when the file is out of date (CI and release).
// Both fail when a shipped dependency's license is not on the permissive list.
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { disallowed, licenseText, packagesFromPnpm, renderNotices } from './licenses.mjs'

const repo = fileURLToPath(new URL('..', import.meta.url))
const output = join(repo, 'THIRD_PARTY_NOTICES.md')
const check = process.argv.includes('--check')

function fail(message) {
  console.error(`notices: ${message}`)
  process.exit(1)
}

// Every workspace package's "dependencies": what the app bundles or loads at run time.
// Run as "pnpm notices", so pnpm itself is at npm_execpath.
const pnpmPath = process.env['npm_execpath']
if (!pnpmPath) fail('run this as pnpm notices.')
const listed = spawnSync(
  /\.(c?js|mjs)$/.test(pnpmPath) ? process.execPath : pnpmPath,
  [
    ...(/\.(c?js|mjs)$/.test(pnpmPath) ? [pnpmPath] : []),
    '-r',
    'licenses',
    'list',
    '--prod',
    '--json',
  ],
  { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
)
if (listed.status !== 0) fail(`pnpm licenses failed: ${listed.stderr || listed.stdout}`)
const packages = packagesFromPnpm(JSON.parse(listed.stdout))

// Electron is the runtime the installer ships; it is a devDependency only for building.
const electronDir = dirname(
  createRequire(join(repo, 'apps/desktop/package.json')).resolve('electron/package.json'),
)
const electron = JSON.parse(readFileSync(join(electronDir, 'package.json'), 'utf8'))
packages.push({
  name: 'electron',
  version: electron.version,
  license: electron.license,
  path: electronDir,
})
packages.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))

const refused = disallowed(packages)
if (refused.length > 0) {
  fail(
    'these dependencies do not have a permissive license, so they may not ship:\n' +
      refused.map((pkg) => `  ${pkg.name}@${pkg.version}: ${pkg.license}`).join('\n'),
  )
}

const { DEFAULT_MODEL } = await import(
  pathToFileURL(join(repo, 'packages/agent/src/catalog.ts')).href
)
const runtime = DEFAULT_MODEL.files.find((file) => file.kind === 'runtime')
const runtimeVersion = /\/download\/(b\d+)\//.exec(runtime?.url ?? '')?.[1] ?? 'unknown'
const downloads = [
  {
    name: 'llama.cpp llama-server (Windows, Vulkan build)',
    version: runtimeVersion,
    license: DEFAULT_MODEL.runtimeLicense,
    source: 'https://github.com/ggml-org/llama.cpp',
  },
  {
    name: DEFAULT_MODEL.name,
    version: 'GGUF, with its vision projector',
    license: DEFAULT_MODEL.license,
    source: 'https://huggingface.co/Qwen/Qwen3-VL-4B-Instruct-GGUF',
  },
]

const notices = renderNotices(
  packages.map((pkg) => ({ ...pkg, text: licenseText(pkg.path) })),
  downloads,
)
if (check) {
  const current = existsSync(output) ? readFileSync(output, 'utf8').replace(/\r\n/g, '\n') : ''
  if (current !== notices) fail('THIRD_PARTY_NOTICES.md is out of date; run pnpm notices.')
  console.log(`THIRD_PARTY_NOTICES.md is up to date (${packages.length} packages, all permissive).`)
} else {
  writeFileSync(output, notices)
  console.log(`Wrote THIRD_PARTY_NOTICES.md (${packages.length} packages, all permissive).`)
}

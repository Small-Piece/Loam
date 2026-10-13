// pnpm test:e2e:packaged: runs the E2E suite against the packaged app built by pnpm build.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const executable = fileURLToPath(
  new URL('../apps/desktop/release/win-unpacked/Loam.exe', import.meta.url),
)
if (!existsSync(executable)) {
  console.error(`Packaged app not found at ${executable}. Run pnpm build first.`)
  process.exit(1)
}

const result = spawnSync('pnpm', ['exec', 'playwright', 'test'], {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, LOAM_E2E_EXECUTABLE: executable },
})
process.exit(result.status ?? 1)

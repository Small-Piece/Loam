import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, type ElectronApplication } from '@playwright/test'

const desktopDir = fileURLToPath(new URL('../../apps/desktop', import.meta.url))

/** A LOAM_<name> variable of the test run; the old UM_<name> spelling still works. */
export function testSetting(name: string): string | undefined {
  return process.env[`LOAM_${name}`] ?? process.env[`UM_${name}`]
}

/**
 * When LOAM_E2E_EXECUTABLE (or the old UM_E2E_EXECUTABLE) points at a packaged Loam.exe, the tests
 * run against it; otherwise they run the unpackaged build in apps/desktop/dist.
 */
export const packagedExecutable = testSetting('E2E_EXECUTABLE') || undefined

export function assertBuilt(): void {
  if (packagedExecutable) {
    if (!existsSync(packagedExecutable))
      throw new Error(`Packaged app not found: ${packagedExecutable}`)
    return
  }
  if (!existsSync(join(desktopDir, 'dist', 'main.cjs'))) {
    throw new Error('apps/desktop/dist/main.cjs missing: run pnpm build:app before the E2E tests')
  }
}

export interface AppCommand {
  executablePath: string
  args: string[]
  env: Record<string, string>
}

/** Environment variables that have a value; unset ones are left out. */
function definedOnly(source: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) out[key] = value
  }
  return out
}

/** How to start the app with its own %LOCALAPPDATA%, so the real profile is never touched. */
export function appCommand(
  localAppData: string,
  extraEnv: Record<string, string> = {},
): AppCommand {
  const env: Record<string, string> = {
    // Keep test windows off the primary monitor, out of the keyboard focus and at the bottom of
    // that monitor; set LOAM_WINDOW_DISPLAY or LOAM_WINDOW_ANCHOR (or the old UM_ names) in the
    // outer environment to override.
    ...definedOnly(process.env),
    LOAM_WINDOW_DISPLAY: testSetting('WINDOW_DISPLAY') ?? 'secondary',
    LOAM_WINDOW_ANCHOR: testSetting('WINDOW_ANCHOR') ?? 'bottom',
    LOCALAPPDATA: localAppData,
    LOAM_DEV_SERVER_URL: '',
    ...extraEnv,
  }
  if (packagedExecutable) return { executablePath: packagedExecutable, args: [], env }
  const electronPath = createRequire(join(desktopDir, 'package.json'))('electron') as string
  return { executablePath: electronPath, args: [desktopDir], env }
}

export function launchApp(
  localAppData: string,
  extraEnv: Record<string, string> = {},
): Promise<ElectronApplication> {
  return electron.launch(appCommand(localAppData, extraEnv))
}

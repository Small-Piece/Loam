import { dirname, join } from 'node:path'
import { envSetting } from './env.ts'

/** The data folder's name under %LOCALAPPDATA%. */
export const DATA_FOLDER = 'Loam'
export const DATABASE_FILE = 'loam.db'
/** The data folder of the app before it was renamed to Loam; copied on first start. */
export const OLD_DATA_FOLDER = 'UnrealManager'

/** %LOCALAPPDATA%/Loam — all local data for the app lives here. */
export function dataDir(env: NodeJS.ProcessEnv = process.env): string {
  const localAppData = env['LOCALAPPDATA']
  if (!localAppData) {
    throw new Error('LOCALAPPDATA is not set; Loam currently supports Windows only')
  }
  return join(localAppData, DATA_FOLDER)
}

/** %LOCALAPPDATA%/UnrealManager: read once by the first start of Loam, never changed. */
export function oldDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(dirname(dataDir(env)), OLD_DATA_FOLDER)
}

export function databasePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(dataDir(env), DATABASE_FILE)
}

/** Root of the content-addressed file store for images and thumbnails. */
export function filesDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(dataDir(env), 'files')
}

/** Chromium profile data: local storage (remembered canvas views) and caches. */
export function browserDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(dataDir(env), 'browser')
}

/** Where the shipped starter kits live: next to the migrations in a packaged app. */
export function starterKitsDir(
  resourcesPath: string,
  isPackaged: boolean,
  appPath: string,
): string {
  return isPackaged
    ? join(resourcesPath, 'starter-kits')
    : join(appPath, '..', '..', 'starter-kits')
}

/** A file shipped next to the app's resources (notices, sample content), or at the repository root in dev. */
export function bundledFile(
  name: string,
  resourcesPath: string,
  isPackaged: boolean,
  appPath: string,
): string {
  return isPackaged ? join(resourcesPath, name) : join(appPath, '..', '..', name)
}

/**
 * The local AI model and its runtime (only after the user downloads them).
 * LOAM_MODELS_DIR (or the old UM_MODELS_DIR) points elsewhere, for tests that run
 * a model already on disk.
 */
export function modelsDir(env: NodeJS.ProcessEnv = process.env): string {
  return envSetting('MODELS_DIR', env) || join(dataDir(env), 'models')
}

/** The main process log (main.log and one rotated main.log.1). */
export function logsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(dataDir(env), 'logs')
}

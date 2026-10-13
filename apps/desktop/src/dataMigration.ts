import { createHash } from 'node:crypto'
import {
  appendFileSync,
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join, relative } from 'node:path'
import { checkDatabase, vacuumCopy, type DatabaseFacts } from '@loam/storage'
import { DATA_FOLDER, DATABASE_FILE, OLD_DATA_FOLDER } from './paths.ts'

const OLD_DATABASE_FILE = 'unrealmanager.db'
/** Written into the Loam folder after a verified copy; the About dialog reads it. */
export const MIGRATION_MARKER = 'migrated-from-unrealmanager.json'
/** Next to both data folders, so it survives the removal of a failed copy. */
export const MIGRATION_ERROR_LOG = 'Loam-migration-error.log'
/** The copy is built here and renamed to Loam only once it is verified. */
const STAGING_FOLDER = /^Loam\.migrating-(\d+)$/

export interface MigrationMarker {
  from: string
  to: string
  migratedAt: string
  schemaVersion: number
  references: number
  /** Row count of every table, as checked in the copy. */
  rows: Record<string, number>
  files: { count: number; bytes: number }
  backups: { count: number; bytes: number }
}

export type MigrationOutcome =
  | { status: 'migrated'; marker: MigrationMarker }
  | {
      status: 'skipped'
      reason: 'loam-exists' | 'nothing-to-migrate' | 'migrated-by-another-start'
    }

/** The copy failed or did not verify. Nothing was switched over; the old folder is untouched. */
export class DataMigrationError extends Error {
  readonly logPath: string

  constructor(message: string, logPath: string) {
    super(message)
    this.name = 'DataMigrationError'
    this.logPath = logPath
  }
}

export interface DataMigrationOptions {
  /** %LOCALAPPDATA%: the parent of both data folders. */
  localAppData: string
  now?: () => Date
  /** This process; names the staging folder. */
  pid?: number
  /** Whether the process that left a staging folder behind is still running. */
  isRunning?: (pid: number) => boolean
  /** Copies one file; tests swap it to simulate a bad copy. */
  copyFile?: (from: string, to: string) => void
  /** Called after each copied and checked file; tests use it to interrupt the copy. */
  afterCopy?: (relativePath: string) => void
}

interface Copied {
  count: number
  bytes: number
}

/**
 * On the first start of Loam, copies %LOCALAPPDATA%\UnrealManager to
 * %LOCALAPPDATA%\Loam: only when Loam does not exist yet and UnrealManager has
 * a database. It copies, never moves, and never opens the old folder's files
 * for writing: the database is read from a private byte copy and written with
 * VACUUM INTO, files/ and backups/ are copied file by file with size and
 * SHA-256 checks. Logs and the browser cache are not needed.
 *
 * Everything is built in a staging folder and verified (schema version, row
 * counts, every file hash, old folder unchanged) before one rename makes it
 * the Loam folder, so an interrupted copy never leaves a half-filled Loam
 * folder behind. On any failure the staging folder is removed, the reason is
 * written to MIGRATION_ERROR_LOG and a DataMigrationError is thrown.
 */
export function migrateDataFolder(options: DataMigrationOptions): MigrationOutcome {
  const { localAppData } = options
  const now = options.now ?? (() => new Date())
  const pid = options.pid ?? process.pid
  const copyFile = options.copyFile ?? copyFileSync
  const afterCopy = options.afterCopy ?? (() => undefined)
  const source = join(localAppData, OLD_DATA_FOLDER)
  const target = join(localAppData, DATA_FOLDER)

  if (existsSync(target)) return { status: 'skipped', reason: 'loam-exists' }
  if (!existsSync(join(source, OLD_DATABASE_FILE))) {
    return { status: 'skipped', reason: 'nothing-to-migrate' }
  }

  const lines: string[] = []
  const note = (line: string) => lines.push(`${now().toISOString()} [migration] ${line}`)
  removeAbandonedStaging(localAppData, pid, options.isRunning ?? isRunning, note)
  const staging = join(localAppData, `Loam.migrating-${pid}`)

  try {
    rmSync(staging, { recursive: true, force: true })
    mkdirSync(staging)
    note(`copying ${source} to ${target}`)
    const before = snapshot(source)
    const copy = (from: string, to: string) => {
      copyChecked(from, to, copyFile)
      afterCopy(relative(source, from))
    }

    const database = copyDatabase(source, staging, copy)
    note(
      `database copied and checked: schema version ${database.schemaVersion}, ${database.rows['refs'] ?? 0} references`,
    )
    const files = copyTree(join(source, 'files'), join(staging, 'files'), (name) => name, copy)
    note(`files/ copied and checked: ${files.count} files, ${files.bytes} bytes`)
    const backups = copyTree(
      join(source, 'backups'),
      join(staging, 'backups'),
      (name) => name.replace(/^unrealmanager-/, 'loam-'),
      copy,
    )
    note(`backups/ copied and checked: ${backups.count} files`)
    if (snapshot(source) !== before) {
      throw new Error(
        'the UnrealManager folder changed while it was being copied. Close UnrealManager if it is running, then start Loam again.',
      )
    }

    const marker: MigrationMarker = {
      from: source,
      to: target,
      migratedAt: now().toISOString(),
      schemaVersion: database.schemaVersion,
      references: database.rows['refs'] ?? 0,
      rows: database.rows,
      files,
      backups,
    }
    writeFileSync(join(staging, MIGRATION_MARKER), `${JSON.stringify(marker, null, 2)}\n`)
    note('verified; switching to the new folder. The old folder is left as it was.')
    mkdirSync(join(staging, 'logs'))
    writeFileSync(join(staging, 'logs', 'migration.log'), `${lines.join('\n')}\n`)

    try {
      renameSync(staging, target)
    } catch (error) {
      // Two first starts at once: the other one finished first and its copy is verified too.
      if (existsSync(target)) {
        rmSync(staging, { recursive: true, force: true })
        return { status: 'skipped', reason: 'migrated-by-another-start' }
      }
      throw error
    }
    return { status: 'migrated', marker }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    note(`failed: ${reason}`)
    try {
      rmSync(staging, { recursive: true, force: true })
      note('removed the unfinished copy; nothing was switched over')
    } catch (cleanup) {
      note(`could not remove ${staging}: ${String(cleanup)}`)
    }
    const logPath = join(localAppData, MIGRATION_ERROR_LOG)
    try {
      appendFileSync(logPath, `${lines.join('\n')}\n`)
    } catch {
      // The dialog still shows the reason.
    }
    throw new DataMigrationError(`Loam could not copy your data from ${source}: ${reason}`, logPath)
  }
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Removes staging folders left by a start that was killed during the copy. */
function removeAbandonedStaging(
  localAppData: string,
  pid: number,
  running: (pid: number) => boolean,
  note: (line: string) => void,
): void {
  for (const name of readdirSync(localAppData)) {
    const match = STAGING_FOLDER.exec(name)
    if (!match) continue
    const owner = Number(match[1])
    if (owner !== pid && running(owner)) continue
    rmSync(join(localAppData, name), { recursive: true, force: true })
    note(`removed ${name}, left behind by an interrupted copy`)
  }
}

/** Every file under a folder with its size and modification time: any change shows up. */
function snapshot(dir: string): string {
  const entries: string[] = []
  const walk = (current: string) => {
    for (const name of readdirSync(current)) {
      const path = join(current, name)
      const stat = lstatSync(path)
      if (stat.isDirectory()) walk(path)
      else entries.push(`${relative(dir, path)}|${stat.size}|${stat.mtimeMs}`)
    }
  }
  walk(dir)
  return entries.sort().join('\n')
}

function sha256File(path: string): string {
  const hash = createHash('sha256')
  const buffer = Buffer.alloc(1 << 20)
  const fd = openSync(path, 'r')
  try {
    let read = readSync(fd, buffer, 0, buffer.length, null)
    while (read > 0) {
      hash.update(buffer.subarray(0, read))
      read = readSync(fd, buffer, 0, buffer.length, null)
    }
  } finally {
    closeSync(fd)
  }
  return hash.digest('hex')
}

/** Copies one file and checks that the copy has the same size and SHA-256. */
function copyChecked(from: string, to: string, copyFile: (from: string, to: string) => void): void {
  copyFile(from, to)
  if (statSync(from).size !== statSync(to).size || sha256File(from) !== sha256File(to)) {
    throw new Error(`the copy of ${from} does not match the original (size or SHA-256)`)
  }
}

/** Copies every regular file under `from` into `to`, keeping the folder layout. */
function copyTree(
  from: string,
  to: string,
  rename: (name: string) => string,
  copy: (from: string, to: string) => void,
): Copied {
  const copied: Copied = { count: 0, bytes: 0 }
  if (!existsSync(from)) return copied
  const walk = (current: string, into: string) => {
    mkdirSync(into, { recursive: true })
    for (const name of readdirSync(current)) {
      const path = join(current, name)
      const stat = lstatSync(path)
      if (stat.isDirectory()) {
        walk(path, join(into, name))
      } else if (stat.isFile()) {
        copy(path, join(into, rename(name)))
        copied.count += 1
        copied.bytes += stat.size
      }
    }
  }
  walk(from, to)
  return copied
}

/**
 * Copies the database without opening the old file: its bytes (and any WAL
 * left by a crash) are copied to a private folder first, opened there, and
 * written to loam.db with VACUUM INTO. The result must pass integrity_check
 * and match the original's schema version and row counts.
 */
function copyDatabase(
  source: string,
  staging: string,
  copy: (from: string, to: string) => void,
): DatabaseFacts {
  const work = join(staging, '.source')
  mkdirSync(work)
  const original = join(source, OLD_DATABASE_FILE)
  const privateCopy = join(work, 'source.db')
  copy(original, privateCopy)
  if (existsSync(`${original}-wal`)) copy(`${original}-wal`, `${privateCopy}-wal`)

  const result = join(staging, DATABASE_FILE)
  const expected = vacuumCopy(privateCopy, result)
  rmSync(work, { recursive: true, force: true })
  const actual = checkDatabase(result)
  if (actual.schemaVersion !== expected.schemaVersion) {
    throw new Error(
      `the copied database has schema version ${actual.schemaVersion}, the original ${expected.schemaVersion}`,
    )
  }
  if (JSON.stringify(actual.rows) !== JSON.stringify(expected.rows)) {
    throw new Error('the copied database does not have the same rows as the original')
  }
  return expected
}

export interface MigrationNote {
  /** The old UnrealManager folder. */
  from: string
  migratedAt: string
  references: number
  /** Whether the old folder is still there (it is never removed by Loam). */
  oldFolderExists: boolean
}

/** What the About dialog says about the copy from UnrealManager; null when there was none. */
export function describeMigration(dataFolder: string, oldFolder: string): MigrationNote | null {
  let marker: Partial<MigrationMarker>
  try {
    marker = JSON.parse(
      readFileSync(join(dataFolder, MIGRATION_MARKER), 'utf8'),
    ) as Partial<MigrationMarker>
  } catch {
    return null
  }
  if (typeof marker.migratedAt !== 'string') return null
  return {
    from: oldFolder,
    migratedAt: marker.migratedAt,
    references: typeof marker.references === 'number' ? marker.references : 0,
    oldFolderExists: existsSync(oldFolder),
  }
}

import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { Database } from 'better-sqlite3'

/** How many database backups to keep; older ones are removed. */
export const BACKUPS_TO_KEEP = 5

/** loam-<schemaVersion>-<UTC timestamp>.db; the timestamp sorts by age. */
const BACKUP_FILE = /^loam-\d+-\d{8}T\d{9}Z\.db$/

function stamp(date: Date): string {
  // 2026-10-12T20:15:30.123Z -> 20261012T201530123Z
  return date.toISOString().replace(/[-:.]/g, '')
}

export function backupFileName(schemaVersion: number, at: Date): string {
  return `loam-${schemaVersion}-${stamp(at)}.db`
}

/** Backups in the folder, oldest first. Files that do not match the naming pattern are ignored. */
export function listBackups(dir: string): string[] {
  if (!existsSync(dir)) return []
  const timestampOf = (name: string) => name.slice(name.lastIndexOf('-') + 1)
  return readdirSync(dir)
    .filter((name) => BACKUP_FILE.test(name))
    .sort((a, b) => timestampOf(a).localeCompare(timestampOf(b)))
}

/**
 * Writes a consistent copy of the open database with VACUUM INTO (not a raw
 * file copy, which could catch a half-written page or miss the WAL).
 * Returns the backup's path.
 */
export function backupDatabase(db: Database, dir: string, schemaVersion: number, at: Date): string {
  mkdirSync(dir, { recursive: true })
  let when = at.getTime()
  let path = join(dir, backupFileName(schemaVersion, new Date(when)))
  // Two backups in the same millisecond must not collide (VACUUM INTO refuses existing files).
  while (existsSync(path)) {
    when += 1
    path = join(dir, backupFileName(schemaVersion, new Date(when)))
  }
  db.prepare('VACUUM INTO ?').run(path)
  return path
}

/** Deletes all but the newest `keep` backups; returns the names removed. */
export function pruneBackups(dir: string, keep = BACKUPS_TO_KEEP): string[] {
  const backups = listBackups(dir)
  const doomed = backups.slice(0, Math.max(0, backups.length - keep))
  for (const name of doomed) rmSync(join(dir, name), { force: true })
  return doomed
}

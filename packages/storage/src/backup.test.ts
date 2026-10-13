import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  backupDatabase,
  backupFileName,
  listBackups,
  openDatabase,
  pruneBackups,
  readSchemaVersion,
} from './index.ts'

const repoMigrations = fileURLToPath(new URL('../../../migrations', import.meta.url))

describe('database backup before migrating', () => {
  let dir: string
  let early: string
  let later: string
  let clock: number

  /** A migrations folder holding 0001 up to `last`. */
  function migrationsUpTo(last: number, name: string): string {
    const folder = join(dir, name)
    mkdirSync(folder)
    for (const file of readdirSync(repoMigrations)) {
      if (Number(file.slice(0, 4)) <= last)
        copyFileSync(join(repoMigrations, file), join(folder, file))
    }
    return folder
  }

  const now = () => new Date(Date.UTC(2026, 9, 12, 20, 0, 0) + clock++ * 1000)
  const backups = () => listBackups(join(dir, 'backups'))
  const open = (migrationsDir: string) =>
    openDatabase({ filePath: join(dir, 'loam.db'), migrationsDir, now })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'loam-backup-'))
    clock = 0
    early = migrationsUpTo(3, 'early')
    later = migrationsUpTo(4, 'later')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('makes no backup of a brand-new database', () => {
    const opened = open(later)
    expect(opened.previousVersion).toBe(0)
    expect(opened.backupPath).toBeNull()
    opened.db.close()
    expect(backups()).toEqual([])
  })

  it('backs up once before a pending migration, and not again when nothing is pending', () => {
    const first = open(early)
    expect(first.schemaVersion).toBe(3)
    first.db.close()

    const upgraded = open(later)
    expect(upgraded.previousVersion).toBe(3)
    expect(upgraded.schemaVersion).toBe(4)
    expect(upgraded.backupPath).not.toBeNull()
    upgraded.db.close()
    expect(backups()).toEqual([backupFileName(3, new Date(Date.UTC(2026, 9, 12, 20, 0, 0)))])

    const again = open(later)
    expect(again.previousVersion).toBe(4)
    expect(again.backupPath).toBeNull()
    again.db.close()
    expect(backups()).toHaveLength(1)
  })

  it('the backup is a complete database at the old schema, including rows still in the WAL', () => {
    const first = open(early)
    // Keep this connection open with checkpointing off, so the row below lives only in the WAL.
    first.db.pragma('wal_autocheckpoint = 0')
    first.db
      .prepare(
        `INSERT INTO refs (image_hash, image_mime, image_bytes, image_width, image_height,
           thumb_hash, thumb_width, thumb_height, title, created_at)
         VALUES (?, 'image/png', 1, 1, 1, ?, 1, 1, 'kept in WAL', '2026-10-12')`,
      )
      .run('a'.repeat(64), 'b'.repeat(64))
    expect(statSync(join(dir, 'loam.db-wal')).size).toBeGreaterThan(0)

    const upgraded = open(later)
    const backupPath = upgraded.backupPath
    upgraded.db.close()
    first.db.close()
    if (!backupPath) throw new Error('no backup')
    const copy = new Database(backupPath, { readonly: true })
    expect(readSchemaVersion(copy)).toBe(3)
    expect(copy.prepare('SELECT title FROM refs').all()).toEqual([{ title: 'kept in WAL' }])
    expect(copy.pragma('integrity_check', { simple: true })).toBe('ok')
    copy.close()
  })

  it('keeps only the five newest backups and leaves other files alone', () => {
    const folder = join(dir, 'backups')
    mkdirSync(folder)
    for (let day = 1; day <= 6; day++) {
      writeFileSync(join(folder, backupFileName(2, new Date(Date.UTC(2026, 8, day)))), 'old')
    }
    writeFileSync(join(folder, 'notes.txt'), 'mine')
    writeFileSync(join(folder, 'loam-2-not-a-stamp.db'), 'mine')

    open(early).db.close()
    const upgraded = open(later)
    upgraded.db.close()

    const kept = backups()
    expect(kept).toHaveLength(5)
    expect(kept.at(-1)).toBe(backupFileName(3, new Date(Date.UTC(2026, 9, 12, 20, 0, 0))))
    expect(kept[0]).toBe(backupFileName(2, new Date(Date.UTC(2026, 8, 3))))
    const all = readdirSync(folder)
    expect(all).toContain('notes.txt')
    expect(all).toContain('loam-2-not-a-stamp.db')
  })

  it('never overwrites a backup made in the same millisecond', () => {
    const db = new Database(join(dir, 'x.db'))
    const at = new Date(Date.UTC(2026, 9, 12))
    const a = backupDatabase(db, join(dir, 'b'), 1, at)
    const b = backupDatabase(db, join(dir, 'b'), 1, at)
    db.close()
    expect(a).not.toBe(b)
    expect(listBackups(join(dir, 'b'))).toHaveLength(2)
  })

  it('prune with fewer than five backups removes nothing', () => {
    const folder = join(dir, 'few')
    mkdirSync(folder)
    writeFileSync(join(folder, backupFileName(1, new Date())), 'x')
    expect(pruneBackups(folder)).toEqual([])
  })
})

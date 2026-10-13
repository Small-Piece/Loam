import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { loadMigrations, openDatabase } from './index.ts'

const repoMigrations = fileURLToPath(new URL('../../../migrations', import.meta.url))
// 0001_init through 0005_groups_notes.
const LATEST_VERSION = 10

describe('storage', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'loam-storage-'))
    dirs.push(dir)
    return dir
  }

  it('creates the database in WAL mode at the latest schema version', () => {
    const filePath = join(tempDir(), 'nested', 'loam.db')
    const { db, schemaVersion } = openDatabase({ filePath, migrationsDir: repoMigrations })
    expect(existsSync(filePath)).toBe(true)
    expect(schemaVersion).toBe(LATEST_VERSION)
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal')
    db.close()
  })

  it('keeps the latest schema version when reopened without reapplying migrations', () => {
    const filePath = join(tempDir(), 'loam.db')
    openDatabase({ filePath, migrationsDir: repoMigrations }).db.close()
    const reopened = openDatabase({ filePath, migrationsDir: repoMigrations })
    expect(reopened.schemaVersion).toBe(LATEST_VERSION)
    const row = reopened.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()
    expect(row).toEqual({ value: String(LATEST_VERSION) })
    reopened.db.close()
  })

  it('rejects a gap in migration numbering', () => {
    const dir = tempDir()
    writeFileSync(
      join(dir, '0001_init.sql'),
      'CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);',
    )
    writeFileSync(join(dir, '0003_skip.sql'), 'SELECT 1;')
    expect(() => loadMigrations(dir)).toThrow(/out of sequence/)
  })

  it('rolls back a failing migration and leaves the version unchanged', () => {
    const dir = tempDir()
    writeFileSync(
      join(dir, '0001_init.sql'),
      'CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);',
    )
    writeFileSync(
      join(dir, '0002_broken.sql'),
      'CREATE TABLE ok_table (id INTEGER); THIS IS NOT SQL;',
    )
    const filePath = join(dir, 'test.db')
    expect(() => openDatabase({ filePath, migrationsDir: dir })).toThrow()
    rmSync(join(dir, '0002_broken.sql'))
    const { db, schemaVersion } = openDatabase({ filePath, migrationsDir: dir })
    expect(schemaVersion).toBe(1)
    const leftover = db.prepare("SELECT name FROM sqlite_master WHERE name = 'ok_table'").get()
    expect(leftover).toBeUndefined()
    db.close()
  })
})

import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkDatabase, openDatabase } from '@loam/storage'
import {
  DataMigrationError,
  describeMigration,
  MIGRATION_ERROR_LOG,
  MIGRATION_MARKER,
  migrateDataFolder,
  type MigrationMarker,
} from './dataMigration.ts'

const repo = fileURLToPath(new URL('../../..', import.meta.url))
const migrationsDir = join(repo, 'migrations')
const NOW = () => new Date('2026-10-14T03:00:00.000Z')

let localAppData: string
let old: string
let loam: string

beforeEach(() => {
  localAppData = mkdtempSync(join(tmpdir(), 'loam-migrate-'))
  old = join(localAppData, 'UnrealManager')
  loam = join(localAppData, 'Loam')
})

afterEach(() => {
  rmSync(localAppData, { recursive: true, force: true })
})

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Every file under a folder: path, size, modification time and SHA-256. */
function fingerprint(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (current: string) => {
    for (const name of readdirSync(current)) {
      const path = join(current, name)
      const stat = lstatSync(path)
      if (stat.isDirectory()) walk(path)
      else out[relative(dir, path)] = `${stat.size}|${stat.mtimeMs}|${sha256(readFileSync(path))}`
    }
  }
  walk(dir)
  return out
}

type Db = ReturnType<typeof openDatabase>['db']

function insertRef(db: Db, hash: string, title: string): void {
  db.prepare(
    `INSERT INTO refs (image_hash, image_mime, image_bytes, image_width, image_height,
       thumb_hash, thumb_width, thumb_height, title, created_at)
     VALUES (?, 'image/png', 4, 1, 1, ?, 1, 1, ?, '2026-10-12')`,
  ).run(hash, hash, title)
}

/**
 * An UnrealManager data folder like a real one: a database at the current
 * schema with references and a board, the file store, two backups, a log
 * and a browser cache. Returns the hashes of the stored files.
 */
function makeOldFolder(references = 3): string[] {
  const { db } = openDatabase({ filePath: join(old, 'unrealmanager.db'), migrationsDir })
  const hashes: string[] = []
  for (let index = 0; index < references; index++) {
    const bytes = Buffer.from(`image bytes ${index} `.repeat(200 + index))
    const hash = sha256(bytes)
    hashes.push(hash)
    mkdirSync(join(old, 'files', hash.slice(0, 2)), { recursive: true })
    writeFileSync(join(old, 'files', hash.slice(0, 2), hash), bytes)
    insertRef(db, hash, `Reference ${index}`)
  }
  db.prepare("INSERT INTO boards (name, created_at) VALUES ('Moodboard', '2026-10-12')").run()
  mkdirSync(join(old, 'backups'))
  db.prepare('VACUUM INTO ?').run(join(old, 'backups', 'unrealmanager-9-20261013T054031317Z.db'))
  db.close()
  writeFileSync(join(old, 'backups', 'unrealmanager-8-20261013T033418841Z.db'), 'older backup')
  mkdirSync(join(old, 'logs'))
  writeFileSync(join(old, 'logs', 'main.log'), '2026-10-13 info [startup] launching\n')
  mkdirSync(join(old, 'browser', 'Cache'), { recursive: true })
  writeFileSync(join(old, 'browser', 'Cache', 'data_0'), 'cache')
  return hashes
}

function migrate(options: Partial<Parameters<typeof migrateDataFolder>[0]> = {}) {
  return migrateDataFolder({
    localAppData,
    now: NOW,
    pid: 4242,
    isRunning: () => false,
    ...options,
  })
}

function stagingFolders(): string[] {
  return readdirSync(localAppData).filter((name) => name.startsWith('Loam.migrating-'))
}

function expectNothingSwitched(before: Record<string, string>): void {
  expect(existsSync(loam)).toBe(false)
  expect(stagingFolders()).toEqual([])
  expect(fingerprint(old)).toEqual(before)
}

function refCount(path: string): number | undefined {
  return checkDatabase(path).rows['refs']
}

describe('migrateDataFolder', () => {
  it('copies the database, files and backups, verifies them and leaves the old folder byte-identical', () => {
    const hashes = makeOldFolder(5)
    const before = fingerprint(old)

    const outcome = migrate()

    expect(outcome.status).toBe('migrated')
    expect(fingerprint(old)).toEqual(before)
    expect(stagingFolders()).toEqual([])
    expect(refCount(join(loam, 'loam.db'))).toBe(5)
    for (const hash of hashes) {
      const copy = readFileSync(join(loam, 'files', hash.slice(0, 2), hash))
      expect(sha256(copy)).toBe(hash)
    }
    expect(readdirSync(join(loam, 'backups')).sort()).toEqual([
      'loam-8-20261013T033418841Z.db',
      'loam-9-20261013T054031317Z.db',
    ])
    expect(readFileSync(join(loam, 'backups', 'loam-8-20261013T033418841Z.db'), 'utf8')).toBe(
      'older backup',
    )
    // Logs and the browser cache are not carried over (only this copy's own log).
    expect(readdirSync(join(loam, 'logs'))).toEqual(['migration.log'])
    expect(existsSync(join(loam, 'browser'))).toBe(false)
    expect(existsSync(join(loam, '.source'))).toBe(false)

    const marker = JSON.parse(readFileSync(join(loam, MIGRATION_MARKER), 'utf8')) as MigrationMarker
    expect(marker).toMatchObject({
      from: old,
      to: loam,
      migratedAt: '2026-10-14T03:00:00.000Z',
      schemaVersion: 12,
      references: 5,
      files: { count: 5 },
      backups: { count: 2 },
    })
    expect(marker.rows['boards']).toBe(1)
    if (outcome.status === 'migrated') expect(outcome.marker).toEqual(marker)
  })

  it('keeps rows that were still only in the WAL of the old database', () => {
    makeOldFolder(2)
    // A crashed app leaves its last writes in unrealmanager.db-wal.
    const live = openDatabase({ filePath: join(old, 'unrealmanager.db'), migrationsDir }).db
    try {
      live.pragma('wal_autocheckpoint = 0')
      insertRef(live, 'c'.repeat(64), 'only in the WAL')
      const before = fingerprint(old)
      expect(before['unrealmanager.db-wal']).toBeDefined()

      expect(migrate().status).toBe('migrated')

      expect(refCount(join(loam, 'loam.db'))).toBe(3)
      expect(fingerprint(old)).toEqual(before)
    } finally {
      live.close()
    }
  })

  it('does nothing when the Loam folder already exists', () => {
    makeOldFolder()
    mkdirSync(loam)
    writeFileSync(join(loam, 'loam.db'), 'already here')
    const before = fingerprint(old)

    expect(migrate()).toEqual({ status: 'skipped', reason: 'loam-exists' })

    expect(readdirSync(loam)).toEqual(['loam.db'])
    expect(readFileSync(join(loam, 'loam.db'), 'utf8')).toBe('already here')
    expect(fingerprint(old)).toEqual(before)
    expect(stagingFolders()).toEqual([])
  })

  it('does nothing on a fresh machine without an UnrealManager database', () => {
    expect(migrate()).toEqual({ status: 'skipped', reason: 'nothing-to-migrate' })
    mkdirSync(join(old, 'browser'), { recursive: true })
    expect(migrate()).toEqual({ status: 'skipped', reason: 'nothing-to-migrate' })
    expect(existsSync(loam)).toBe(false)
  })

  it('an interrupted copy leaves no Loam folder, logs why, and the next start copies everything', () => {
    makeOldFolder(4)
    const before = fingerprint(old)
    let copied = 0

    expect(() =>
      migrate({
        afterCopy: (path) => {
          if (path.startsWith('files') && ++copied === 2) throw new Error('disk full')
        },
      }),
    ).toThrow(DataMigrationError)

    expectNothingSwitched(before)
    const log = readFileSync(join(localAppData, MIGRATION_ERROR_LOG), 'utf8')
    expect(log).toContain('failed: disk full')
    expect(log).toContain('nothing was switched over')

    expect(migrate().status).toBe('migrated')
    expect(refCount(join(loam, 'loam.db'))).toBe(4)
    expect(fingerprint(old)).toEqual(before)
  })

  it('cleans up a copy left behind by a start that was killed, unless that start is still running', () => {
    makeOldFolder()
    mkdirSync(join(localAppData, 'Loam.migrating-111', 'files'), { recursive: true })
    writeFileSync(join(localAppData, 'Loam.migrating-111', 'loam.db'), 'half written')
    mkdirSync(join(localAppData, 'Loam.migrating-222'))

    const outcome = migrate({ isRunning: (pid) => pid === 222 })

    expect(outcome.status).toBe('migrated')
    expect(stagingFolders()).toEqual(['Loam.migrating-222'])
    expect(readFileSync(join(loam, 'logs', 'migration.log'), 'utf8')).toContain(
      'removed Loam.migrating-111',
    )
  })

  it('stops on a file whose copy does not match, without switching over', () => {
    makeOldFolder(3)
    const before = fingerprint(old)
    let bad = false
    const corrupting = (from: string, to: string) => {
      copyFileSync(from, to)
      if (!bad && from.includes(`${join('files', '')}`)) {
        bad = true
        writeFileSync(to, Buffer.concat([readFileSync(to), Buffer.from('!')]))
      }
    }

    let error: unknown
    try {
      migrate({ copyFile: corrupting })
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(DataMigrationError)
    expect((error as DataMigrationError).message).toMatch(/does not match the original/)
    expect((error as DataMigrationError).logPath).toBe(join(localAppData, MIGRATION_ERROR_LOG))
    expectNothingSwitched(before)
  })

  it('stops on a database copy that does not match', () => {
    makeOldFolder(2)
    const before = fingerprint(old)
    const truncating = (from: string, to: string) => {
      copyFileSync(from, to)
      if (from.endsWith('unrealmanager.db')) writeFileSync(to, readFileSync(to).subarray(0, 100))
    }

    expect(() => migrate({ copyFile: truncating })).toThrow(/does not match the original/)
    expectNothingSwitched(before)
  })

  it('stops when the old folder changes during the copy (UnrealManager still running)', () => {
    makeOldFolder(2)
    let touched = false

    expect(() =>
      migrate({
        afterCopy: () => {
          if (touched) return
          touched = true
          writeFileSync(join(old, 'logs', 'main.log'), 'UnrealManager wrote this\n', { flag: 'a' })
        },
      }),
    ).toThrow(/changed while it was being copied/)

    expect(existsSync(loam)).toBe(false)
    expect(stagingFolders()).toEqual([])
  })

  it('tells the About dialog where the old folder is, only after a copy', () => {
    expect(describeMigration(loam, old)).toBeNull()
    makeOldFolder(2)
    migrate()

    expect(describeMigration(loam, old)).toEqual({
      from: old,
      migratedAt: '2026-10-14T03:00:00.000Z',
      references: 2,
      oldFolderExists: true,
    })
    expect(describeMigration(loam, join(localAppData, 'Elsewhere'))?.oldFolderExists).toBe(false)
    writeFileSync(join(loam, MIGRATION_MARKER), 'not json')
    expect(describeMigration(loam, old)).toBeNull()
  })

  it('a second start that finishes later keeps the first verified copy', () => {
    makeOldFolder(2)
    let done = false

    const outcome = migrate({
      afterCopy: (path) => {
        // Another first start finishes its copy while this one is still working.
        if (done || !path.startsWith('backups')) return
        done = true
        mkdirSync(loam)
        writeFileSync(join(loam, 'loam.db'), 'the other copy')
      },
    })

    expect(outcome).toEqual({ status: 'skipped', reason: 'migrated-by-another-start' })
    expect(readFileSync(join(loam, 'loam.db'), 'utf8')).toBe('the other copy')
    expect(stagingFolders()).toEqual([])
  })
})

import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import Database, { type Database as SqliteDatabase } from 'better-sqlite3'
import { backupDatabase, pruneBackups } from './backup.ts'
import { loadMigrations, readSchemaVersion, runMigrations } from './migrations.ts'

export interface OpenDatabaseOptions {
  /** Absolute path of the SQLite file; parent directories are created. */
  filePath: string
  /** Directory holding the numbered .sql migrations. */
  migrationsDir: string
  /** Where backups go before a migration; defaults to <database folder>/backups. */
  backupDir?: string
  /** Clock for backup file names; defaults to the system clock. */
  now?: () => Date
}

export interface OpenedDatabase {
  db: SqliteDatabase
  /** Schema version found on opening, before any migration ran; 0 for a new database. */
  previousVersion: number
  schemaVersion: number
  /** The backup written before migrating, or null when nothing was migrated. */
  backupPath: string | null
}

/**
 * Opens the database in WAL mode and brings its schema up to date. When a
 * migration is pending on an existing database, a backup is written first
 * and only the newest five backups are kept.
 */
export function openDatabase(options: OpenDatabaseOptions): OpenedDatabase {
  mkdirSync(dirname(options.filePath), { recursive: true })
  const db = new Database(options.filePath)
  try {
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
    const migrations = loadMigrations(options.migrationsDir)
    const current = readSchemaVersion(db)
    const pending = migrations.some((migration) => migration.version > current)
    let backupPath: string | null = null
    // A new, empty database (version 0) has nothing worth keeping.
    if (pending && current > 0) {
      const dir = options.backupDir ?? join(dirname(options.filePath), 'backups')
      backupPath = backupDatabase(db, dir, current, (options.now ?? (() => new Date()))())
      pruneBackups(dir)
    }
    const schemaVersion = runMigrations(db, migrations)
    return { db, previousVersion: current, schemaVersion, backupPath }
  } catch (error) {
    db.close()
    throw error
  }
}

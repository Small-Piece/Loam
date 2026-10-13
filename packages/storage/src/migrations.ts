import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Database } from 'better-sqlite3'

const MIGRATION_FILE = /^(\d{4})_[a-z0-9_]+\.sql$/

export interface Migration {
  version: number
  name: string
  sql: string
}

/** Reads numbered migrations (0001_name.sql, 0002_...) from a directory, in order. */
export function loadMigrations(dir: string): Migration[] {
  const migrations: Migration[] = []
  for (const name of readdirSync(dir)) {
    const match = MIGRATION_FILE.exec(name)
    if (!match?.[1]) continue
    migrations.push({ version: Number(match[1]), name, sql: readFileSync(join(dir, name), 'utf8') })
  }
  migrations.sort((a, b) => a.version - b.version)
  migrations.forEach((migration, index) => {
    if (migration.version !== index + 1) {
      throw new Error(
        `Migration ${migration.name} is out of sequence; expected version ${index + 1}`,
      )
    }
  })
  return migrations
}

/** Current schema version from the meta table; 0 when no migration has run yet. */
export function readSchemaVersion(db: Database): number {
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'")
    .get()
  if (!table) return 0
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
    { value: string } | undefined
  return row ? Number(row.value) : 0
}

/** Applies every migration newer than the current schema version, each in its own transaction. */
export function runMigrations(db: Database, migrations: readonly Migration[]): number {
  let current = readSchemaVersion(db)
  for (const migration of migrations) {
    if (migration.version <= current) continue
    const apply = db.transaction(() => {
      db.exec(migration.sql)
      db.prepare(
        "INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).run(String(migration.version))
    })
    apply()
    current = migration.version
  }
  return current
}

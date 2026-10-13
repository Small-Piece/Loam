import Database, { type Database as SqliteDatabase } from 'better-sqlite3'
import { readSchemaVersion } from './migrations.ts'

/** What a database holds, for comparing a copy with its original. */
export interface DatabaseFacts {
  schemaVersion: number
  /** Row count of every table, by table name. */
  rows: Record<string, number>
}

function quoted(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

function factsOf(db: SqliteDatabase): DatabaseFacts {
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .pluck()
    .all() as string[]
  const rows: Record<string, number> = {}
  for (const table of tables) {
    rows[table] = db
      .prepare(`SELECT COUNT(*) FROM ${quoted(table)}`)
      .pluck()
      .get() as number
  }
  return { schemaVersion: readSchemaVersion(db), rows }
}

/**
 * Opens a database file (applying any WAL next to it), reads its facts and
 * writes a consistent copy to `targetPath` with VACUUM INTO. The source is
 * opened for writing, so pass a private copy, never a file that must stay
 * byte-identical.
 */
export function vacuumCopy(sourcePath: string, targetPath: string): DatabaseFacts {
  const db = new Database(sourcePath, { fileMustExist: true })
  try {
    const facts = factsOf(db)
    db.prepare('VACUUM INTO ?').run(targetPath)
    return facts
  } finally {
    db.close()
  }
}

/** Checks a database file with integrity_check and returns its facts; throws if it is damaged. */
export function checkDatabase(path: string): DatabaseFacts {
  const db = new Database(path, { fileMustExist: true })
  try {
    const integrity = db.pragma('integrity_check', { simple: true })
    if (integrity !== 'ok') {
      throw new Error(`the database ${path} failed integrity_check: ${String(integrity)}`)
    }
    return factsOf(db)
  } finally {
    db.close()
  }
}

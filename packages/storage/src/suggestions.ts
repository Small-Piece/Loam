import type { Database } from 'better-sqlite3'
import type { SuggestionRepository, TagSuggestionRow } from '@loam/core'

export type SuggestionOutcome = 'suggested' | 'unsupported' | 'failed'

/**
 * Tag suggestions in SQLite, apart from real tags: they live in their own
 * tables, so search and tag filters (which read ref_tags) never see them.
 */
export class SqliteSuggestionStore implements SuggestionRepository {
  private readonly db: Database

  constructor(db: Database) {
    this.db = db
  }

  /** The newest reference (not in the Trash) the queue has not looked at. */
  next(): { refId: number; imageHash: string; imageMime: string } | null {
    const row = this.db
      .prepare(
        `SELECT r.id AS refId, r.image_hash AS imageHash, r.image_mime AS imageMime
         FROM refs r
         WHERE r.deleted_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM tag_suggestion_runs s WHERE s.ref_id = r.id)
         ORDER BY r.created_at DESC, r.id DESC
         LIMIT 1`,
      )
      .get() as { refId: number; imageHash: string; imageMime: string } | undefined
    return row ?? null
  }

  counts(): { done: number; total: number } {
    return this.db
      .prepare(
        `SELECT count(*) AS total,
                count(s.ref_id) AS done
         FROM refs r LEFT JOIN tag_suggestion_runs s ON s.ref_id = r.id
         WHERE r.deleted_at IS NULL`,
      )
      .get() as { done: number; total: number }
  }

  /** Tags the reference has, and the suggestions the user rejected for it. */
  skipTags(refId: number): string[] {
    const rows = this.db
      .prepare(
        `SELECT t.name AS tag FROM ref_tags rt JOIN tags t ON t.id = rt.tag_id WHERE rt.ref_id = ?
         UNION
         SELECT tag FROM tag_suggestions WHERE ref_id = ? AND rejected = 1`,
      )
      .all(refId, refId) as Array<{ tag: string }>
    return rows.map((row) => row.tag)
  }

  /** Records what the queue found; a tag the user rejected before stays rejected. */
  save(
    refId: number,
    suggestions: ReadonlyArray<{ tag: string; confidence: number }>,
    outcome: SuggestionOutcome,
    finishedAt: string,
  ): void {
    const insert = this.db.prepare(
      `INSERT INTO tag_suggestions (ref_id, tag, confidence) VALUES (?, ?, ?)
       ON CONFLICT (ref_id, tag) DO UPDATE SET confidence = excluded.confidence
       WHERE tag_suggestions.rejected = 0`,
    )
    const run = this.db.prepare(
      `INSERT INTO tag_suggestion_runs (ref_id, outcome, finished_at) VALUES (?, ?, ?)
       ON CONFLICT (ref_id) DO UPDATE SET outcome = excluded.outcome, finished_at = excluded.finished_at`,
    )
    this.db.transaction(() => {
      // The reference may have been purged meanwhile.
      const exists = this.db.prepare('SELECT 1 FROM refs WHERE id = ?').get(refId)
      if (!exists) return
      for (const item of suggestions) insert.run(refId, item.tag, item.confidence)
      run.run(refId, outcome, finishedAt)
    })()
  }

  /** Open suggestions for one reference: not rejected, not already a tag of it. */
  openSuggestions(refId: number): TagSuggestionRow[] {
    return this.db
      .prepare(
        `SELECT s.tag, s.confidence FROM tag_suggestions s
         WHERE s.ref_id = ? AND s.rejected = 0
           AND NOT EXISTS (
             SELECT 1 FROM ref_tags rt JOIN tags t ON t.id = rt.tag_id
             WHERE rt.ref_id = s.ref_id AND lower(t.name) = lower(s.tag))
         ORDER BY s.confidence DESC, s.tag`,
      )
      .all(refId) as TagSuggestionRow[]
  }

  reject(refId: number, tag: string): void {
    this.db
      .prepare('UPDATE tag_suggestions SET rejected = 1 WHERE ref_id = ? AND tag = ?')
      .run(refId, tag)
  }

  /** Removes suggestions that became real tags. */
  remove(refId: number, tags: readonly string[]): void {
    const remove = this.db.prepare('DELETE FROM tag_suggestions WHERE ref_id = ? AND tag = ?')
    this.db.transaction(() => {
      for (const tag of tags) remove.run(refId, tag)
    })()
  }
}

/** App-wide settings, as JSON values. */
export class SqliteSettings {
  private readonly db: Database

  constructor(db: Database) {
    this.db = db
  }

  get<T>(key: string, fallback: T): T {
    const row = this.db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as
      { value: string } | undefined
    if (!row) return fallback
    try {
      return JSON.parse(row.value) as T
    } catch {
      return fallback
    }
  }

  set(key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO app_settings (key, value) VALUES (?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, JSON.stringify(value))
  }
}

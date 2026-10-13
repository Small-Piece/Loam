import type { Database } from 'better-sqlite3'
import {
  titleKey,
  type BibleIndex,
  type IndexedEntry,
  type IndexRow,
  type SearchHit,
  type VaultRole,
  type VaultSummary,
} from '@loam/core'

/** Marks the matched words in a search snippet: \u0002word\u0003. */
export const SNIPPET_OPEN = '\u0002'
export const SNIPPET_CLOSE = '\u0003'

/** The Creative Bible index in SQLite: rebuildable from the vault files at any time. */
export class SqliteBibleIndex implements BibleIndex {
  private readonly db: Database

  constructor(db: Database) {
    this.db = db
  }

  inTransaction<T>(work: () => T): T {
    return this.db.transaction(work)()
  }

  upsertVault(path: string, title: string, openedAt: string, role: VaultRole): VaultSummary {
    const row = this.db
      .prepare(
        `INSERT INTO bible_vaults (path, title, last_opened_at, role) VALUES (?, ?, ?, ?)
         ON CONFLICT (path) DO UPDATE SET title = excluded.title,
           last_opened_at = excluded.last_opened_at, role = excluded.role
         RETURNING id`,
      )
      .get(path, title, openedAt, role) as { id: number }
    return { id: row.id, path, title }
  }

  getVault(id: number): VaultSummary | null {
    const row = this.db.prepare('SELECT id, path, title FROM bible_vaults WHERE id = ?').get(id) as
      VaultSummary | undefined
    return row ?? null
  }

  recentVaults(limit: number, role: VaultRole): VaultSummary[] {
    return this.db
      .prepare(
        `SELECT id, path, title FROM bible_vaults WHERE role = ?
         ORDER BY last_opened_at DESC, id DESC LIMIT ?`,
      )
      .all(role, limit) as VaultSummary[]
  }

  setLastEntry(vaultId: number, path: string | null): void {
    this.db.prepare('UPDATE bible_vaults SET last_entry = ? WHERE id = ?').run(path, vaultId)
  }

  lastEntry(vaultId: number): string | null {
    const row = this.db.prepare('SELECT last_entry FROM bible_vaults WHERE id = ?').get(vaultId) as
      { last_entry: string | null } | undefined
    return row?.last_entry ?? null
  }

  forgetVault(vaultId: number): void {
    this.inTransaction(() => {
      this.clear(vaultId)
      this.db.prepare('DELETE FROM bible_vaults WHERE id = ?').run(vaultId)
    })
  }

  indexedFiles(vaultId: number): Map<string, { mtimeMs: number; size: number }> {
    const rows = this.db
      .prepare('SELECT path, mtime_ms AS mtimeMs, size FROM bible_entries WHERE vault_id = ?')
      .all(vaultId) as Array<{ path: string; mtimeMs: number; size: number }>
    return new Map(rows.map((row) => [row.path, { mtimeMs: row.mtimeMs, size: row.size }]))
  }

  putEntry(vaultId: number, entry: IndexedEntry): void {
    const { rowid } = this.db
      .prepare(
        `INSERT INTO bible_entries
           (vault_id, path, entry_id, section, title, title_key, sort_order, updated, mtime_ms, size, tags, created)
         VALUES (@vaultId, @path, @entryId, @section, @title, @titleKey, @order, @updated, @mtimeMs, @size, @tagsJson, @created)
         ON CONFLICT (vault_id, path) DO UPDATE SET
           entry_id = excluded.entry_id, section = excluded.section, title = excluded.title,
           title_key = excluded.title_key, sort_order = excluded.sort_order, updated = excluded.updated,
           mtime_ms = excluded.mtime_ms, size = excluded.size, tags = excluded.tags, created = excluded.created
         RETURNING rowid`,
      )
      .get({
        vaultId,
        path: entry.path,
        entryId: entry.entryId,
        section: entry.section,
        title: entry.title,
        titleKey: entry.titleKey,
        order: entry.order,
        updated: entry.updated,
        mtimeMs: entry.mtimeMs,
        size: entry.size,
        created: entry.created,
        tagsJson: JSON.stringify(entry.tags),
      }) as { rowid: number }
    // The search row shares the entry row's rowid.
    this.db.prepare('DELETE FROM bible_fts WHERE rowid = ?').run(rowid)
    this.db
      .prepare('INSERT INTO bible_fts (rowid, vault_id, path, title, body) VALUES (?, ?, ?, ?, ?)')
      .run(rowid, vaultId, entry.path, entry.title, entry.body)
    this.db
      .prepare('DELETE FROM bible_links WHERE vault_id = ? AND source_path = ?')
      .run(vaultId, entry.path)
    const link = this.db.prepare(
      'INSERT INTO bible_links (vault_id, source_path, target_key) VALUES (?, ?, ?)',
    )
    for (const target of entry.links) link.run(vaultId, entry.path, target)
    this.db
      .prepare('DELETE FROM bible_refs WHERE vault_id = ? AND source_path = ?')
      .run(vaultId, entry.path)
    const ref = this.db.prepare(
      'INSERT INTO bible_refs (vault_id, source_path, field_key, target, target_key) VALUES (?, ?, ?, ?, ?)',
    )
    for (const item of entry.refs)
      ref.run(vaultId, entry.path, item.key, item.target, titleKey(item.target))
    this.db
      .prepare('DELETE FROM bible_assets WHERE vault_id = ? AND source_path = ?')
      .run(vaultId, entry.path)
    const asset = this.db.prepare(
      'INSERT INTO bible_assets (vault_id, source_path, asset_hash) VALUES (?, ?, ?)',
    )
    for (const hash of entry.assets) asset.run(vaultId, entry.path, hash)
  }

  removeEntry(vaultId: number, path: string): void {
    this.db
      .prepare(
        'DELETE FROM bible_fts WHERE rowid IN (SELECT rowid FROM bible_entries WHERE vault_id = ? AND path = ?)',
      )
      .run(vaultId, path)
    // Links go with the entry (ON DELETE CASCADE).
    this.db.prepare('DELETE FROM bible_entries WHERE vault_id = ? AND path = ?').run(vaultId, path)
  }

  clear(vaultId: number): void {
    this.db
      .prepare(
        'DELETE FROM bible_fts WHERE rowid IN (SELECT rowid FROM bible_entries WHERE vault_id = ?)',
      )
      .run(vaultId)
    this.db.prepare('DELETE FROM bible_entries WHERE vault_id = ?').run(vaultId)
  }

  listEntries(vaultId: number): IndexRow[] {
    return this.db
      .prepare(
        `SELECT path, entry_id AS entryId, section, title, title_key AS titleKey, sort_order AS "order",
                updated, created
         FROM bible_entries WHERE vault_id = ?
         ORDER BY section, sort_order, title_key, path`,
      )
      .all(vaultId) as IndexRow[]
  }

  getEntry(
    vaultId: number,
    path: string,
  ): { path: string; entryId: string; section: string; title: string; titleKey: string } | null {
    const row = this.db
      .prepare(
        `SELECT path, entry_id AS entryId, section, title, title_key AS titleKey
         FROM bible_entries WHERE vault_id = ? AND path = ?`,
      )
      .get(vaultId, path) as
      | { path: string; entryId: string; section: string; title: string; titleKey: string }
      | undefined
    return row ?? null
  }

  linkingTo(vaultId: number, targetKey: string): Array<{ path: string; title: string }> {
    return this.db
      .prepare(
        `SELECT DISTINCT e.path, e.title FROM bible_links l
         JOIN bible_entries e ON e.vault_id = l.vault_id AND e.path = l.source_path
         WHERE l.vault_id = ? AND l.target_key = ?
         ORDER BY e.title_key, e.path`,
      )
      .all(vaultId, targetKey) as Array<{ path: string; title: string }>
  }

  search(vaultId: number, query: string, limit: number): SearchHit[] {
    return this.db
      .prepare(
        `SELECT e.path, e.title, e.section,
                snippet(bible_fts, 3, '${SNIPPET_OPEN}', '${SNIPPET_CLOSE}', '…', 16) AS snippet
         FROM bible_fts f JOIN bible_entries e ON e.rowid = f.rowid
         WHERE bible_fts MATCH @query AND e.vault_id = @vaultId
         ORDER BY bm25(bible_fts, 0, 0, 10, 1), e.title_key
         LIMIT @limit`,
      )
      .all({ query, vaultId, limit }) as SearchHit[]
  }

  vaultTags(vaultId: number): string[] {
    const rows = this.db
      .prepare(
        `SELECT value AS tag, COUNT(*) AS uses FROM bible_entries, json_each(bible_entries.tags)
         WHERE vault_id = ? GROUP BY value ORDER BY uses DESC, value`,
      )
      .all(vaultId) as Array<{ tag: string }>
    return rows.map((row) => row.tag)
  }

  allRefs(
    vaultId: number,
  ): Array<{ source: string; key: string; target: string; targetKey: string }> {
    return this.db
      .prepare(
        `SELECT source_path AS source, field_key AS key, target, target_key AS targetKey
         FROM bible_refs WHERE vault_id = ?`,
      )
      .all(vaultId) as Array<{ source: string; key: string; target: string; targetKey: string }>
  }

  allLinks(vaultId: number): Array<{ source: string; targetKey: string }> {
    return this.db
      .prepare(
        'SELECT source_path AS source, target_key AS targetKey FROM bible_links WHERE vault_id = ?',
      )
      .all(vaultId) as Array<{ source: string; targetKey: string }>
  }

  entriesUsingAssets(hashes: readonly string[]): Array<{
    vaultId: number
    vaultTitle: string
    vaultPath: string
    path: string
    title: string
  }> {
    if (hashes.length === 0) return []
    return this.db
      .prepare(
        `SELECT DISTINCT v.id AS vaultId, v.title AS vaultTitle, v.path AS vaultPath, e.path, e.title
         FROM bible_assets a
         JOIN bible_entries e ON e.vault_id = a.vault_id AND e.path = a.source_path
         JOIN bible_vaults v ON v.id = a.vault_id
         WHERE a.asset_hash IN (${hashes.map(() => '?').join(', ')})
         ORDER BY v.title, e.title_key`,
      )
      .all(...hashes) as Array<{
      vaultId: number
      vaultTitle: string
      vaultPath: string
      path: string
      title: string
    }>
  }

  kitSeen(vaultId: number): string | null {
    const row = this.db.prepare('SELECT kit_seen FROM bible_vaults WHERE id = ?').get(vaultId) as
      { kit_seen: string | null } | undefined
    return row?.kit_seen ?? null
  }

  setKitSeen(vaultId: number, fingerprint: string): void {
    this.db.prepare('UPDATE bible_vaults SET kit_seen = ? WHERE id = ?').run(fingerprint, vaultId)
  }

  linkSections(vaultId: number): Record<string, string> {
    const rows = this.db
      .prepare(
        'SELECT source_section AS source, target_section AS target FROM bible_link_sections WHERE vault_id = ?',
      )
      .all(vaultId) as Array<{ source: string; target: string }>
    const out: Record<string, string> = {}
    for (const row of rows) out[row.source] = row.target
    return out
  }

  setLinkSection(vaultId: number, sourceSection: string, targetSection: string): void {
    this.db
      .prepare(
        `INSERT INTO bible_link_sections (vault_id, source_section, target_section) VALUES (?, ?, ?)
         ON CONFLICT (vault_id, source_section) DO UPDATE SET target_section = excluded.target_section`,
      )
      .run(vaultId, sourceSection, targetSection)
  }
}

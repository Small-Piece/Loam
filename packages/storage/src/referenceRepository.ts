import type { Database } from 'better-sqlite3'
import {
  toFtsQuery,
  type BoardQuery,
  type BoardSummary,
  type BoardGroup,
  type BoardNote,
  type BoardView,
  type BoardViewMode,
  type CanvasItem,
  type ImageHashMatch,
  type ImageSize,
  type ItemState,
  type NewItem,
  type NoteSize,
  type PaletteColor,
  type NewReference,
  type PurgeResult,
  type ReferenceCard,
  type ReferenceDetail,
  type ReferencePatch,
  type ReferenceRepository,
  type TagCount,
} from '@loam/core'

interface CardRow {
  id: number
  title: string
  thumb_hash: string
  thumb_width: number
  thumb_height: number
  image_hash: string
  image_width: number
  image_height: number
  tags: string
}

interface DetailRow {
  id: number
  title: string
  note: string
  source: string
  created_at: string
  image_hash: string
  image_mime: string
  image_bytes: number
  image_width: number
  image_height: number
  deleted_at: string | null
  tags: string
  board_ids: string
}

const TAGS_OF_REF = `(SELECT json_group_array(t.name) FROM (
    SELECT t.name FROM ref_tags rt JOIN tags t ON t.id = rt.tag_id
    WHERE rt.ref_id = r.id ORDER BY t.name) AS t)`

/** Placeholders and named parameters for an id list: "@id0, @id1" and { id0, id1 }. */
function idParams(ids: readonly number[]): { list: string; params: Record<string, number> } {
  const params: Record<string, number> = {}
  const names = ids.map((id, index) => {
    params[`id${index}`] = id
    return `@id${index}`
  })
  return { list: names.join(', '), params }
}

/** Splits long id lists so each statement stays well under the SQLite parameter limit. */
function chunks<T>(values: readonly T[], size = 500): T[][] {
  const result: T[][] = []
  for (let start = 0; start < values.length; start += size) {
    result.push(values.slice(start, start + size))
  }
  return result
}

interface GroupRow {
  id: number
  title: string
  color: string
  locked: number
  z: number
}

interface NoteRow {
  id: number
  text: string
  x: number
  y: number
  width: number | null
  font_size: string
  color: string
  background: number
  z: number
  attached_item_id: number | null
  group_id: number | null
}

interface CanvasRow {
  id: number
  group_id: number | null
  reference_id: number
  x: number
  y: number
  scale: number
  z: number
  rotation: number
  flip_x: number
  flip_y: number
  title: string
  thumb_hash: string
  thumb_width: number
  thumb_height: number
  image_hash: string
  image_width: number
  image_height: number
}

/** A board's count is the number of references on it: an image placed twice counts once. */
const BOARD_SUMMARY = `SELECT b.id, b.name, b.view_mode AS viewMode,
    (SELECT COUNT(DISTINCT bi.reference_id) FROM board_items bi JOIN refs r ON r.id = bi.reference_id
     WHERE bi.board_id = b.id AND r.deleted_at IS NULL) AS count
  FROM boards b`

const ITEM_STATE = 'id, reference_id AS referenceId, x, y, scale, z, group_id AS groupId'

/**
 * SQLite implementation of the reference repository
 * (schema: migrations 0002_references, 0003_trash, 0004_board_items and 0012_board_item_ids).
 */
export class SqliteReferenceRepository implements ReferenceRepository {
  private readonly db: Database

  constructor(db: Database) {
    this.db = db
  }

  findByImageHash(hash: string): ImageHashMatch | null {
    const row = this.db
      .prepare('SELECT id, deleted_at IS NOT NULL AS in_trash FROM refs WHERE image_hash = ?')
      .get(hash) as { id: number; in_trash: number } | undefined
    return row ? { id: row.id, inTrash: row.in_trash === 1 } : null
  }

  insertOrGet(reference: NewReference): { id: number; created: boolean } {
    const result = this.db
      .prepare(
        `INSERT INTO refs (image_hash, image_mime, image_bytes, image_width, image_height,
           thumb_hash, thumb_width, thumb_height, title, created_at)
         VALUES (@imageHash, @imageMime, @imageBytes, @imageWidth, @imageHeight,
           @thumbHash, @thumbWidth, @thumbHeight, @title, @createdAt)
         ON CONFLICT (image_hash) DO NOTHING`,
      )
      .run(reference)
    if (result.changes === 1) return { id: Number(result.lastInsertRowid), created: true }
    const existing = this.findByImageHash(reference.imageHash)
    if (existing === null) throw new Error('Reference vanished during insert')
    return { id: existing.id, created: false }
  }

  inTransaction<T>(work: () => T): T {
    return this.db.transaction(work)()
  }

  removeFromBoard(boardId: number, refIds: readonly number[]): ItemState[] {
    const removed: ItemState[] = []
    this.db.transaction(() => {
      for (const part of chunks(refIds)) {
        const { list, params } = idParams(part)
        const itemIds = this.db
          .prepare(
            `SELECT id FROM board_items WHERE board_id = @boardId AND reference_id IN (${list})`,
          )
          .pluck()
          .all({ ...params, boardId }) as number[]
        removed.push(...this.removeItems(boardId, itemIds))
      }
    })()
    return removed
  }

  removeItems(boardId: number, itemIds: readonly number[]): ItemState[] {
    const removed: ItemState[] = []
    this.db.transaction(() => {
      for (const part of chunks(itemIds)) {
        const { list, params } = idParams(part)
        // Notes attached to these placements leave with them (also ON DELETE CASCADE).
        this.db
          .prepare(
            `DELETE FROM board_notes WHERE board_id = @boardId AND attached_item_id IN (${list})`,
          )
          .run({ ...params, boardId })
        const rows = this.db
          .prepare(
            `DELETE FROM board_items WHERE board_id = @boardId AND id IN (${list})
             RETURNING ${ITEM_STATE}`,
          )
          .all({ ...params, boardId }) as ItemState[]
        removed.push(...rows)
      }
    })()
    return removed
  }

  putItems(boardId: number, items: ReadonlyArray<NewItem | ItemState>): number[] {
    const insert = this.db.prepare(
      `INSERT INTO board_items (board_id, reference_id, x, y, scale, z, group_id)
       VALUES (@boardId, @referenceId, @x, @y, @scale, @z, @groupId)`,
    )
    // With an id: update that placement, or put it back under the same id (undo of a removal).
    const upsert = this.db.prepare(
      `INSERT INTO board_items (id, board_id, reference_id, x, y, scale, z, group_id)
       VALUES (@id, @boardId, @referenceId, @x, @y, @scale, @z, @groupId)
       ON CONFLICT (id)
       DO UPDATE SET x = excluded.x, y = excluded.y, scale = excluded.scale, z = excluded.z,
         group_id = excluded.group_id`,
    )
    const ids: number[] = []
    this.db.transaction(() => {
      for (const item of items) {
        const values = {
          boardId,
          referenceId: item.referenceId,
          x: item.x,
          y: item.y,
          scale: item.scale,
          z: item.z,
          groupId: item.groupId,
        }
        if (item.id === undefined) {
          ids.push(Number(insert.run(values).lastInsertRowid))
        } else {
          upsert.run({ ...values, id: item.id })
          ids.push(item.id)
        }
      }
    })()
    return ids
  }

  itemOwner(itemId: number): { boardId: number; referenceId: number } | null {
    const row = this.db
      .prepare(
        'SELECT board_id AS boardId, reference_id AS referenceId FROM board_items WHERE id = ?',
      )
      .get(itemId) as { boardId: number; referenceId: number } | undefined
    return row ?? null
  }

  listGroups(boardId: number): BoardGroup[] {
    const rows = this.db
      .prepare(
        'SELECT id, title, color, locked, z FROM board_groups WHERE board_id = ? ORDER BY z, id',
      )
      .all(boardId) as GroupRow[]
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      color: row.color as PaletteColor,
      locked: row.locked === 1,
      z: row.z,
    }))
  }

  listNotes(boardId: number, includeTrashed: boolean): BoardNote[] {
    // A note attached to an image in the Trash is hidden with it.
    const trash = includeTrashed ? '' : 'AND (n.attached_item_id IS NULL OR r.deleted_at IS NULL)'
    const rows = this.db
      .prepare(
        `SELECT n.id, n.text, n.x, n.y, n.width, n.font_size, n.color, n.background, n.z,
           n.attached_item_id, n.group_id
         FROM board_notes n
         LEFT JOIN board_items bi ON bi.id = n.attached_item_id
         LEFT JOIN refs r ON r.id = bi.reference_id
         WHERE n.board_id = ? ${trash}
         ORDER BY n.z, n.id`,
      )
      .all(boardId) as NoteRow[]
    return rows.map((row) => ({
      id: row.id,
      text: row.text,
      x: row.x,
      y: row.y,
      width: row.width,
      fontSize: row.font_size as NoteSize,
      color: row.color as PaletteColor,
      background: row.background === 1,
      z: row.z,
      attachedItemId: row.attached_item_id,
      groupId: row.group_id,
    }))
  }

  boardOfGroup(groupId: number): number | null {
    const row = this.db.prepare('SELECT board_id FROM board_groups WHERE id = ?').get(groupId) as
      { board_id: number } | undefined
    return row?.board_id ?? null
  }

  boardOfNote(noteId: number): number | null {
    const row = this.db.prepare('SELECT board_id FROM board_notes WHERE id = ?').get(noteId) as
      { board_id: number } | undefined
    return row?.board_id ?? null
  }

  putGroup(boardId: number, group: Omit<BoardGroup, 'id'> & { id?: number | undefined }): number {
    const values = {
      boardId,
      title: group.title,
      color: group.color,
      locked: group.locked ? 1 : 0,
      z: group.z,
    }
    if (group.id === undefined) {
      const result = this.db
        .prepare(
          `INSERT INTO board_groups (board_id, title, color, locked, z)
           VALUES (@boardId, @title, @color, @locked, @z)`,
        )
        .run(values)
      return Number(result.lastInsertRowid)
    }
    // With an id: update it, or put it back under the same id (undo of a delete).
    this.db
      .prepare(
        `INSERT INTO board_groups (id, board_id, title, color, locked, z)
         VALUES (@id, @boardId, @title, @color, @locked, @z)
         ON CONFLICT (id) DO UPDATE SET title = excluded.title, color = excluded.color,
           locked = excluded.locked, z = excluded.z`,
      )
      .run({ ...values, id: group.id })
    return group.id
  }

  deleteGroups(boardId: number, ids: readonly number[]): void {
    for (const part of chunks(ids)) {
      const { list, params } = idParams(part)
      // Children stay on the board; their group_id becomes NULL (ON DELETE SET NULL).
      this.db
        .prepare(`DELETE FROM board_groups WHERE board_id = @boardId AND id IN (${list})`)
        .run({ ...params, boardId })
    }
  }

  putNote(boardId: number, note: Omit<BoardNote, 'id'> & { id?: number | undefined }): number {
    const values = {
      boardId,
      text: note.text,
      x: note.x,
      y: note.y,
      width: note.width,
      fontSize: note.fontSize,
      color: note.color,
      background: note.background ? 1 : 0,
      z: note.z,
      attached: note.attachedItemId,
      groupId: note.groupId,
    }
    const columns = `board_id, text, x, y, width, font_size, color, background, z,
      attached_item_id, group_id`
    const placeholders = `@boardId, @text, @x, @y, @width, @fontSize, @color, @background, @z,
      @attached, @groupId`
    if (note.id === undefined) {
      const result = this.db
        .prepare(`INSERT INTO board_notes (${columns}) VALUES (${placeholders})`)
        .run(values)
      return Number(result.lastInsertRowid)
    }
    this.db
      .prepare(
        `INSERT INTO board_notes (id, ${columns}) VALUES (@id, ${placeholders})
         ON CONFLICT (id) DO UPDATE SET text = excluded.text, x = excluded.x, y = excluded.y,
           width = excluded.width, font_size = excluded.font_size, color = excluded.color,
           background = excluded.background, z = excluded.z,
           attached_item_id = excluded.attached_item_id, group_id = excluded.group_id`,
      )
      .run({ ...values, id: note.id })
    return note.id
  }

  deleteNotes(boardId: number, ids: readonly number[]): void {
    for (const part of chunks(ids)) {
      const { list, params } = idParams(part)
      this.db
        .prepare(`DELETE FROM board_notes WHERE board_id = @boardId AND id IN (${list})`)
        .run({ ...params, boardId })
    }
  }

  deleteEmptyGroups(boardId: number | null): number[] {
    const scope = boardId === null ? '' : 'AND g.board_id = @boardId'
    const rows = this.db
      .prepare(
        `DELETE FROM board_groups AS g WHERE id IN (
           SELECT g.id FROM board_groups g
           WHERE NOT EXISTS (SELECT 1 FROM board_items bi WHERE bi.group_id = g.id)
             AND NOT EXISTS (SELECT 1 FROM board_notes n WHERE n.group_id = g.id)
             ${scope}
         ) RETURNING id`,
      )
      .all(boardId === null ? {} : { boardId }) as Array<{ id: number }>
    return rows.map((row) => row.id)
  }

  listCanvas(boardId: number, includeTrashed: boolean): CanvasItem[] {
    const trash = includeTrashed ? '' : 'AND r.deleted_at IS NULL'
    const rows = this.db
      .prepare(
        `SELECT bi.id, bi.reference_id, bi.x, bi.y, bi.scale, bi.z, bi.rotation, bi.flip_x,
           bi.flip_y, bi.group_id,
           r.title, r.thumb_hash, r.thumb_width, r.thumb_height,
           r.image_hash, r.image_width, r.image_height
         FROM board_items bi JOIN refs r ON r.id = bi.reference_id
         WHERE bi.board_id = ? ${trash}
         ORDER BY bi.z, bi.id`,
      )
      .all(boardId) as CanvasRow[]
    return rows.map((row) => ({
      id: row.id,
      referenceId: row.reference_id,
      groupId: row.group_id,
      x: row.x,
      y: row.y,
      scale: row.scale,
      z: row.z,
      rotation: row.rotation,
      flipX: row.flip_x === 1,
      flipY: row.flip_y === 1,
      title: row.title,
      thumbHash: row.thumb_hash,
      thumbWidth: row.thumb_width,
      thumbHeight: row.thumb_height,
      imageHash: row.image_hash,
      imageWidth: row.image_width,
      imageHeight: row.image_height,
    }))
  }

  imageSizes(refIds: readonly number[]): ImageSize[] {
    const sizes: ImageSize[] = []
    for (const part of chunks(refIds)) {
      const { list, params } = idParams(part)
      sizes.push(
        ...(this.db
          .prepare(
            `SELECT id AS referenceId, image_width AS width, image_height AS height
             FROM refs WHERE id IN (${list})`,
          )
          .all(params) as ImageSize[]),
      )
    }
    return sizes
  }

  getBoard(boardId: number): BoardSummary | null {
    const row = this.db.prepare(`${BOARD_SUMMARY} WHERE b.id = ?`).get(boardId) as
      BoardSummary | undefined
    return row ?? null
  }

  setViewMode(boardId: number, mode: BoardViewMode): void {
    this.db.prepare('UPDATE boards SET view_mode = ? WHERE id = ?').run(mode, boardId)
  }

  moveToTrash(refIds: readonly number[], deletedAt: string): number[] {
    const moved: number[] = []
    this.db.transaction(() => {
      for (const part of chunks(refIds)) {
        const { list, params } = idParams(part)
        const rows = this.db
          .prepare(
            `UPDATE refs SET deleted_at = @deletedAt
             WHERE id IN (${list}) AND deleted_at IS NULL RETURNING id`,
          )
          .all({ ...params, deletedAt }) as Array<{ id: number }>
        moved.push(...rows.map((row) => row.id))
      }
    })()
    return moved
  }

  restoreFromTrash(refIds: readonly number[]): number[] {
    const restored: number[] = []
    this.db.transaction(() => {
      for (const part of chunks(refIds)) {
        const { list, params } = idParams(part)
        const rows = this.db
          .prepare(
            `UPDATE refs SET deleted_at = NULL
             WHERE id IN (${list}) AND deleted_at IS NOT NULL RETURNING id`,
          )
          .all(params) as Array<{ id: number }>
        restored.push(...rows.map((row) => row.id))
      }
    })()
    return restored
  }

  isHashUsed(hash: string): boolean {
    const row = this.db
      .prepare('SELECT 1 FROM refs WHERE image_hash = @hash OR thumb_hash = @hash LIMIT 1')
      .get({ hash })
    return row !== undefined
  }

  purgeTrash(): PurgeResult {
    return this.db.transaction((): PurgeResult => {
      const doomed = this.db
        .prepare('SELECT id, image_hash, thumb_hash FROM refs WHERE deleted_at IS NOT NULL')
        .all() as Array<{ id: number; image_hash: string; thumb_hash: string }>
      // Tag links, board links and FTS rows go with the reference (cascades and triggers).
      this.db.prepare('DELETE FROM refs WHERE deleted_at IS NOT NULL').run()
      this.db.prepare('DELETE FROM tags WHERE id NOT IN (SELECT tag_id FROM ref_tags)').run()
      // Placements and attached notes went with the references; drop groups left empty.
      this.deleteEmptyGroups(null)
      const candidates = new Set(doomed.flatMap((row) => [row.image_hash, row.thumb_hash]))
      const unusedHashes = [...candidates].filter((hash) => !this.isHashUsed(hash))
      return { purgedIds: doomed.map((row) => row.id), unusedHashes }
    })()
  }

  boardExists(boardId: number): boolean {
    return this.db.prepare('SELECT 1 FROM boards WHERE id = ?').get(boardId) !== undefined
  }

  getDetail(id: number): ReferenceDetail | null {
    const row = this.db
      .prepare(
        `SELECT r.id, r.title, r.note, r.source, r.created_at, r.image_hash, r.image_mime,
           r.image_bytes, r.image_width, r.image_height, r.deleted_at, ${TAGS_OF_REF} AS tags,
           (SELECT json_group_array(board_id) FROM (
              SELECT DISTINCT board_id FROM board_items WHERE reference_id = r.id ORDER BY board_id)) AS board_ids
         FROM refs r WHERE r.id = ?`,
      )
      .get(id) as DetailRow | undefined
    if (!row) return null
    return {
      id: row.id,
      title: row.title,
      note: row.note,
      source: row.source,
      createdAt: row.created_at,
      tags: JSON.parse(row.tags) as string[],
      boardIds: JSON.parse(row.board_ids) as number[],
      imageHash: row.image_hash,
      imageMime: row.image_mime,
      imageBytes: row.image_bytes,
      imageWidth: row.image_width,
      imageHeight: row.image_height,
      deletedAt: row.deleted_at,
    }
  }

  update(id: number, patch: ReferencePatch): boolean {
    const apply = this.db.transaction((): boolean => {
      const exists = this.db.prepare('SELECT 1 FROM refs WHERE id = ?').get(id) !== undefined
      if (!exists) return false
      const sets: string[] = []
      const values: Record<string, string | number> = { id }
      if (patch.title !== undefined) {
        sets.push('title = @title')
        values['title'] = patch.title
      }
      if (patch.note !== undefined) {
        sets.push('note = @note')
        values['note'] = patch.note
      }
      if (patch.source !== undefined) {
        sets.push('source = @source')
        values['source'] = patch.source
      }
      if (sets.length > 0) {
        this.db.prepare(`UPDATE refs SET ${sets.join(', ')} WHERE id = @id`).run(values)
      }
      if (patch.tags !== undefined) this.replaceTags(id, patch.tags)
      return true
    })
    return apply()
  }

  private replaceTags(refId: number, tags: readonly string[]): void {
    this.db.prepare('DELETE FROM ref_tags WHERE ref_id = ?').run(refId)
    const upsertTag = this.db.prepare(
      'INSERT INTO tags (name) VALUES (?) ON CONFLICT (name) DO UPDATE SET name = excluded.name RETURNING id',
    )
    const link = this.db.prepare('INSERT INTO ref_tags (ref_id, tag_id) VALUES (?, ?)')
    for (const tag of tags) {
      const { id: tagId } = upsertTag.get(tag) as { id: number }
      link.run(refId, tagId)
    }
    // Tags used by no reference disappear from the filter list.
    this.db.prepare('DELETE FROM tags WHERE id NOT IN (SELECT tag_id FROM ref_tags)').run()
  }

  listBoard(query: BoardQuery): BoardView {
    const params: Record<string, string | number> = {}
    // The Library and boards never show the Trash; the Trash view shows only it.
    const filters: string[] = [query.inTrash ? 'r.deleted_at IS NOT NULL' : 'r.deleted_at IS NULL']

    if (query.boardId !== null) {
      filters.push('r.id IN (SELECT reference_id FROM board_items WHERE board_id = @boardId)')
      params['boardId'] = query.boardId
    }
    const scope = `WHERE ${filters.join(' AND ')}`

    if (query.tags.length > 0) {
      const names = query.tags.map((tag, index) => {
        params[`tag${index}`] = tag
        return `@tag${index}`
      })
      // A reference must carry every selected tag.
      filters.push(`r.id IN (SELECT rt.ref_id FROM ref_tags rt JOIN tags t ON t.id = rt.tag_id
        WHERE t.name IN (${names.join(', ')}) GROUP BY rt.ref_id HAVING COUNT(*) = @tagCount)`)
      params['tagCount'] = query.tags.length
    }
    const fts = toFtsQuery(query.text)
    if (fts !== null) {
      filters.push('r.id IN (SELECT rowid FROM refs_fts WHERE refs_fts MATCH @fts)')
      params['fts'] = fts
    }
    const where = `WHERE ${filters.join(' AND ')}`
    // The Trash lists the most recently deleted first.
    const order = query.inTrash ? 'r.deleted_at DESC, r.id DESC' : 'r.created_at DESC, r.id DESC'

    const rows = this.db
      .prepare(
        `SELECT r.id, r.title, r.thumb_hash, r.thumb_width, r.thumb_height,
           r.image_hash, r.image_width, r.image_height, ${TAGS_OF_REF} AS tags
         FROM refs r ${where}
         ORDER BY ${order}`,
      )
      .all(params) as CardRow[]

    const items: ReferenceCard[] = rows.map((row) => ({
      id: row.id,
      title: row.title,
      thumbHash: row.thumb_hash,
      thumbWidth: row.thumb_width,
      thumbHeight: row.thumb_height,
      imageHash: row.image_hash,
      imageWidth: row.image_width,
      imageHeight: row.image_height,
      tags: JSON.parse(row.tags) as string[],
    }))

    const scopeParams = query.boardId !== null ? { boardId: query.boardId } : {}
    // Tag counts cover the selected board, so the filter list shows what can be narrowed to.
    const tags = this.db
      .prepare(
        `SELECT t.name AS name, COUNT(*) AS count FROM ref_tags rt
         JOIN tags t ON t.id = rt.tag_id
         JOIN refs r ON r.id = rt.ref_id ${scope}
         GROUP BY t.id ORDER BY count DESC, t.name`,
      )
      .all(scopeParams) as TagCount[]

    const counts = this.db
      .prepare(
        `SELECT COUNT(*) FILTER (WHERE deleted_at IS NULL) AS library,
           COUNT(*) FILTER (WHERE deleted_at IS NOT NULL) AS trash FROM refs`,
      )
      .get() as { library: number; trash: number }
    return {
      boards: this.listBoards(),
      totalCount: counts.library,
      trashCount: counts.trash,
      tags,
      items,
    }
  }

  /** Boards in the order the user gave them (migration 0011_board_order). */
  listBoards(): BoardSummary[] {
    return this.db.prepare(`${BOARD_SUMMARY} ORDER BY b.position, b.id`).all() as BoardSummary[]
  }

  /**
   * Puts the boards in this order, in one transaction. `ids` must name every board
   * exactly once; anything else is refused and nothing changes.
   */
  reorderBoards(ids: readonly number[]): BoardSummary[] {
    const apply = this.db.transaction(() => {
      const existing = this.db.prepare('SELECT id FROM boards').pluck().all() as number[]
      const wanted = new Set(ids)
      const complete =
        wanted.size === ids.length &&
        ids.length === existing.length &&
        existing.every((id) => wanted.has(id))
      if (!complete) {
        throw new Error('The new board order must list every board exactly once')
      }
      const setPosition = this.db.prepare('UPDATE boards SET position = ? WHERE id = ?')
      ids.forEach((id, position) => setPosition.run(position, id))
    })
    apply()
    return this.listBoards()
  }

  assetInfo(ids: readonly number[]): Array<{
    id: number
    title: string
    imageHash: string
    imageMime: string
    thumbHash: string
  }> {
    if (ids.length === 0) return []
    return this.db
      .prepare(
        `SELECT id, title, image_hash AS imageHash, image_mime AS imageMime, thumb_hash AS thumbHash
         FROM refs WHERE deleted_at IS NULL AND id IN (${ids.map(() => '?').join(', ')})
         ORDER BY id`,
      )
      .all(...ids) as Array<{
      id: number
      title: string
      imageHash: string
      imageMime: string
      thumbHash: string
    }>
  }

  libraryTags(): TagCount[] {
    return this.db
      .prepare(
        `SELECT t.name AS name, COUNT(*) AS count FROM ref_tags rt
         JOIN tags t ON t.id = rt.tag_id
         JOIN refs r ON r.id = rt.ref_id
         WHERE r.deleted_at IS NULL
         GROUP BY t.id ORDER BY count DESC, t.name`,
      )
      .all() as TagCount[]
  }

  tagNames(): string[] {
    const rows = this.db
      .prepare(
        `SELECT t.name AS name FROM tags t
         WHERE EXISTS (SELECT 1 FROM ref_tags rt JOIN refs r ON r.id = rt.ref_id
                       WHERE rt.tag_id = t.id AND r.deleted_at IS NULL)
         ORDER BY t.name`,
      )
      .all() as Array<{ name: string }>
    return rows.map((row) => row.name)
  }

  createBoard(name: string, createdAt: string): BoardSummary {
    // A new board goes to the end of the list.
    const result = this.db
      .prepare(
        `INSERT INTO boards (name, created_at, position)
         VALUES (?, ?, (SELECT COALESCE(MAX(position), -1) + 1 FROM boards))`,
      )
      .run(name, createdAt)
    return { id: Number(result.lastInsertRowid), name, count: 0, viewMode: 'canvas' }
  }

  findBoardByName(name: string): BoardSummary | null {
    const row = this.db.prepare(`${BOARD_SUMMARY} WHERE b.name = ? COLLATE NOCASE`).get(name) as
      BoardSummary | undefined
    return row ?? null
  }
}

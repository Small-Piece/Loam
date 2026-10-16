import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ReferenceService, type CanvasOp, type ImageUpload, type NoteInput } from '@loam/core'
import {
  FileBlobStore,
  loadMigrations,
  openDatabase,
  runMigrations,
  sha256Hasher,
  SqliteReferenceRepository,
} from './index.ts'
import type { Database as SqliteDatabase } from 'better-sqlite3'

const migrationsDir = fileURLToPath(new URL('../../../migrations', import.meta.url))
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function upload(seed: number): ImageUpload {
  const png = (label: string) =>
    Uint8Array.from([...PNG_SIGNATURE, ...new TextEncoder().encode(label)])
  return {
    fileName: `image-${seed}.png`,
    bytes: png(`image ${seed}`),
    width: 1200,
    height: 800,
    thumbnail: { bytes: png(`thumb ${seed}`), width: 480, height: 320 },
  }
}

const note = (overrides: Partial<NoteInput> = {}): NoteInput => ({
  text: 'Rim light',
  x: 40,
  y: -60,
  width: null,
  fontSize: 'M',
  color: 'paper',
  background: true,
  z: 50,
  attachedItemId: null,
  groupId: null,
  ...overrides,
})

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'loam-board-items-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

/** A copy of the migrations folder holding only the files before `before` (e.g. '0012'). */
function migrationsBefore(before: string): string {
  const folder = join(dir, `before-${before}`)
  mkdirSync(folder)
  for (const name of readdirSync(migrationsDir).filter((file) => file < before)) {
    copyFileSync(join(migrationsDir, name), join(folder, name))
  }
  return folder
}

describe('migration 0012_board_item_ids', () => {
  it('gives every placement an id and moves note attachments to it, keeping every value', () => {
    const db = new Database(join(dir, 'old.db'))
    db.pragma('foreign_keys = ON')
    expect(runMigrations(db, loadMigrations(migrationsBefore('0012')))).toBe(11)

    const insertRef = db.prepare(
      `INSERT INTO refs (id, image_hash, image_mime, image_bytes, image_width, image_height,
         thumb_hash, thumb_width, thumb_height, title, created_at)
       VALUES (?, ?, 'image/png', 10, 1200, 800, ?, 480, 320, ?, '2026-10-01T00:00:00Z')`,
    )
    for (const id of [1, 2, 3]) {
      insertRef.run(id, String(id).repeat(64), String(id + 3).repeat(64), `ref ${id}`)
    }
    const insertBoard = db.prepare(
      "INSERT INTO boards (id, name, created_at, position) VALUES (?, ?, '2026-10-01', ?)",
    )
    insertBoard.run(10, 'Characters', 0)
    insertBoard.run(20, 'Zone', 1)
    db.prepare(
      "INSERT INTO board_groups (id, board_id, title, color, locked, z) VALUES (5, 10, 'Light', 'teal', 0, 4)",
    ).run()
    const insertItem = db.prepare(
      `INSERT INTO board_items (board_id, reference_id, x, y, scale, rotation, z, flip_x, flip_y, group_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    // Board 10: two items share z 2 (ties broke by reference id), one is grouped and flipped.
    insertItem.run(10, 3, 10.5, -20.25, 0.5, 0, 2, 0, 0, null)
    insertItem.run(10, 1, 300, 40, 0.75, 15, 2, 1, 0, 5)
    insertItem.run(10, 2, -80, 900, 1.25, 0, 1, 0, 1, 5)
    insertItem.run(20, 1, 0, 0, 0.5, 0, 7, 0, 0, null)
    const insertNote = db.prepare(
      `INSERT INTO board_notes (id, board_id, text, x, y, width, font_size, color, background, z,
         attached_reference_id, group_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    insertNote.run(3, 10, 'free', 5, 6, null, 'S', 'amber', 1, 9, null, null)
    insertNote.run(4, 10, 'on ref 1', 40, -60, 200, 'L', 'teal', 0, 1, 1, null)
    insertNote.run(7, 20, 'on ref 1, zone', 1, 2, null, 'M', 'paper', 1, 2, 1, null)
    insertNote.run(8, 10, 'in group', 7, 8, null, 'XL', 'red', 1, 3, null, 5)
    // A note whose image is not on its board: 0005 never allowed one, but test it anyway.
    insertNote.run(9, 20, 'orphan', 0, 0, null, 'M', 'paper', 1, 1, 3, null)
    // The note id counter is ahead of the highest id (a deleted note had id 12).
    db.prepare("UPDATE sqlite_sequence SET seq = 12 WHERE name = 'board_notes'").run()

    const itemsBefore = db
      .prepare(
        `SELECT board_id, reference_id, x, y, scale, rotation, z, flip_x, flip_y, group_id
         FROM board_items ORDER BY board_id, z, reference_id`,
      )
      .all()
    const groupsBefore = db.prepare('SELECT * FROM board_groups ORDER BY id').all()

    expect(runMigrations(db, loadMigrations(migrationsDir))).toBe(12)

    // Every placement and value kept; ids follow the old draw order on each board.
    const itemsAfter = db.prepare('SELECT * FROM board_items ORDER BY id').all() as Array<
      Record<string, unknown>
    >
    expect(itemsAfter.map(({ id: _id, ...rest }) => rest)).toEqual(itemsBefore)
    expect(itemsAfter.map((row) => [row['id'], row['board_id'], row['reference_id']])).toEqual([
      [1, 10, 2],
      [2, 10, 1],
      [3, 10, 3],
      [4, 20, 1],
    ])
    expect(db.prepare('SELECT * FROM board_groups ORDER BY id').all()).toEqual(groupsBefore)

    // Notes keep their ids and values; attachments point at the placement on their own board.
    expect(db.prepare('SELECT * FROM board_notes ORDER BY id').all()).toEqual([
      {
        id: 3,
        board_id: 10,
        text: 'free',
        x: 5,
        y: 6,
        width: null,
        font_size: 'S',
        color: 'amber',
        background: 1,
        z: 9,
        attached_item_id: null,
        group_id: null,
      },
      {
        id: 4,
        board_id: 10,
        text: 'on ref 1',
        x: 40,
        y: -60,
        width: 200,
        font_size: 'L',
        color: 'teal',
        background: 0,
        z: 1,
        attached_item_id: 2,
        group_id: null,
      },
      {
        id: 7,
        board_id: 20,
        text: 'on ref 1, zone',
        x: 1,
        y: 2,
        width: null,
        font_size: 'M',
        color: 'paper',
        background: 1,
        z: 2,
        attached_item_id: 4,
        group_id: null,
      },
      {
        id: 8,
        board_id: 10,
        text: 'in group',
        x: 7,
        y: 8,
        width: null,
        font_size: 'XL',
        color: 'red',
        background: 1,
        z: 3,
        attached_item_id: null,
        group_id: 5,
      },
    ])
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok')
    expect(db.pragma('foreign_key_check')).toEqual([])

    // The canvas draws in the same order as before (z, then the old reference-id tie break).
    const repository = new SqliteReferenceRepository(db)
    expect(repository.listCanvas(10, true).map((item) => item.referenceId)).toEqual([2, 1, 3])

    // Ids are never handed out again: notes continue after the old counter, items after the last.
    const nextNote = db
      .prepare("INSERT INTO board_notes (board_id, x, y, color, z) VALUES (10, 0, 0, 'paper', 1)")
      .run().lastInsertRowid
    expect(Number(nextNote)).toBe(13)
    const nextItem = repository.putItems(10, [
      { referenceId: 1, x: 0, y: 0, scale: 1, z: 1, groupId: null },
    ])
    expect(nextItem).toEqual([5])

    // A placement removed takes its attached note with it (ON DELETE CASCADE).
    db.prepare('DELETE FROM board_items WHERE id = 2').run()
    expect(db.prepare('SELECT id FROM board_notes ORDER BY id').pluck().all()).toEqual([
      3, 7, 8, 13,
    ])
    db.close()
  })
})

describe('several placements of one reference', () => {
  let db: SqliteDatabase
  let service: ReferenceService
  let boardId: number
  let refs: number[]

  function open(): void {
    db = openDatabase({ filePath: join(dir, 'loam.db'), migrationsDir }).db
    service = new ReferenceService({
      repository: new SqliteReferenceRepository(db),
      blobs: new FileBlobStore(join(dir, 'files')),
      hasher: sha256Hasher,
      clock: { now: () => new Date('2026-10-15T00:00:00.000Z') },
    })
  }

  beforeEach(async () => {
    open()
    boardId = service.createBoard('Zone 2').id
    const outcomes = await service.importImages([1, 2].map(upload), null)
    refs = outcomes.map((outcome) => (outcome.status === 'rejected' ? -1 : outcome.id))
  })

  afterEach(() => db.close())

  const canvas = () => service.getCanvas(boardId)
  const apply = (ops: CanvasOp[]) => service.applyCanvas(boardId, ops)
  const board = () => service.listBoard({ boardId: null, inTrash: false, tags: [], text: '' })

  it('dropping the same image three times makes three items that keep their own places', () => {
    const a = refs[0]!
    const first = service.addToBoard(boardId, [a], { x: 0, y: 0 })
    const second = service.addToBoard(boardId, [a], { x: 2000, y: 0 })
    const third = service.addToBoard(boardId, [a], { x: 0, y: 2000 })
    expect([first.ids, second.ids, third.ids]).toEqual([[a], [a], [a]])
    const itemIds = [...first.itemIds, ...second.itemIds, ...third.itemIds]
    expect(new Set(itemIds).size).toBe(3)

    // Move and resize one copy only.
    const one = canvas().items.find((item) => item.id === itemIds[1])!
    apply([{ op: 'putItems', items: [{ ...one, x: 4321, scale: 0.125 }] }])
    const before = canvas().items
    expect(before.map((item) => item.referenceId)).toEqual([a, a, a])
    expect(before.find((item) => item.id === itemIds[1])).toMatchObject({ x: 4321, scale: 0.125 })
    expect(before.find((item) => item.id === itemIds[0])).toMatchObject({ x: -300, y: -200 })

    db.close()
    open()
    expect(canvas().items).toEqual(before)
  })

  it('a board counts distinct references; the board filter and board list show each once', () => {
    const [a, b] = refs as [number, number]
    service.addToBoard(boardId, [a, b], { x: 0, y: 0 })
    service.addToBoard(boardId, [a], { x: 900, y: 900 })
    service.addToBoard(boardId, [a], { x: 1800, y: 1800 })
    expect(canvas().items).toHaveLength(4)
    expect(canvas().board.count).toBe(2)
    expect(board().boards.find((entry) => entry.id === boardId)?.count).toBe(2)
    const filtered = service.listBoard({ boardId, inTrash: false, tags: [], text: '' })
    expect(filtered.items.map((item) => item.id).sort()).toEqual([a, b].sort())
    expect(service.getDetail(a)?.boardIds).toEqual([boardId])
  })

  it('without a drop point an image already on the board is not placed again', async () => {
    const a = refs[0]!
    service.addToBoard(boardId, [a], { x: 0, y: 0 })
    expect(service.addToBoard(boardId, [a], null).itemIds).toEqual([])
    // An imported file that is already in the Library: placed again only with a drop point.
    await service.importImages([upload(1)], boardId, null)
    expect(canvas().items).toHaveLength(1)
    await service.importImages([upload(1)], boardId, { x: 500, y: 500 })
    expect(canvas().items).toHaveLength(2)
  })

  it('a duplicate made by the canvas gets its id back in the same round trip', () => {
    const a = refs[0]!
    const [original] = service.addToBoard(boardId, [a], { x: 0, y: 0 }).itemIds
    const item = canvas().items[0]!
    const copy = apply([
      {
        op: 'putItems',
        items: [{ ...item, id: undefined, key: 'copy', x: item.x + 24, y: item.y + 24, z: 9 }],
      },
    ])
    const copyId = copy.created.items['copy']!
    expect(copyId).not.toBe(original)
    expect(copy.view.items.map((entry) => entry.id).sort()).toEqual([original, copyId].sort())
    // Undo removes the copy only.
    apply(copy.undo)
    expect(canvas().items.map((entry) => entry.id)).toEqual([original])
  })

  it('removing one copy keeps the others and their notes; undo brings it back exactly', () => {
    const a = refs[0]!
    const [keep] = service.addToBoard(boardId, [a], { x: 0, y: 0 }).itemIds
    const [drop] = service.addToBoard(boardId, [a], { x: 2000, y: 0 }).itemIds
    apply([
      {
        op: 'putNotes',
        notes: [
          note({ key: 'k', text: 'on the kept copy', attachedItemId: keep! }),
          note({ key: 'd', text: 'on the removed copy', attachedItemId: drop! }),
        ],
      },
    ])
    const before = canvas()
    const { undo } = apply([{ op: 'removeItems', itemIds: [drop!] }])
    expect(canvas().items.map((item) => item.id)).toEqual([keep])
    expect(canvas().notes.map((entry) => entry.text)).toEqual(['on the kept copy'])
    apply(undo)
    expect(canvas()).toEqual(before)
  })

  it('a note attached to one copy stays with that copy when the copies move', () => {
    const a = refs[0]!
    const [first] = service.addToBoard(boardId, [a], { x: 0, y: 0 }).itemIds
    const [second] = service.addToBoard(boardId, [a], { x: 2000, y: 0 }).itemIds
    apply([{ op: 'putNotes', notes: [note({ key: 'n', attachedItemId: second! })] }])
    const items = canvas().items
    apply([
      {
        op: 'putItems',
        items: items.map((item) => ({ ...item, x: item.x + (item.id === first ? 500 : -500) })),
      },
    ])
    expect(canvas().notes[0]).toMatchObject({ attachedItemId: second, x: 40, y: -60 })
  })

  it('Remove from board takes every placement of the reference; undo puts all of them back', () => {
    const [a, b] = refs as [number, number]
    service.addToBoard(boardId, [a, b], { x: 0, y: 0 })
    const [copy] = service.addToBoard(boardId, [a], { x: 0, y: 2000 }).itemIds
    apply([{ op: 'putNotes', notes: [note({ key: 'n', attachedItemId: copy! })] }])
    const before = canvas()
    const { removed, undo } = service.removeFromBoard(boardId, [a])
    expect(removed).toEqual([a])
    expect(canvas().items.map((item) => item.referenceId)).toEqual([b])
    expect(canvas().notes).toEqual([])
    apply(undo)
    expect(canvas()).toEqual(before)
  })

  it('refuses an item id from another board, or one that places another reference', () => {
    const [a, b] = refs as [number, number]
    const other = service.createBoard('Other').id
    const [foreign] = service.addToBoard(other, [a], { x: 0, y: 0 }).itemIds
    const [own] = service.addToBoard(boardId, [a], { x: 0, y: 0 }).itemIds
    const placement = { x: 0, y: 0, scale: 1, z: 1, groupId: null }
    expect(() =>
      apply([{ op: 'putItems', items: [{ ...placement, id: foreign!, referenceId: a }] }]),
    ).toThrow(/another board/)
    expect(() =>
      apply([{ op: 'putItems', items: [{ ...placement, id: own!, referenceId: b }] }]),
    ).toThrow(/another reference/)
    // Removing by an item id of another board changes nothing there.
    apply([{ op: 'removeItems', itemIds: [foreign!] }])
    expect(service.getCanvas(other).items.map((item) => item.id)).toEqual([foreign])
  })

  it('never reuses a removed item id, so an undo cannot overwrite a newer item', () => {
    const a = refs[0]!
    const [first] = service.addToBoard(boardId, [a], { x: 0, y: 0 }).itemIds
    apply([{ op: 'removeItems', itemIds: [first!] }])
    const [second] = service.addToBoard(boardId, [a], { x: 0, y: 0 }).itemIds
    expect(second).toBeGreaterThan(first!)
  })
})

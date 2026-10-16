import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ReferenceService, type ImageUpload, type Placement } from '@loam/core'
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

function fakePng(label: string): Uint8Array {
  return Uint8Array.from([...PNG_SIGNATURE, ...new TextEncoder().encode(label)])
}

function upload(seed: number, width = 1200, height = 800): ImageUpload {
  return {
    fileName: `image-${seed}.png`,
    bytes: fakePng(`image ${seed}`),
    width,
    height,
    thumbnail: { bytes: fakePng(`thumb ${seed}`), width: 480, height: 320 },
  }
}

describe('board placements', () => {
  let dir: string
  let db: SqliteDatabase
  let service: ReferenceService

  function open(): void {
    db = openDatabase({ filePath: join(dir, 'loam.db'), migrationsDir }).db
    service = new ReferenceService({
      repository: new SqliteReferenceRepository(db),
      blobs: new FileBlobStore(join(dir, 'files')),
      hasher: sha256Hasher,
      clock: { now: () => new Date('2026-10-12T00:00:00.000Z') },
    })
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'loam-placements-'))
    open()
  })

  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  async function importIds(seeds: number[], boardId: number | null = null): Promise<number[]> {
    const outcomes = await service.importImages(
      seeds.map((seed) => upload(seed)),
      boardId,
    )
    return outcomes.map((outcome) => (outcome.status === 'rejected' ? -1 : outcome.id))
  }

  const canvas = (boardId: number) => service.getCanvas(boardId).items
  /** The id of the (first) placement of a reference on a board. */
  const itemOf = (boardId: number, referenceId: number | undefined) =>
    canvas(boardId).find((item) => item.referenceId === referenceId)?.id

  /**
   * Saves item positions through the canvas edit path (groups unchanged: none here).
   * Each placement moves the reference's existing item on the board.
   */
  const savePlacements = (boardId: number, placements: Placement[]) =>
    service.applyCanvas(boardId, [
      {
        op: 'putItems',
        items: placements.map((placement) => ({
          ...placement,
          id: itemOf(boardId, placement.referenceId),
          groupId: null,
        })),
      },
    ])

  it('places imported images around the drop point, at most 600 units on the long side', async () => {
    const board = service.createBoard('Zone 2')
    const outcomes = await service.importImages([upload(1, 1200, 800)], board.id, { x: 100, y: 50 })
    const [item] = canvas(board.id)
    expect(item).toMatchObject({
      referenceId: outcomes[0]?.status === 'created' ? outcomes[0].id : -1,
      x: -200,
      y: -150,
      scale: 0.5,
      rotation: 0,
      flipX: false,
      flipY: false,
    })
  })

  it('adds Library references below what is already on the board, on top of it', async () => {
    const board = service.createBoard('Zone 2')
    const [a, b] = await importIds([1, 2])
    service.addToBoard(board.id, [a ?? -1], { x: 0, y: 0 })
    service.addToBoard(board.id, [b ?? -1], null)
    const [first, second] = canvas(board.id)
    expect(first?.referenceId).toBe(a)
    expect(second?.referenceId).toBe(b)
    expect(second?.y).toBeGreaterThan((first?.y ?? 0) + 400)
    expect(second?.z).toBeGreaterThan(first?.z ?? 0)
  })

  it('leaves an item where it is when it is added again without a drop point', async () => {
    const board = service.createBoard('Zone 2')
    const [a] = await importIds([1])
    service.addToBoard(board.id, [a ?? -1], { x: 0, y: 0 })
    const before = canvas(board.id)
    expect(service.addToBoard(board.id, [a ?? -1, 999], null)).toEqual({ ids: [a], itemIds: [] })
    expect(canvas(board.id)).toEqual(before)
  })

  it('saves moves, scales and z order, and they survive a restart unchanged', async () => {
    const board = service.createBoard('Zone 2')
    const [a, b] = await importIds([1, 2], board.id)
    savePlacements(board.id, [
      { referenceId: a ?? -1, x: 123.5, y: -456.25, scale: 1.75, z: 10 },
      { referenceId: b ?? -1, x: -9.125, y: 77, scale: 0.0625, z: -3 },
    ])
    const before = canvas(board.id)
    expect(before.map((item) => item.referenceId)).toEqual([b, a]) // ordered by z

    db.close()
    open()
    expect(canvas(board.id)).toEqual(before)
  })

  it('rejects invalid placements and unknown references, changing nothing', async () => {
    const board = service.createBoard('Zone 2')
    const [a] = await importIds([1], board.id)
    const before = canvas(board.id)
    const good = { referenceId: a ?? -1, x: 0, y: 0, scale: 1, z: 1 }
    expect(() => savePlacements(board.id, [{ ...good, scale: 0 }])).toThrow(/Invalid/)
    expect(() => savePlacements(board.id, [{ ...good, x: Number.NaN }])).toThrow(/Invalid/)
    expect(() => savePlacements(board.id, [good, good])).toThrow(/appears twice/)
    expect(() => savePlacements(board.id, [{ ...good, referenceId: 999 }])).toThrow(/999/)
    expect(() => savePlacements(404, [good])).toThrow(/Board 404/)
    expect(canvas(board.id)).toEqual(before)
  })

  it('keeps one image on many boards, each with its own placement', async () => {
    const one = service.createBoard('One')
    const two = service.createBoard('Two')
    const [a] = await importIds([1])
    service.addToBoard(one.id, [a ?? -1], { x: 0, y: 0 })
    service.addToBoard(two.id, [a ?? -1], { x: 900, y: 900 })
    savePlacements(one.id, [{ referenceId: a ?? -1, x: 1, y: 2, scale: 2, z: 5 }])
    expect(canvas(two.id)[0]).toMatchObject({ x: 600, y: 700 })
    expect(service.getDetail(a ?? -1)?.boardIds).toEqual([one.id, two.id])
  })

  it('removing an item from a board never deletes the reference from the Library', async () => {
    const one = service.createBoard('One')
    const two = service.createBoard('Two')
    const [a, b] = await importIds([1, 2], one.id)
    service.addToBoard(two.id, [a ?? -1], null)

    const { removed } = service.removeFromBoard(one.id, [a ?? -1])
    expect(removed).toHaveLength(1)
    expect(canvas(one.id).map((item) => item.referenceId)).toEqual([b])
    expect(canvas(two.id).map((item) => item.referenceId)).toEqual([a])
    const library = service.listBoard({ boardId: null, inTrash: false, tags: [], text: '' })
    expect(library.totalCount).toBe(2)
    expect(library.trashCount).toBe(0)
    expect(service.getDetail(a ?? -1)?.deletedAt).toBeNull()
  })

  it('hides trashed references on the canvas and brings them back in place on restore', async () => {
    const board = service.createBoard('Zone 2')
    const [a, b] = await importIds([1, 2], board.id)
    const before = canvas(board.id)
    service.moveToTrash([a ?? -1])
    expect(canvas(board.id).map((item) => item.referenceId)).toEqual([b])
    service.restoreFromTrash([a ?? -1])
    expect(canvas(board.id)).toEqual(before)
  })

  it('new items avoid the spot of a trashed item, so a restore never overlaps', async () => {
    const board = service.createBoard('Zone 2')
    const [a] = await importIds([1], board.id)
    service.moveToTrash([a ?? -1])
    const [b] = await importIds([2], board.id)
    const items = service.getCanvas(board.id).items
    expect(items.map((item) => item.referenceId)).toEqual([b])
    expect(items[0]?.y).toBeGreaterThan(400)
  })

  it('the detail panel board list keeps placements on boards that stay checked', async () => {
    const one = service.createBoard('One')
    const two = service.createBoard('Two')
    const [a] = await importIds([1], one.id)
    savePlacements(one.id, [{ referenceId: a ?? -1, x: 42, y: 43, scale: 1.5, z: 9 }])
    service.update(a ?? -1, { boardIds: [one.id, two.id] })
    expect(canvas(one.id)[0]).toMatchObject({ x: 42, y: 43, scale: 1.5, z: 9 })
    expect(canvas(two.id)).toHaveLength(1)
    service.update(a ?? -1, { boardIds: [two.id] })
    expect(canvas(one.id)).toEqual([])
  })

  it('emptying the Trash removes its placements', async () => {
    const board = service.createBoard('Zone 2')
    const [a] = await importIds([1], board.id)
    service.moveToTrash([a ?? -1])
    await service.emptyTrash()
    expect(db.prepare('SELECT COUNT(*) AS n FROM board_items').get()).toEqual({ n: 0 })
  })

  it('remembers each board view mode, canvas by default', () => {
    const board = service.createBoard('Zone 2')
    expect(service.getCanvas(board.id).board.viewMode).toBe('canvas')
    service.setViewMode(board.id, 'grid')
    db.close()
    open()
    expect(service.getCanvas(board.id).board.viewMode).toBe('grid')
  })
})

describe('migration 0004', () => {
  it('turns Slice 1 board memberships into placements in a grid, newest first', () => {
    const dir = mkdtempSync(join(tmpdir(), 'loam-migrate-'))
    try {
      // Build a database at schema 3 using only migrations 0001-0003.
      const early = join(dir, 'early')
      mkdirSync(early)
      for (const name of ['0001_init.sql', '0002_references.sql', '0003_trash.sql']) {
        copyFileSync(join(migrationsDir, name), join(early, name))
      }
      const file = join(dir, 'old.db')
      const db = new Database(file)
      db.pragma('foreign_keys = ON')
      expect(runMigrations(db, loadMigrations(early))).toBe(3)
      const insertRef = db.prepare(
        `INSERT INTO refs (id, image_hash, image_mime, image_bytes, image_width, image_height,
           thumb_hash, thumb_width, thumb_height, title, created_at)
         VALUES (?, ?, 'image/png', 10, ?, ?, ?, 480, 270, ?, ?)`,
      )
      insertRef.run(1, 'a'.repeat(64), 1200, 600, 'b'.repeat(64), 'older', '2026-10-01T00:00:00Z')
      insertRef.run(2, 'c'.repeat(64), 300, 900, 'd'.repeat(64), 'newer', '2026-10-02T00:00:00Z')
      db.prepare(
        "INSERT INTO boards (id, name, created_at) VALUES (7, 'Old board', '2026-10-01')",
      ).run()
      db.prepare('INSERT INTO board_refs (board_id, ref_id) VALUES (7, 1), (7, 2)').run()

      // Now apply 0004 (and only up to it: later migrations have their own tests).
      const upTo4 = join(dir, 'upTo4')
      mkdirSync(upTo4)
      for (const name of [
        '0001_init.sql',
        '0002_references.sql',
        '0003_trash.sql',
        '0004_board_items.sql',
      ]) {
        copyFileSync(join(migrationsDir, name), join(upTo4, name))
      }
      expect(runMigrations(db, loadMigrations(upTo4))).toBe(4)
      const rows = db
        .prepare('SELECT reference_id, x, y, scale, z FROM board_items ORDER BY z')
        .all()
      expect(rows).toEqual([
        { reference_id: 2, x: 0, y: 0, scale: 600 / 900, z: 1 },
        { reference_id: 1, x: 640, y: 0, scale: 0.5, z: 2 },
      ])
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'board_refs'")
        .all()
      expect(tables).toEqual([])
      expect(db.prepare('SELECT view_mode FROM boards WHERE id = 7').get()).toEqual({
        view_mode: 'canvas',
      })
      db.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

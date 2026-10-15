import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DomainError, ReferenceService, type ImageUpload } from '@loam/core'
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

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'loam-board-order-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Every row of the board tables, for comparing before and after a migration. */
function boardTables(db: SqliteDatabase) {
  const all = (sql: string) => db.prepare(sql).all()
  return {
    boards: all('SELECT id, name, created_at, view_mode FROM boards ORDER BY id'),
    items: all('SELECT * FROM board_items ORDER BY board_id, reference_id'),
    groups: all('SELECT * FROM board_groups ORDER BY id'),
    notes: all('SELECT * FROM board_notes ORDER BY id'),
  }
}

describe('migration 0011_board_order', () => {
  it('keeps the alphabetical order existing boards were shown in, and changes nothing else', () => {
    // A database at schema 10, the last schema before board order.
    const early = join(dir, 'early')
    mkdirSync(early)
    for (const name of readdirSync(migrationsDir).filter((file) => file < '0011')) {
      copyFileSync(join(migrationsDir, name), join(early, name))
    }
    const db = new Database(join(dir, 'old.db'))
    db.pragma('foreign_keys = ON')
    expect(runMigrations(db, loadMigrations(early))).toBe(10)

    const insertBoard = db.prepare(
      "INSERT INTO boards (id, name, created_at) VALUES (?, ?, '2026-10-01T00:00:00Z')",
    )
    insertBoard.run(1, 'moodboard')
    insertBoard.run(2, 'Characters')
    insertBoard.run(3, 'zone sketches')
    insertBoard.run(4, 'Architecture')
    db.prepare(
      `INSERT INTO refs (id, image_hash, image_mime, image_bytes, image_width, image_height,
         thumb_hash, thumb_width, thumb_height, title, created_at)
       VALUES (1, ?, 'image/png', 10, 1200, 800, ?, 480, 320, 'ref', '2026-10-01T00:00:00Z')`,
    ).run('a'.repeat(64), 'b'.repeat(64))
    db.prepare(
      "INSERT INTO board_groups (id, board_id, title, color, locked, z) VALUES (5, 1, 'Light', 'teal', 0, 1)",
    ).run()
    db.prepare(
      'INSERT INTO board_items (board_id, reference_id, x, y, scale, z, group_id) VALUES (1, 1, 10, 20, 0.5, 2, 5)',
    ).run()
    db.prepare(
      "INSERT INTO board_notes (id, board_id, text, x, y, color, z, attached_reference_id) VALUES (9, 1, 'warm', 0, 0, 'amber', 3, 1)",
    ).run()
    const before = boardTables(db)

    expect(runMigrations(db, loadMigrations(migrationsDir))).toBe(11)

    const repository = new SqliteReferenceRepository(db)
    expect(repository.listBoards().map((board) => board.name)).toEqual([
      'Architecture',
      'Characters',
      'moodboard',
      'zone sketches',
    ])
    expect(db.prepare('SELECT id, position FROM boards ORDER BY id').all()).toEqual([
      { id: 1, position: 2 },
      { id: 2, position: 1 },
      { id: 3, position: 3 },
      { id: 4, position: 0 },
    ])
    expect(boardTables(db)).toEqual(before)
    db.close()
  })
})

describe('board order', () => {
  let db: SqliteDatabase
  let repository: SqliteReferenceRepository
  let service: ReferenceService

  function open() {
    db = openDatabase({ filePath: join(dir, 'loam.db'), migrationsDir }).db
    repository = new SqliteReferenceRepository(db)
    service = new ReferenceService({
      repository,
      blobs: new FileBlobStore(join(dir, 'files')),
      hasher: sha256Hasher,
      clock: { now: () => new Date('2026-10-15T00:00:00.000Z') },
    })
  }

  beforeEach(() => open())
  afterEach(() => db.close())

  const names = () => repository.listBoards().map((board) => board.name)

  it('puts a new board at the end, whatever its name', () => {
    service.createBoard('Zebra')
    service.createBoard('Alpha')
    service.createBoard('middle')
    expect(names()).toEqual(['Zebra', 'Alpha', 'middle'])
  })

  it('reorders all boards in one step, and the order survives a restart', () => {
    const [a, b, c] = ['One', 'Two', 'Three'].map((name) => service.createBoard(name).id)
    const boards = service.reorderBoards([c!, a!, b!])
    expect(boards.map((board) => board.name)).toEqual(['Three', 'One', 'Two'])
    db.close()
    open()
    expect(names()).toEqual(['Three', 'One', 'Two'])
    // A board created afterwards still goes last.
    service.createBoard('Four')
    expect(names()).toEqual(['Three', 'One', 'Two', 'Four'])
  })

  it('refuses an incomplete, unknown or repeated id list and changes nothing', () => {
    const [a, b, c] = ['One', 'Two', 'Three'].map((name) => service.createBoard(name).id)
    const attempts = [
      [a!, b!],
      [a!, b!, c!, 999],
      [a!, b!, b!],
      [a!, b!, 999],
    ]
    for (const ids of attempts) {
      expect(() => service.reorderBoards(ids)).toThrow(DomainError)
      expect(names()).toEqual(['One', 'Two', 'Three'])
    }
  })

  it('a deleted board leaves the others in their order', () => {
    const ids = ['One', 'Two', 'Three', 'Four'].map((name) => service.createBoard(name).id)
    service.reorderBoards([ids[3]!, ids[1]!, ids[0]!, ids[2]!])
    // The app has no board deletion yet; this is what removing the row would do.
    db.prepare('DELETE FROM boards WHERE id = ?').run(ids[1])
    expect(names()).toEqual(['Four', 'One', 'Three'])
    service.createBoard('Five')
    expect(names()).toEqual(['Four', 'One', 'Three', 'Five'])
  })

  it("counts a board's canvas placements of Library references, not trashed ones", async () => {
    const board = service.createBoard('Counted')
    const other = service.createBoard('Other')
    const outcomes = await service.importImages([upload(1), upload(2), upload(3)], board.id)
    const ids = outcomes.map((outcome) => (outcome.status === 'rejected' ? -1 : outcome.id))
    await service.importImages([upload(4)], other.id)
    await service.importImages([upload(5)], null)
    const count = (boardId: number) =>
      repository.listBoards().find((summary) => summary.id === boardId)?.count
    expect(count(board.id)).toBe(3)
    expect(count(other.id)).toBe(1)
    service.moveToTrash([ids[0]!])
    expect(count(board.id)).toBe(2)
  })
})

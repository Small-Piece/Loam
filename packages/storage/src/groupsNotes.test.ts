import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ReferenceService,
  type BoardNote,
  type CanvasOp,
  type ImageUpload,
  type NoteInput,
} from '@loam/core'
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
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const fakePng = (label: string) => Uint8Array.from([...PNG, ...new TextEncoder().encode(label)])

function upload(seed: number): ImageUpload {
  return {
    fileName: `image-${seed}.png`,
    bytes: fakePng(`image ${seed}`),
    width: 1200,
    height: 800,
    thumbnail: { bytes: fakePng(`thumb ${seed}`), width: 480, height: 320 },
  }
}

const note = (overrides: Partial<NoteInput> = {}): NoteInput => ({
  text: 'Backlight on the helmet',
  x: 100,
  y: 200,
  width: null,
  fontSize: 'M',
  color: 'paper',
  background: true,
  z: 50,
  attachedReferenceId: null,
  groupId: null,
  ...overrides,
})

describe('groups and notes', () => {
  let dir: string
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
      clock: { now: () => new Date('2026-10-12T00:00:00.000Z') },
    })
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'loam-groups-'))
    open()
    boardId = service.createBoard('Zone 2').id
    const outcomes = await service.importImages([1, 2, 3, 4].map(upload), boardId)
    refs = outcomes.map((outcome) => (outcome.status === 'rejected' ? -1 : outcome.id))
  })

  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const canvas = () => service.getCanvas(boardId)
  const apply = (ops: CanvasOp[]) => service.applyCanvas(boardId, ops)
  const item = (id: number) => canvas().items.find((entry) => entry.referenceId === id)
  /** Puts these images in a new group, the way Ctrl+G does. */
  function group(ids: number[], z = 0) {
    return apply([
      { op: 'putGroups', groups: [{ key: 'g', title: 'Group', color: 'slate', locked: true, z }] },
      {
        op: 'putItems',
        items: ids.map((id) => {
          const current = item(id)
          if (!current) throw new Error(`item ${id} missing`)
          return { ...current, groupId: null, groupKey: 'g' }
        }),
      },
    ])
  }

  describe('groups', () => {
    it('groups images and gives the new group an id, locked with the default title', () => {
      const result = group([refs[0]!, refs[1]!])
      const groupId = result.created.groups['g']
      expect(groupId).toBeGreaterThan(0)
      expect(result.view.groups).toEqual([
        { id: groupId, title: 'Group', color: 'slate', locked: true, z: 0 },
      ])
      expect(result.view.items.filter((entry) => entry.groupId === groupId)).toHaveLength(2)
    })

    it('undo of grouping removes the group and restores membership, in one step', () => {
      const before = canvas()
      const { undo } = group([refs[0]!, refs[1]!])
      apply(undo)
      expect(canvas()).toEqual(before)
    })

    it('ungroup keeps every child where it was, and undo puts the group back with the same id', () => {
      const { created } = group([refs[0]!, refs[1]!, refs[2]!])
      const groupId = created.groups['g']!
      const grouped = canvas()
      const { undo } = apply([{ op: 'deleteGroups', ids: [groupId] }])
      const after = canvas()
      expect(after.groups).toEqual([])
      for (const entry of after.items) {
        const was = grouped.items.find((other) => other.referenceId === entry.referenceId)
        expect({ ...entry, groupId: null }).toEqual({ ...was, groupId: null })
        expect(entry.groupId).toBeNull()
      }
      apply(undo)
      expect(canvas()).toEqual(grouped)
    })

    it('a group disappears when its last child leaves, and undo brings both back', () => {
      const { created } = group([refs[0]!])
      const groupId = created.groups['g']!
      const grouped = canvas()
      const { undo } = apply([{ op: 'putItems', items: [{ ...item(refs[0]!)!, groupId: null }] }])
      expect(canvas().groups).toEqual([])
      apply(undo)
      expect(canvas()).toEqual(grouped)
      expect(canvas().groups[0]?.id).toBe(groupId)
    })

    it('moving the whole group keeps children exactly where they were moved, after a restart', () => {
      group([refs[0]!, refs[1]!])
      const moved = canvas().items.map((entry) => ({
        ...entry,
        x: entry.x + 123.25,
        y: entry.y - 7.5,
      }))
      apply([{ op: 'putItems', items: moved }])
      const before = canvas()
      db.close()
      open()
      expect(canvas()).toEqual(before)
    })

    it('rejects a group from another board and a group key never created', () => {
      const other = service.createBoard('Other')
      const foreign = service.applyCanvas(other.id, [
        { op: 'putGroups', groups: [{ key: 'x', title: 'X', color: 'blue', locked: true, z: 0 }] },
        { op: 'putNotes', notes: [note({ groupId: null, groupKey: 'x' })] },
      ]).created.groups['x']!
      const target = { ...item(refs[0]!)!, groupId: foreign }
      expect(() => apply([{ op: 'putItems', items: [target] }])).toThrow(/not on this board/)
      expect(() =>
        apply([
          { op: 'putItems', items: [{ ...item(refs[0]!)!, groupId: null, groupKey: 'nope' }] },
        ]),
      ).toThrow(/No group/)
      expect(() =>
        apply([
          {
            op: 'putGroups',
            groups: [{ id: foreign, title: 'X', color: 'blue', locked: true, z: 0 }],
          },
        ]),
      ).toThrow(/another board/)
    })

    it('stores title, colour and lock, and rejects unknown colours', () => {
      const { created } = group([refs[0]!])
      const id = created.groups['g']!
      apply([
        {
          op: 'putGroups',
          groups: [{ id, title: '  Ashfall rim  ', color: 'violet', locked: false, z: 3 }],
        },
      ])
      expect(canvas().groups).toEqual([
        { id, title: 'Ashfall rim', color: 'violet', locked: false, z: 3 },
      ])
      apply([
        { op: 'putGroups', groups: [{ id, title: '   ', color: 'violet', locked: false, z: 3 }] },
      ])
      expect(canvas().groups[0]?.title).toBe('Group')
      expect(() =>
        apply([
          {
            op: 'putGroups',
            groups: [{ id, title: 'x', color: 'chartreuse' as 'blue', locked: true, z: 1 }],
          },
        ]),
      ).toThrow(/colour/)
    })
  })

  describe('notes', () => {
    it('creates, edits and deletes notes; each step undoes on its own', () => {
      const empty = canvas()
      const created = apply([{ op: 'putNotes', notes: [note({ key: 'n' })] }])
      const id = created.created.notes['n']!
      const afterCreate = canvas()
      expect(afterCreate.notes).toEqual([{ ...note(), id, groupId: null }])

      const edited = apply([
        {
          op: 'putNotes',
          notes: [
            note({
              id,
              text: 'Rim light\nsecond line',
              fontSize: 'XL',
              color: 'amber',
              width: 320,
              background: false,
            }),
          ],
        },
      ])
      const afterEdit = canvas()
      const deleted = apply([{ op: 'deleteNotes', ids: [id] }])
      expect(canvas().notes).toEqual([])

      apply(deleted.undo)
      expect(canvas()).toEqual(afterEdit)
      apply(edited.undo)
      expect(canvas()).toEqual(afterCreate)
      apply(created.undo)
      expect(canvas()).toEqual(empty)
    })

    it('note text, size, colour and width survive a restart', () => {
      apply([
        {
          op: 'putNotes',
          notes: [
            note({
              key: 'n',
              text: 'Ä multi\nline 注',
              fontSize: 'L',
              color: 'teal',
              width: 412.5,
            }),
          ],
        },
      ])
      const before = canvas().notes
      db.close()
      open()
      expect(canvas().notes).toEqual(before)
    })

    it('never reuses a deleted note id, so an undo cannot overwrite a newer note', () => {
      const first = apply([{ op: 'putNotes', notes: [note({ key: 'a' })] }]).created.notes['a']!
      apply([{ op: 'deleteNotes', ids: [first] }])
      const second = apply([{ op: 'putNotes', notes: [note({ key: 'b' })] }]).created.notes['b']!
      expect(second).toBeGreaterThan(first)
    })

    it('rejects invalid notes', () => {
      expect(() => apply([{ op: 'putNotes', notes: [note({ width: 0 })] }])).toThrow(/width/)
      expect(() => apply([{ op: 'putNotes', notes: [note({ x: Number.NaN })] }])).toThrow(
        /position/,
      )
      expect(() => apply([{ op: 'putNotes', notes: [note({ fontSize: 'XXL' as 'XL' })] }])).toThrow(
        /size/,
      )
    })

    it('notes can be grouped like images', () => {
      const result = apply([
        {
          op: 'putGroups',
          groups: [{ key: 'g', title: 'Group', color: 'slate', locked: true, z: 0 }],
        },
        { op: 'putNotes', notes: [note({ key: 'n', groupId: null, groupKey: 'g' })] },
      ])
      expect(result.view.notes[0]?.groupId).toBe(result.created.groups['g'])
    })
  })

  describe('attach and detach', () => {
    function attachedNote(): number {
      return apply([
        {
          op: 'putNotes',
          notes: [note({ key: 'n', x: 40, y: -60, attachedReferenceId: refs[0]! })],
        },
      ]).created.notes['n']!
    }

    it('stores the offset relative to the image, so moving the image needs no note update', () => {
      const id = attachedNote()
      const image = item(refs[0]!)!
      apply([{ op: 'putItems', items: [{ ...image, x: image.x + 500, scale: image.scale * 2 }] }])
      expect(canvas().notes.find((entry) => entry.id === id)).toMatchObject({ x: 40, y: -60 })
    })

    it('an attached note is never in a group', () => {
      const result = apply([
        {
          op: 'putGroups',
          groups: [{ key: 'g', title: 'Group', color: 'slate', locked: true, z: 0 }],
        },
        { op: 'putItems', items: [{ ...item(refs[1]!)!, groupId: null, groupKey: 'g' }] },
        {
          op: 'putNotes',
          notes: [note({ key: 'n', attachedReferenceId: refs[0]!, groupId: null, groupKey: 'g' })],
        },
      ])
      expect(result.view.notes[0]?.groupId).toBeNull()
    })

    it('only attaches to an image that is on this board', async () => {
      const [outside] = await service.importImages([upload(9)], null)
      const outsideId = outside?.status === 'created' ? outside.id : -1
      expect(() =>
        apply([{ op: 'putNotes', notes: [note({ attachedReferenceId: outsideId })] }]),
      ).toThrow(/not on this board/)
    })

    it('removing the image from the board removes its note; undo brings both back', () => {
      const id = attachedNote()
      const before = canvas()
      const { removed, undo } = service.removeFromBoard(boardId, [refs[0]!])
      expect(removed).toEqual([refs[0]])
      expect(canvas().notes.find((entry) => entry.id === id)).toBeUndefined()
      // The image is still in the Library.
      expect(service.getDetail(refs[0]!)?.deletedAt).toBeNull()
      apply(undo)
      expect(canvas()).toEqual(before)
    })

    it('detach keeps the note where it is, as a free note', () => {
      const id = attachedNote()
      const image = item(refs[0]!)!
      const current = canvas().notes.find((entry) => entry.id === id) as BoardNote
      const absolute = {
        x: image.x + current.x * image.scale,
        y: image.y + current.y * image.scale,
      }
      const { undo } = apply([
        { op: 'putNotes', notes: [{ ...current, ...absolute, attachedReferenceId: null }] },
      ])
      expect(canvas().notes[0]).toMatchObject({ ...absolute, attachedReferenceId: null })
      apply(undo)
      expect(canvas().notes[0]).toMatchObject({ x: 40, y: -60, attachedReferenceId: refs[0] })
    })

    it('a note attached to an image in the Trash is hidden, and purged with it', async () => {
      const id = attachedNote()
      service.moveToTrash([refs[0]!])
      expect(canvas().notes.find((entry) => entry.id === id)).toBeUndefined()
      service.restoreFromTrash([refs[0]!])
      expect(canvas().notes.find((entry) => entry.id === id)).toBeDefined()
      service.moveToTrash([refs[0]!])
      await service.emptyTrash()
      expect(db.prepare('SELECT COUNT(*) AS n FROM board_notes').get()).toEqual({ n: 0 })
    })

    it('emptying the Trash drops groups it leaves empty', async () => {
      group([refs[0]!])
      service.moveToTrash([refs[0]!])
      expect(canvas().groups).toHaveLength(1) // hidden child, group kept for a restore
      await service.emptyTrash()
      expect(canvas().groups).toEqual([])
    })
  })

  it('an edit that fails part-way changes nothing', () => {
    const before = canvas()
    expect(() =>
      apply([
        { op: 'putNotes', notes: [note({ key: 'ok' })] },
        { op: 'putItems', items: [{ ...item(refs[0]!)!, groupId: null, scale: -1 }] },
      ]),
    ).toThrow()
    expect(canvas()).toEqual(before)
  })
})

describe('migration 0005', () => {
  it('adds groups and notes to a schema-4 database, keeping every placement', () => {
    const dir = mkdtempSync(join(tmpdir(), 'loam-m5-'))
    try {
      const upTo4 = join(dir, 'upTo4')
      mkdirSync(upTo4)
      for (const name of readdirSync(migrationsDir)) {
        if (Number(name.slice(0, 4)) <= 4)
          copyFileSync(join(migrationsDir, name), join(upTo4, name))
      }
      const db = new Database(join(dir, 'old.db'))
      try {
        db.pragma('foreign_keys = ON')
        expect(runMigrations(db, loadMigrations(upTo4))).toBe(4)
        db.prepare(
          `INSERT INTO refs (id, image_hash, image_mime, image_bytes, image_width, image_height,
           thumb_hash, thumb_width, thumb_height, title, created_at)
         VALUES (1, ?, 'image/png', 1, 800, 600, ?, 480, 360, 'old', '2026-10-01')`,
        ).run('a'.repeat(64), 'b'.repeat(64))
        db.prepare(
          "INSERT INTO boards (id, name, created_at) VALUES (3, 'Board', '2026-10-01')",
        ).run()
        db.prepare(
          'INSERT INTO board_items (board_id, reference_id, x, y, scale, z) VALUES (3, 1, 12.5, -4, 0.75, 2)',
        ).run()

        // Apply 0005 and only up to it: later migrations have their own tests.
        const upTo5 = join(dir, 'upTo5')
        mkdirSync(upTo5)
        for (const name of readdirSync(migrationsDir)) {
          if (Number(name.slice(0, 4)) <= 5)
            copyFileSync(join(migrationsDir, name), join(upTo5, name))
        }
        expect(runMigrations(db, loadMigrations(upTo5))).toBe(5)
        expect(db.prepare('SELECT * FROM board_items').all()).toEqual([
          {
            board_id: 3,
            reference_id: 1,
            x: 12.5,
            y: -4,
            scale: 0.75,
            rotation: 0,
            z: 2,
            flip_x: 0,
            flip_y: 0,
            group_id: null,
          },
        ])
        const tables = db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB 'board_*' ORDER BY name",
          )
          .all()
        expect(tables).toEqual([
          { name: 'board_groups' },
          { name: 'board_items' },
          { name: 'board_notes' },
        ])
        // Deleting a group leaves its children in place, ungrouped.
        db.prepare(
          "INSERT INTO board_groups (id, board_id, title, color, z) VALUES (1, 3, 'G', 'slate', 1)",
        ).run()
        db.prepare('UPDATE board_items SET group_id = 1').run()
        db.prepare('DELETE FROM board_groups WHERE id = 1').run()
        expect(db.prepare('SELECT group_id FROM board_items').get()).toEqual({ group_id: null })
        expect(() =>
          db
            .prepare(
              "INSERT INTO board_notes (board_id, x, y, color, z, font_size) VALUES (3, 0, 0, 'paper', 1, 'XXL')",
            )
            .run(),
        ).toThrow(/CHECK/)
      } finally {
        db.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

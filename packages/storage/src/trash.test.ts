import { existsSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ReferenceService, type ImageUpload } from '@loam/core'
import { FileBlobStore, openDatabase, sha256Hasher, SqliteReferenceRepository } from './index.ts'
import type { Database } from 'better-sqlite3'

const migrationsDir = fileURLToPath(new URL('../../../migrations', import.meta.url))
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** Bytes that sniff as PNG; the label makes the content (and hash) unique. */
function fakePng(label: string): Uint8Array {
  return Uint8Array.from([...PNG_SIGNATURE, ...new TextEncoder().encode(label)])
}

function upload(seed: number, thumbLabel = `thumb ${seed}`): ImageUpload {
  return {
    fileName: `image-${seed}.png`,
    bytes: fakePng(`image ${seed}`),
    width: 1600,
    height: 900,
    thumbnail: { bytes: fakePng(thumbLabel), width: 480, height: 270 },
  }
}

const hashOf = (label: string) => sha256Hasher.sha256(fakePng(label))

describe('trash', () => {
  let dir: string
  let db: Database
  let blobs: FileBlobStore
  let service: ReferenceService
  let tick = 0

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'loam-trash-'))
    tick = 0
    db = openDatabase({ filePath: join(dir, 'loam.db'), migrationsDir }).db
    blobs = new FileBlobStore(join(dir, 'files'))
    service = new ReferenceService({
      repository: new SqliteReferenceRepository(db),
      blobs,
      hasher: sha256Hasher,
      clock: { now: () => new Date(Date.UTC(2026, 9, 12) + tick++ * 1000) },
    })
  })

  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  async function importIds(seeds: number[]): Promise<number[]> {
    const outcomes = await service.importImages(
      seeds.map((seed) => upload(seed)),
      null,
    )
    return outcomes.map((outcome) => {
      if (outcome.status === 'rejected') throw new Error(outcome.reason)
      return outcome.id
    })
  }

  const library = (query: { boardId?: number | null; tags?: string[]; text?: string } = {}) =>
    service.listBoard({
      inTrash: false,
      boardId: query.boardId ?? null,
      tags: query.tags ?? [],
      text: query.text ?? '',
    })
  const trash = (query: { tags?: string[]; text?: string } = {}) =>
    service.listBoard({
      inTrash: true,
      boardId: null,
      tags: query.tags ?? [],
      text: query.text ?? '',
    })
  const sorted = (ids: number[]) => [...ids].sort((a, b) => a - b)

  describe('move to Trash and restore', () => {
    it('restores 10 deleted references with their tags and boards intact', async () => {
      const boardA = service.createBoard('Zone 2 forest')
      const boardB = service.createBoard('Silhouettes')
      const ids = await importIds(Array.from({ length: 12 }, (_, index) => index + 1))
      ids.forEach((id, index) => {
        service.update(id, {
          note: `note ${index}`,
          tags: index % 2 === 0 ? ['forest', `n${index}`] : ['cave'],
          boardIds: index % 3 === 0 ? [boardA.id, boardB.id] : [boardA.id],
        })
      })
      const before = new Map(ids.map((id) => [id, service.getDetail(id)]))
      const selection = ids.slice(0, 10)

      expect(sorted(service.moveToTrash(selection))).toEqual(sorted(selection))
      expect(library().totalCount).toBe(2)
      expect(library().trashCount).toBe(10)

      expect(sorted(service.restoreFromTrash(selection))).toEqual(sorted(selection))
      expect(library().totalCount).toBe(12)
      expect(library().trashCount).toBe(0)
      for (const id of selection) {
        expect(service.getDetail(id)).toEqual(before.get(id))
      }
    })

    it('hides trashed references from the Library, boards, tag counts and search', async () => {
      const board = service.createBoard('Zone 2')
      const [a, b] = await importIds([1, 2])
      service.update(a ?? -1, { title: 'Crystal cave', tags: ['cave'], boardIds: [board.id] })
      service.update(b ?? -1, { title: 'Oakmere town', tags: ['town'], boardIds: [board.id] })
      service.moveToTrash([a ?? -1])

      expect(library().items.map((item) => item.id)).toEqual([b])
      expect(library({ boardId: board.id }).items.map((item) => item.id)).toEqual([b])
      expect(library({ text: 'crystal' }).items).toEqual([])
      expect(library({ tags: ['cave'] }).items).toEqual([])
      expect(library().tags).toEqual([{ name: 'town', count: 1 }])
      expect(library().boards).toEqual([
        { id: board.id, name: 'Zone 2', count: 1, viewMode: 'canvas' },
      ])
    })

    it('lists the Trash newest-deleted first, with search and tag filter', async () => {
      const [a, b, c] = await importIds([1, 2, 3])
      service.update(a ?? -1, { title: 'Crystal cave', tags: ['cave'] })
      service.moveToTrash([a ?? -1])
      service.moveToTrash([c ?? -1])
      expect(trash().items.map((item) => item.id)).toEqual([c, a])
      expect(trash({ text: 'crystal' }).items.map((item) => item.id)).toEqual([a])
      expect(trash({ tags: ['cave'] }).items.map((item) => item.id)).toEqual([a])
      expect(trash().items.some((item) => item.id === b)).toBe(false)
      expect(service.getDetail(a ?? -1)?.deletedAt).not.toBeNull()
    })

    it('reports only the ids that actually moved', async () => {
      const [a, b] = await importIds([1, 2])
      expect(service.moveToTrash([a ?? -1, a ?? -1])).toEqual([a])
      expect(service.moveToTrash([a ?? -1, b ?? -1, 999])).toEqual([b])
      expect(sorted(service.restoreFromTrash([a ?? -1, b ?? -1, 999]))).toEqual(
        sorted([a ?? -1, b ?? -1]),
      )
      expect(service.restoreFromTrash([a ?? -1])).toEqual([])
    })

    it('handles a selection larger than one SQL statement allows', async () => {
      const uploads = Array.from({ length: 1200 }, (_, index) => upload(index + 1))
      const ids: number[] = []
      for (let start = 0; start < uploads.length; start += 200) {
        const outcomes = await service.importImages(uploads.slice(start, start + 200), null)
        for (const outcome of outcomes) if (outcome.status !== 'rejected') ids.push(outcome.id)
      }
      expect(service.moveToTrash(ids)).toHaveLength(1200)
      expect(service.restoreFromTrash(ids)).toHaveLength(1200)
    }, 30_000)

    it('restores a trashed image when it is imported again', async () => {
      const board = service.createBoard('Zone 2')
      const [id] = await importIds([5])
      service.update(id ?? -1, { tags: ['forest'], boardIds: [board.id], note: 'keep me' })
      service.moveToTrash([id ?? -1])

      const [outcome] = await service.importImages([upload(5)], null)
      expect(outcome).toEqual({ fileName: 'image-5.png', status: 'restored', id })
      expect(service.getDetail(id ?? -1)).toMatchObject({
        deletedAt: null,
        note: 'keep me',
        tags: ['forest'],
        boardIds: [board.id],
      })
    })
  })

  describe('empty Trash and file cleanup', () => {
    it('deletes references and the files no other reference uses', async () => {
      const [a, b] = await importIds([1, 2])
      service.update(a ?? -1, { tags: ['only-on-a'] })
      service.moveToTrash([a ?? -1])

      const result = await service.emptyTrash()
      expect(result).toEqual({ deletedReferences: 1, deletedFiles: 2 })
      expect(service.getDetail(a ?? -1)).toBeNull()
      expect(existsSync(blobs.pathOf(hashOf('image 1')))).toBe(false)
      expect(existsSync(blobs.pathOf(hashOf('thumb 1')))).toBe(false)
      // The untouched reference and its files are still there.
      expect(service.getDetail(b ?? -1)).not.toBeNull()
      expect(existsSync(blobs.pathOf(hashOf('image 2')))).toBe(true)
      expect(existsSync(blobs.pathOf(hashOf('thumb 2')))).toBe(true)
      // Tags that only the purged reference used are gone; search no longer finds it.
      expect(library().tags).toEqual([])
      expect(trash().items).toEqual([])
    })

    it('keeps a file shared with a remaining reference', async () => {
      // Same picture saved twice in different formats: different originals, identical thumbnails.
      const outcomes = await service.importImages(
        [upload(1, 'shared thumb'), upload(2, 'shared thumb')],
        null,
      )
      const [a] = outcomes.map((outcome) => (outcome.status === 'created' ? outcome.id : -1))
      service.moveToTrash([a ?? -1])

      const result = await service.emptyTrash()
      expect(result).toEqual({ deletedReferences: 1, deletedFiles: 1 })
      expect(existsSync(blobs.pathOf(hashOf('image 1')))).toBe(false)
      expect(existsSync(blobs.pathOf(hashOf('shared thumb')))).toBe(true)
      expect(existsSync(blobs.pathOf(hashOf('image 2')))).toBe(true)
    })

    it('keeps files when both sharers are purged only after the last one goes', async () => {
      const outcomes = await service.importImages(
        [upload(1, 'shared thumb'), upload(2, 'shared thumb')],
        null,
      )
      const [a, b] = outcomes.map((outcome) => (outcome.status === 'created' ? outcome.id : -1))
      service.moveToTrash([a ?? -1, b ?? -1])
      expect(await service.emptyTrash()).toEqual({ deletedReferences: 2, deletedFiles: 3 })
      expect(existsSync(blobs.pathOf(hashOf('shared thumb')))).toBe(false)
    })

    it('removes board links and leaves the board in place', async () => {
      const board = service.createBoard('Zone 2')
      const [a] = await importIds([1])
      service.update(a ?? -1, { boardIds: [board.id] })
      service.moveToTrash([a ?? -1])
      await service.emptyTrash()
      expect(library().boards).toEqual([
        { id: board.id, name: 'Zone 2', count: 0, viewMode: 'canvas' },
      ])
      expect(db.prepare('SELECT COUNT(*) AS n FROM board_items').get()).toEqual({ n: 0 })
    })

    it('tolerates a file that is already missing', async () => {
      const [a] = await importIds([1])
      unlinkSync(blobs.pathOf(hashOf('image 1')))
      service.moveToTrash([a ?? -1])
      expect(await service.emptyTrash()).toEqual({ deletedReferences: 1, deletedFiles: 1 })
    })

    it('does nothing when the Trash is empty', async () => {
      await importIds([1])
      expect(await service.emptyTrash()).toEqual({ deletedReferences: 0, deletedFiles: 0 })
      expect(library().totalCount).toBe(1)
    })

    it('stores an image again after its purge, as a new reference', async () => {
      const [a] = await importIds([1])
      service.moveToTrash([a ?? -1])
      await service.emptyTrash()
      const [outcome] = await service.importImages([upload(1)], null)
      expect(outcome?.status).toBe('created')
      expect(existsSync(blobs.pathOf(hashOf('image 1')))).toBe(true)
    })

    it('never leaves a reference without its file when emptying races an import', async () => {
      const [a] = await importIds([1])
      service.moveToTrash([a ?? -1])
      const [, outcomes] = await Promise.all([
        service.emptyTrash(),
        service.importImages([upload(1)], null),
      ])
      const [outcome] = outcomes
      if (outcome === undefined || outcome.status === 'rejected') throw new Error('import failed')
      const detail = service.getDetail(outcome.id)
      expect(detail).not.toBeNull()
      expect(existsSync(blobs.pathOf(detail?.imageHash ?? ''))).toBe(true)
    })
  })

  describe('remove from board', () => {
    it('keeps the reference in the Library and on other boards, and can be undone', async () => {
      const boardA = service.createBoard('A')
      const boardB = service.createBoard('B')
      const [a, b] = await importIds([1, 2])
      service.update(a ?? -1, { boardIds: [boardA.id, boardB.id] })
      service.update(b ?? -1, { boardIds: [boardA.id] })

      const before = service.getCanvas(boardA.id).items
      const { removed, undo } = service.removeFromBoard(boardA.id, [a ?? -1, b ?? -1])
      expect(sorted(removed)).toEqual(sorted([a ?? -1, b ?? -1]))
      expect(library({ boardId: boardA.id }).items).toEqual([])
      expect(library().totalCount).toBe(2)
      expect(service.getDetail(a ?? -1)?.boardIds).toEqual([boardB.id])

      // Undo puts them back exactly where they were.
      service.applyCanvas(boardA.id, undo)
      expect(sorted(library({ boardId: boardA.id }).items.map((item) => item.id))).toEqual(
        sorted([a ?? -1, b ?? -1]),
      )
      expect(service.getCanvas(boardA.id).items).toEqual(before)
    })

    it('reports only references that were on the board', async () => {
      const board = service.createBoard('A')
      const [a, b] = await importIds([1, 2])
      service.update(a ?? -1, { boardIds: [board.id] })
      const { removed } = service.removeFromBoard(board.id, [a ?? -1, b ?? -1])
      expect(removed).toEqual([a])
    })

    it('rejects an unknown board', () => {
      expect(() => service.removeFromBoard(999, [1])).toThrow(/Board 999/)
      expect(() => library({ boardId: 999 })).toThrow(/Board 999/)
    })

    it('refuses to list a board inside the Trash', () => {
      expect(() => service.listBoard({ inTrash: true, boardId: 1, tags: [], text: '' })).toThrow(
        /Trash/,
      )
    })
  })
})

import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ReferenceService, type ImageUpload } from '@loam/core'
import { FileBlobStore, openDatabase, sha256Hasher, SqliteReferenceRepository } from './index.ts'
import type { Database } from 'better-sqlite3'

const migrationsDir = fileURLToPath(new URL('../../../migrations', import.meta.url))
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** A byte payload that sniffs as PNG; the seed makes its content (and hash) unique. */
function fakePng(seed: number): Uint8Array {
  const body = new TextEncoder().encode(`fake image ${seed}`)
  return Uint8Array.from([...PNG_SIGNATURE, ...body])
}

function upload(seed: number, fileName = `image-${seed}.png`): ImageUpload {
  return {
    fileName,
    bytes: fakePng(seed),
    width: 1920,
    height: 1080,
    thumbnail: { bytes: fakePng(seed + 1_000_000), width: 480, height: 270 },
  }
}

describe('reference board storage', () => {
  let dir: string
  let db: Database
  let blobs: FileBlobStore
  let service: ReferenceService
  let clockTick = 0

  function open(): void {
    db = openDatabase({ filePath: join(dir, 'loam.db'), migrationsDir }).db
    blobs = new FileBlobStore(join(dir, 'files'))
    service = new ReferenceService({
      repository: new SqliteReferenceRepository(db),
      blobs,
      hasher: sha256Hasher,
      // Strictly increasing timestamps give a stable newest-first order.
      clock: { now: () => new Date(Date.UTC(2026, 9, 12) + clockTick++ * 1000) },
    })
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'loam-refs-'))
    clockTick = 0
    open()
  })

  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  function blobCount(): number {
    const root = join(dir, 'files')
    if (!existsSync(root)) return 0
    return readdirSync(root).reduce((sum, shard) => sum + readdirSync(join(root, shard)).length, 0)
  }

  describe('import', () => {
    it('stores image and thumbnail in the content-addressed store and creates a reference', async () => {
      const [outcome] = await service.importImages([upload(1, 'Ashfall Zone 2.png')], null)
      expect(outcome).toMatchObject({ status: 'created' })
      if (outcome?.status !== 'created') return

      const detail = service.getDetail(outcome.id)
      expect(detail).toMatchObject({
        title: 'Ashfall Zone 2',
        note: '',
        tags: [],
        imageMime: 'image/png',
        imageWidth: 1920,
        imageHeight: 1080,
      })
      expect(detail?.imageHash).toBe(sha256Hasher.sha256(fakePng(1)))
      expect(await blobs.has(detail?.imageHash ?? '')).toBe(true)
      expect(blobCount()).toBe(2)
    })

    it('rejects files that are not images, without storing anything', async () => {
      const notImage = { ...upload(1, 'notes.png'), bytes: new TextEncoder().encode('%PDF-1.7') }
      const [outcome] = await service.importImages([notImage], null)
      expect(outcome).toMatchObject({ status: 'rejected', reason: 'Not a supported image format' })
      expect(blobCount()).toBe(0)
    })

    it('adds imported references to the given board', async () => {
      const board = service.createBoard('Zone 2 forest')
      const outcomes = await service.importImages([upload(1), upload(2)], board.id)
      const view = service.listBoard({ inTrash: false, boardId: board.id, tags: [], text: '' })
      expect(view.items.map((item) => item.id).sort()).toEqual(
        outcomes.map((outcome) => (outcome.status === 'rejected' ? -1 : outcome.id)).sort(),
      )
    })
  })

  describe('dedup', () => {
    it('stores the same image once, even under a different file name', async () => {
      const [first] = await service.importImages([upload(7, 'a.png')], null)
      const [second] = await service.importImages([upload(7, 'copy of a.png')], null)
      expect(first?.status).toBe('created')
      expect(second?.status).toBe('duplicate')
      if (first?.status === 'rejected' || second?.status === 'rejected') return
      expect(second?.id).toBe(first?.id)
      expect(
        service.listBoard({ inTrash: false, boardId: null, tags: [], text: '' }).totalCount,
      ).toBe(1)
      expect(blobCount()).toBe(2)
    })

    it('dedups within a single import batch', async () => {
      const outcomes = await service.importImages([upload(3), upload(3)], null)
      expect(outcomes.map((outcome) => outcome.status)).toEqual(['created', 'duplicate'])
    })

    it('dedups concurrent imports of the same image', async () => {
      const [a, b] = await Promise.all([
        service.importImages([upload(5)], null),
        service.importImages([upload(5)], null),
      ])
      const statuses = [a?.[0]?.status, b?.[0]?.status].sort()
      expect(statuses).toEqual(['created', 'duplicate'])
      expect(
        service.listBoard({ inTrash: false, boardId: null, tags: [], text: '' }).totalCount,
      ).toBe(1)
    })

    it('puts a re-dropped image into a new board without duplicating it', async () => {
      const [first] = await service.importImages([upload(9)], null)
      const board = service.createBoard('Silhouettes')
      const [again] = await service.importImages([upload(9)], board.id)
      expect(again?.status).toBe('duplicate')
      if (first?.status !== 'created') return
      expect(service.getDetail(first.id)?.boardIds).toEqual([board.id])
    })
  })

  describe('edit and persistence', () => {
    it('keeps title, note, source, tags and boards across a reopen', async () => {
      const board = service.createBoard('Character silhouettes')
      const [outcome] = await service.importImages([upload(1)], null)
      if (outcome?.status !== 'created') throw new Error('import failed')
      service.update(outcome.id, {
        title: 'Reg silhouette',
        note: 'Strong backlight, rim on helmet',
        source: 'Artbook p.12',
        tags: ['Character', 'silhouette', 'character'],
        boardIds: [board.id],
      })

      db.close()
      open()

      expect(service.getDetail(outcome.id)).toMatchObject({
        title: 'Reg silhouette',
        note: 'Strong backlight, rim on helmet',
        source: 'Artbook p.12',
        tags: ['character', 'silhouette'],
        boardIds: [board.id],
      })
    })

    it('rejects an empty title and unknown boards', async () => {
      const [outcome] = await service.importImages([upload(1)], null)
      if (outcome?.status !== 'created') throw new Error('import failed')
      expect(() => service.update(outcome.id, { title: '   ' })).toThrow(/Title/)
      expect(() => service.update(outcome.id, { boardIds: [999] })).toThrow(/Board 999/)
    })

    it('returns null when updating a reference that does not exist', () => {
      expect(service.update(12345, { note: 'x' })).toBeNull()
    })

    it('treats board names case-insensitively', () => {
      const a = service.createBoard('Zone 2 forest')
      const b = service.createBoard('  zone 2   FOREST ')
      expect(b.id).toBe(a.id)
    })
  })

  describe('search', () => {
    async function seed(): Promise<Record<string, number>> {
      const specs = [
        {
          key: 'forest',
          title: 'Forest of giant trees',
          note: 'layer two canopy',
          tags: ['forest', 'zone2'],
        },
        {
          key: 'cave',
          title: 'Crystal cave',
          note: 'blue glow, forest edge',
          tags: ['cave', 'zone2'],
        },
        { key: 'town', title: 'Oakmere town', note: 'rooftops at dusk', tags: ['town'] },
        { key: 'reg', title: 'Robot boy', note: 'silhouette study', tags: ['character', 'forest'] },
      ]
      const ids: Record<string, number> = {}
      for (const [index, spec] of specs.entries()) {
        const [outcome] = await service.importImages([upload(index + 1)], null)
        if (outcome?.status !== 'created') throw new Error('import failed')
        service.update(outcome.id, { title: spec.title, note: spec.note, tags: spec.tags })
        ids[spec.key] = outcome.id
      }
      return ids
    }

    const idsOf = (query: { tags?: string[]; text?: string; boardId?: number | null }) =>
      service
        .listBoard({
          inTrash: false,
          boardId: query.boardId ?? null,
          tags: query.tags ?? [],
          text: query.text ?? '',
        })
        .items.map((item) => item.id)
        .sort()

    it('matches text in title or note, by word prefix', async () => {
      const ids = await seed()
      expect(idsOf({ text: 'forest' })).toEqual([ids['forest'], ids['cave']].sort())
      expect(idsOf({ text: 'silhou' })).toEqual([ids['reg']])
      expect(idsOf({ text: 'CRYSTAL' })).toEqual([ids['cave']])
    })

    it('requires every word to match', async () => {
      const ids = await seed()
      expect(idsOf({ text: 'blue forest' })).toEqual([ids['cave']])
      expect(idsOf({ text: 'blue town' })).toEqual([])
    })

    it('filters by one or more tags with AND semantics', async () => {
      const ids = await seed()
      expect(idsOf({ tags: ['zone2'] })).toEqual([ids['forest'], ids['cave']].sort())
      expect(idsOf({ tags: ['zone2', 'forest'] })).toEqual([ids['forest']])
      expect(idsOf({ tags: ['Forest'] })).toEqual([ids['forest'], ids['reg']].sort())
      expect(idsOf({ tags: ['missing'] })).toEqual([])
    })

    it('combines tag filter, text search and board scope', async () => {
      const ids = await seed()
      expect(idsOf({ tags: ['forest'], text: 'robot' })).toEqual([ids['reg']])
      const board = service.createBoard('Zone 2')
      service.update(ids['cave'] ?? -1, { boardIds: [board.id] })
      expect(idsOf({ boardId: board.id, tags: ['zone2'] })).toEqual([ids['cave']])
      expect(idsOf({ boardId: board.id, text: 'forest' })).toEqual([ids['cave']])
    })

    it('reflects title and note edits in search results', async () => {
      const ids = await seed()
      service.update(ids['town'] ?? -1, { note: 'misty forest outskirts' })
      expect(idsOf({ text: 'misty' })).toEqual([ids['town']])
      expect(idsOf({ text: 'rooftops' })).toEqual([])
    })

    it('treats FTS syntax in the query as plain text', async () => {
      await seed()
      expect(() => idsOf({ text: 'forest" OR NOT "x' })).not.toThrow()
      expect(() => idsOf({ text: '*' })).not.toThrow()
    })

    it('returns tag counts for the filter list and newest references first', async () => {
      const ids = await seed()
      const view = service.listBoard({ inTrash: false, boardId: null, tags: [], text: '' })
      expect(view.items.map((item) => item.id)).toEqual([
        ids['reg'],
        ids['town'],
        ids['cave'],
        ids['forest'],
      ])
      expect(view.tags).toEqual([
        { name: 'forest', count: 2 },
        { name: 'zone2', count: 2 },
        { name: 'cave', count: 1 },
        { name: 'character', count: 1 },
        { name: 'town', count: 1 },
      ])
    })
  })

  describe('500-reference test set', () => {
    const WORDS = [
      'forest',
      'cave',
      'ashfall',
      'relic',
      'town',
      'cliff',
      'river',
      'ruin',
      'mist',
      'glow',
    ]
    const TAGS = ['zone1', 'zone2', 'layer3', 'character', 'creature', 'landscape', 'prop', 'light']

    interface Seeded {
      id: number
      title: string
      note: string
      tags: string[]
    }

    async function seed500(): Promise<Seeded[]> {
      const uploads = Array.from({ length: 500 }, (_, index) => upload(index + 1))
      const outcomes = [
        ...(await service.importImages(uploads.slice(0, 200), null)),
        ...(await service.importImages(uploads.slice(200, 400), null)),
        ...(await service.importImages(uploads.slice(400), null)),
      ]
      const seeded: Seeded[] = []
      outcomes.forEach((outcome, index) => {
        if (outcome.status !== 'created') throw new Error('import failed')
        const title = `${WORDS[index % 10]} study ${index}`
        const note = `${WORDS[(index * 7) % 10]} and ${WORDS[(index * 3) % 10]} reference`
        const tags = TAGS.filter((_, tagIndex) => (index + tagIndex) % 3 === 0)
        service.update(outcome.id, { title, note, tags })
        seeded.push({ id: outcome.id, title, note, tags })
      })
      return seeded
    }

    /** Reference implementation of the filter, used to check the SQL results. */
    function expected(seeded: Seeded[], tags: string[], text: string): number[] {
      const words = text.toLowerCase().split(/\s+/).filter(Boolean)
      return seeded
        .filter((ref) => tags.every((tag) => ref.tags.includes(tag)))
        .filter((ref) => {
          const haystack = `${ref.title} ${ref.note}`.toLowerCase().split(/\s+/)
          return words.every((word) => haystack.some((token) => token.startsWith(word)))
        })
        .map((ref) => ref.id)
        .sort((a, b) => a - b)
    }

    it('returns correct tag-filter and text-search results in under 200 ms', async () => {
      const seeded = await seed500()
      expect(
        service.listBoard({ inTrash: false, boardId: null, tags: [], text: '' }).totalCount,
      ).toBe(500)

      const cases: Array<{ tags: string[]; text: string }> = [
        { tags: ['zone2'], text: '' },
        { tags: ['zone2', 'light'], text: '' },
        { tags: [], text: 'ashfall' },
        { tags: [], text: 'glow rel' },
        { tags: ['character'], text: 'mist' },
        { tags: ['creature', 'light'], text: 'forest study' },
      ]
      const timings: string[] = []
      for (const query of cases) {
        const started = performance.now()
        const view = service.listBoard({ inTrash: false, boardId: null, ...query })
        const elapsed = performance.now() - started
        timings.push(`${elapsed.toFixed(1)} ms`)
        expect(elapsed, `${JSON.stringify(query)} took ${elapsed.toFixed(1)} ms`).toBeLessThan(200)
        const actual = view.items.map((item) => item.id).sort((a, b) => a - b)
        expect(actual, JSON.stringify(query)).toEqual(expected(seeded, query.tags, query.text))
        expect(actual.length, JSON.stringify(query)).toBeGreaterThan(0)
      }
      console.log(`[500 refs] listBoard timings: ${timings.join(', ')}`)
    }, 30_000)
  })
})

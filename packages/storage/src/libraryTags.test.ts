import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ReferenceService, type ImageUpload } from '@loam/core'
import { FileBlobStore, openDatabase, sha256Hasher, SqliteReferenceRepository } from './index.ts'
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

describe('the Library-wide tag list', () => {
  let dir: string
  let db: SqliteDatabase
  let service: ReferenceService

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'loam-library-tags-'))
    db = openDatabase({ filePath: join(dir, 'loam.db'), migrationsDir }).db
    service = new ReferenceService({
      repository: new SqliteReferenceRepository(db),
      blobs: new FileBlobStore(join(dir, 'files')),
      hasher: sha256Hasher,
      clock: { now: () => new Date('2026-10-15T00:00:00.000Z') },
    })
  })

  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  async function reference(seed: number, boardId: number | null, tags: string[]): Promise<number> {
    const [outcome] = await service.importImages([upload(seed)], boardId)
    if (!outcome || outcome.status === 'rejected') throw new Error('import failed')
    service.update(outcome.id, { tags })
    return outcome.id
  }

  it('counts every Library reference whatever board it is on, most used first', async () => {
    const board = service.createBoard('Scenes')
    await reference(1, board.id, ['creature', 'forest'])
    await reference(2, null, ['creature'])
    await reference(3, null, ['cave'])
    expect(service.libraryTags()).toEqual([
      { name: 'creature', count: 2 },
      { name: 'cave', count: 1 },
      { name: 'forest', count: 1 },
    ])
    // The board's own filter list is narrower; the picker's list is not.
    expect(
      service.listBoard({ boardId: board.id, inTrash: false, tags: [], text: '' }).tags,
    ).toEqual([
      { name: 'creature', count: 1 },
      { name: 'forest', count: 1 },
    ])
  })

  it('leaves out references in the Trash, and tags used only there', async () => {
    await reference(1, null, ['creature'])
    const trashed = await reference(2, null, ['creature', 'crest'])
    service.moveToTrash([trashed])
    expect(service.libraryTags()).toEqual([{ name: 'creature', count: 1 }])
  })

  it('never stores a second spelling of a tag that differs only in case', async () => {
    const id = await reference(1, null, ['creature'])
    service.update(id, { tags: ['creature', 'Creature', ' CREATURE '] })
    await reference(2, null, ['Creature'])
    expect(service.libraryTags()).toEqual([{ name: 'creature', count: 2 }])
    expect(
      db.prepare("SELECT COUNT(*) FROM tags WHERE lower(name) = 'creature'").pluck().get(),
    ).toBe(1)
  })
})

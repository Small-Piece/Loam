import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  encodeClipboardMark,
  parseClipboardMark,
  ReferenceService,
  type ImageUpload,
} from '@loam/core'
import { FileBlobStore, openDatabase, sha256Hasher, SqliteReferenceRepository } from './index.ts'
import type { Database as SqliteDatabase } from 'better-sqlite3'

const migrationsDir = fileURLToPath(new URL('../../../migrations', import.meta.url))
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const GIF = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]

function upload(seed: number, signature = PNG): ImageUpload {
  const bytes = (label: string) =>
    Uint8Array.from([...signature, ...new TextEncoder().encode(label)])
  return {
    fileName: `image-${seed}.png`,
    bytes: bytes(`image ${seed}`),
    width: 1200,
    height: 800,
    thumbnail: { bytes: Uint8Array.from([...PNG, seed]), width: 480, height: 320 },
  }
}

const shareable = (mime: string) => mime === 'image/png' || mime === 'image/jpeg'

describe('the clipboard marker', () => {
  it('round-trips and refuses anything that is not a current Loam marker', () => {
    const mark = { refs: [{ id: 3, imageHash: 'a'.repeat(64) }], shared: 'a'.repeat(64) }
    expect(parseClipboardMark(encodeClipboardMark(mark))).toEqual(mark)
    expect(parseClipboardMark(null)).toBeNull()
    expect(parseClipboardMark('hello')).toBeNull()
    expect(
      parseClipboardMark(
        '{"loam":2,"refs":[{"id":3,"imageHash":"' + 'a'.repeat(64) + '"}],"shared":null}',
      ),
    ).toBeNull()
    expect(parseClipboardMark('{"loam":1,"refs":[],"shared":null}')).toBeNull()
    expect(
      parseClipboardMark('{"loam":1,"refs":[{"id":-1,"imageHash":"x"}],"shared":null}'),
    ).toBeNull()
  })
})

describe('copy and paste back', () => {
  let dir: string
  let db: SqliteDatabase
  let service: ReferenceService
  let refs: number[]

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'loam-clipboard-'))
    db = openDatabase({ filePath: join(dir, 'loam.db'), migrationsDir }).db
    service = new ReferenceService({
      repository: new SqliteReferenceRepository(db),
      blobs: new FileBlobStore(join(dir, 'files')),
      hasher: sha256Hasher,
      clock: { now: () => new Date('2026-10-16T00:00:00.000Z') },
    })
    const outcomes = await service.importImages(
      [1, 2, 3].map((seed) => upload(seed)),
      null,
    )
    refs = outcomes.map((outcome) => (outcome.status === 'rejected' ? -1 : outcome.id))
  })

  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const library = () =>
    service.listBoard({ boardId: null, inTrash: false, tags: [], text: '' }).totalCount

  it('copies in the order given; other apps get the first; the marker lists all of them', () => {
    const [a, b, c] = refs as [number, number, number]
    const plan = service.prepareCopy([c, a, b, a], shareable)
    expect(plan.ids).toEqual([c, a, b])
    expect(plan.shared?.id).toBe(c)
    expect(plan.shared?.imageMime).toBe('image/png')
    const mark = parseClipboardMark(plan.mark)
    expect(mark?.refs.map((ref) => ref.id)).toEqual([c, a, b])
    expect(mark?.shared).toBe(plan.shared?.imageHash)
    expect(service.copiedReferences(plan.mark, true)).toEqual([c, a, b])
  })

  it('pasting Loam’s copy on a board places the same references, and imports nothing', () => {
    const board = service.createBoard('B').id
    const plan = service.prepareCopy(refs, shareable)
    const before = library()
    const onCanvas = service.pasteCopied(plan.mark, true, board, { x: 0, y: 0 })
    expect(onCanvas.ids).toEqual(refs)
    expect(onCanvas.itemIds).toHaveLength(3)
    expect(service.getCanvas(board).items.map((item) => item.referenceId)).toEqual(refs)
    // In the Library nothing happens: the references are already there.
    expect(service.pasteCopied(plan.mark, true, null, null)).toEqual({ ids: refs, itemIds: [] })
    expect(library()).toBe(before)
  })

  it('falls back to the normal paste when another app copied since', () => {
    const plan = service.prepareCopy(refs, shareable)
    // Another app's copy replaces the whole clipboard: no marker any more.
    expect(service.copiedReferences(null, true)).toEqual([])
    // A marker that named an image, without an image on the clipboard, is not trusted.
    expect(service.copiedReferences(plan.mark, false)).toEqual([])
    expect(service.pasteCopied(null, true, null, null)).toEqual({ ids: [], itemIds: [] })
  })

  it('skips references moved to the Trash or emptied; none left means the normal paste', async () => {
    const [a, b, c] = refs as [number, number, number]
    const plan = service.prepareCopy(refs, shareable)
    service.moveToTrash([b])
    expect(service.copiedReferences(plan.mark, true)).toEqual([a, c])
    service.moveToTrash([a, c])
    await service.emptyTrash()
    expect(service.copiedReferences(plan.mark, true)).toEqual([])
    // A reference in the Trash is not copied either.
    expect(service.prepareCopy([b], shareable)).toMatchObject({ ids: [], shared: null })
  })

  it('a marker from another library never matches: ids must hold the same image', () => {
    const [a] = refs as [number]
    const foreign = encodeClipboardMark({
      refs: [{ id: a, imageHash: 'f'.repeat(64) }],
      shared: null,
    })
    expect(service.copiedReferences(foreign, true)).toEqual([])
  })

  it('an image other apps cannot take is still copied for Loam, with no shared image', async () => {
    const [gif] = await service.importImages([upload(9, GIF)], null)
    const gifId = gif?.status === 'created' ? gif.id : -1
    const plan = service.prepareCopy([gifId], shareable)
    expect(plan).toMatchObject({ ids: [gifId], shared: null })
    expect(service.copiedReferences(plan.mark, false)).toEqual([gifId])
    // With a PNG after it, the PNG is what other apps get.
    const mixed = service.prepareCopy([gifId, refs[0]!], shareable)
    expect(mixed.shared?.id).toBe(refs[0])
  })
})

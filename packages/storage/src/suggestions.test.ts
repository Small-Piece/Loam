import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ReferenceService, SuggestionService, type ImageUpload } from '@loam/core'
import {
  FileBlobStore,
  openDatabase,
  sha256Hasher,
  SqliteReferenceRepository,
  SqliteSettings,
  SqliteSuggestionStore,
} from './index.ts'
import type { Database } from 'better-sqlite3'

const migrationsDir = fileURLToPath(new URL('../../../migrations', import.meta.url))
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const fakePng = (seed: number) =>
  Uint8Array.from([...PNG, ...new TextEncoder().encode(`image ${seed}`)])
const upload = (seed: number): ImageUpload => ({
  fileName: `image-${seed}.png`,
  bytes: fakePng(seed),
  width: 100,
  height: 100,
  thumbnail: { bytes: fakePng(seed + 1000), width: 50, height: 50 },
})

let dir: string
let db: Database
let references: ReferenceService
let store: SqliteSuggestionStore
let suggestions: SuggestionService
let tick = 0

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'loam-suggest-'))
  db = openDatabase({ filePath: join(dir, 'app.db'), migrationsDir }).db
  tick = 0
  references = new ReferenceService({
    repository: new SqliteReferenceRepository(db),
    blobs: new FileBlobStore(join(dir, 'files')),
    hasher: sha256Hasher,
    clock: { now: () => new Date(Date.UTC(2026, 9, 13) + tick++ * 1000) },
  })
  store = new SqliteSuggestionStore(db)
  suggestions = new SuggestionService({ references, suggestions: store })
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

async function importThree(): Promise<number[]> {
  const outcomes = await references.importImages([upload(1), upload(2), upload(3)], null)
  return outcomes.map((outcome) => (outcome.status === 'rejected' ? 0 : outcome.id))
}

const AT = '2026-10-13T10:00:00.000Z'
const tagged = (tag: string) =>
  references.listBoard({ boardId: null, inTrash: false, tags: [tag], text: '' }).items.length
const found = (text: string) =>
  references.listBoard({ boardId: null, inTrash: false, tags: [], text }).items.length

describe('tag suggestions', () => {
  it('queues references newest first, skips the Trash, and counts what was looked at', async () => {
    const [a, b, c] = await importThree()
    expect(store.next()?.refId).toBe(c)
    expect(store.counts()).toEqual({ done: 0, total: 3 })
    store.save(c!, [], 'unsupported', AT)
    expect(store.next()?.refId).toBe(b)
    references.moveToTrash([b!])
    expect(store.next()?.refId).toBe(a)
    expect(store.counts()).toEqual({ done: 1, total: 2 })
  })

  it('keeps suggestions out of tags, search and filters until accepted', async () => {
    const [id] = await importThree()
    store.save(
      id!,
      [
        { tag: 'windmill', confidence: 0.9 },
        { tag: 'sunset', confidence: 0.7 },
      ],
      'suggested',
      AT,
    )
    expect(suggestions.list(id!)).toEqual([
      { tag: 'windmill', confidence: 0.9 },
      { tag: 'sunset', confidence: 0.7 },
    ])
    expect(references.getDetail(id!)?.tags).toEqual([])
    expect(references.tagNames()).not.toContain('windmill')
    expect(tagged('windmill')).toBe(0)
    expect(found('windmill')).toBe(0)

    const detail = suggestions.accept(id!, ['windmill'])
    expect(detail?.tags).toEqual(['windmill'])
    expect(suggestions.list(id!).map((item) => item.tag)).toEqual(['sunset'])
    expect(tagged('windmill')).toBe(1)
  })

  it('accept all; a rejected tag is never suggested again for that image', async () => {
    const [id, other] = await importThree()
    store.save(
      id!,
      [
        { tag: 'ruins', confidence: 0.8 },
        { tag: 'stone', confidence: 0.6 },
      ],
      'suggested',
      AT,
    )
    suggestions.reject(id!, 'ruins')
    expect(suggestions.list(id!).map((item) => item.tag)).toEqual(['stone'])
    expect(store.skipTags(id!)).toEqual(['ruins'])
    // Suggested again later (a re-run): stays rejected.
    store.save(id!, [{ tag: 'ruins', confidence: 0.99 }], 'suggested', AT)
    expect(suggestions.list(id!).map((item) => item.tag)).toEqual(['stone'])
    // Other images are not affected.
    store.save(other!, [{ tag: 'ruins', confidence: 0.5 }], 'suggested', AT)
    expect(suggestions.list(other!).map((item) => item.tag)).toEqual(['ruins'])

    const all = suggestions.list(id!).map((item) => item.tag)
    expect(suggestions.accept(id!, all)?.tags).toEqual(['stone'])
    expect(suggestions.list(id!)).toEqual([])
    // A tag that is not an open suggestion is not added.
    expect(suggestions.accept(id!, ['ruins'])?.tags).toEqual(['stone'])
  })

  it('hides a suggestion the image already has as a tag', async () => {
    const [id] = await importThree()
    references.update(id!, { tags: ['Entrance'] })
    store.save(id!, [{ tag: 'entrance', confidence: 0.9 }], 'suggested', AT)
    expect(suggestions.list(id!)).toEqual([])
    expect(store.skipTags(id!)).toEqual(['entrance'])
  })

  it('stores settings as JSON with defaults', () => {
    const settings = new SqliteSettings(db)
    expect(settings.get('ai.enabled', false)).toBe(false)
    settings.set('ai.pauseApps', ['UnrealEditor.exe'])
    expect(settings.get<string[]>('ai.pauseApps', [])).toEqual(['UnrealEditor.exe'])
  })
})

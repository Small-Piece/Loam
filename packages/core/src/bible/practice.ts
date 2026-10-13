import type { ImageUpload, ImportOutcome } from '../references/types.ts'
import type { BibleService, SaveResult } from './service.ts'

/** The tag every practice image gets in the Library. */
export const PRACTICE_TAG = 'practice'

/** The Library, as far as practice images need it. */
export interface PracticeLibrary {
  importImages(uploads: readonly ImageUpload[], boardId: null): Promise<ImportOutcome[]>
  getDetail(id: number): { tags: string[] } | null
  update(id: number, patch: { tags: string[] }): unknown
}

export interface PracticeImagesResult {
  result: SaveResult
  images: Array<{ alt: string; link: string }>
  library: { ids: number[]; tags: string[]; rejected: number } | null
}

/**
 * Practice images dropped or pasted on a journal entry: stored in the
 * journal's _assets first (the files are the truth), then, when asked,
 * imported into the Library and tagged "practice" plus the entry's topics.
 * Tags already on a Library image are kept.
 */
export async function addPracticeImages(
  journal: BibleService,
  library: PracticeLibrary,
  request: {
    vaultId: number
    path: string
    items: readonly ImageUpload[]
    alsoLibrary: boolean
    baseVersion: string
  },
): Promise<PracticeImagesResult> {
  const stored = await journal.addImages(
    request.vaultId,
    request.path,
    request.items,
    request.baseVersion,
  )
  if (!request.alsoLibrary) return { result: stored.result, images: stored.images, library: null }
  const tags = [PRACTICE_TAG, ...stored.topics]
  const outcomes = await library.importImages(request.items, null)
  const ids: number[] = []
  let rejected = 0
  for (const outcome of outcomes) {
    if (outcome.status === 'rejected') {
      rejected++
      continue
    }
    if (ids.includes(outcome.id)) continue
    ids.push(outcome.id)
    const current = library.getDetail(outcome.id)?.tags ?? []
    library.update(outcome.id, { tags: [...current, ...tags] })
  }
  return { result: stored.result, images: stored.images, library: { ids, tags, rejected } }
}

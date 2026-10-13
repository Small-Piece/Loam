import type { BlobStore, Clock, Hasher, ReferenceRepository } from './ports.ts'
import { applyOps, CanvasEditError, inverseOps, snapshotBoard } from './canvasEdit.ts'
import { layoutNewItems } from './layout.ts'
import { LIMITS, normalizeTags, sniffImageMime, titleFromFileName } from './rules.ts'
import type {
  ApplyResult,
  BoardQuery,
  BoardSummary,
  BoardView,
  BoardViewMode,
  CanvasOp,
  CanvasView,
  EmptyTrashResult,
  ImageUpload,
  ImportOutcome,
  Point,
  ReferenceDetail,
  ReferencePatch,
} from './types.ts'

export interface ReferenceServiceDeps {
  repository: ReferenceRepository
  blobs: BlobStore
  hasher: Hasher
  clock: Clock
}

export class DomainError extends Error {
  override name = 'DomainError'
}

function validDimension(value: number): boolean {
  return Number.isInteger(value) && value > 0 && value <= LIMITS.dimension
}

/** Returns a rejection reason, or null when the upload can be stored. */
function checkUpload(upload: ImageUpload): string | null {
  if (upload.bytes.length === 0) return 'File is empty'
  if (upload.bytes.length > LIMITS.imageBytes) return 'Image is larger than 64 MB'
  if (!validDimension(upload.width) || !validDimension(upload.height)) {
    return 'Image dimensions are invalid'
  }
  const { thumbnail } = upload
  if (thumbnail.bytes.length === 0 || thumbnail.bytes.length > LIMITS.thumbnailBytes) {
    return 'Thumbnail is missing or too large'
  }
  if (sniffImageMime(thumbnail.bytes) === null) return 'Thumbnail is not an image'
  if (!validDimension(thumbnail.width) || !validDimension(thumbnail.height)) {
    return 'Thumbnail dimensions are invalid'
  }
  return null
}

/** Reference Board use cases. Host-agnostic: storage, hashing and time are injected. */
export class ReferenceService {
  private readonly deps: ReferenceServiceDeps
  /** Imports and Trash emptying run one at a time, so a file is never deleted mid-import. */
  private fileWork: Promise<unknown> = Promise.resolve()

  constructor(deps: ReferenceServiceDeps) {
    this.deps = deps
  }

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.fileWork.then(work, work)
    this.fileWork = run.catch(() => undefined)
    return run
  }

  private requireBoard(boardId: number): void {
    if (!this.deps.repository.boardExists(boardId)) {
      throw new DomainError(`Board ${boardId} does not exist`)
    }
  }

  /**
   * Stores each image once, keyed by content hash. Re-importing an image
   * returns the existing reference instead of creating a second one; if that
   * reference is in the Trash, it is restored with its tags and boards.
   * When boardId is given, every imported or matched reference joins that
   * board, placed around `at` (a canvas point) or below the existing items.
   */
  importImages(
    uploads: readonly ImageUpload[],
    boardId: number | null,
    at: Point | null = null,
  ): Promise<ImportOutcome[]> {
    return this.exclusive(() => this.importNow(uploads, boardId, at))
  }

  private async importNow(
    uploads: readonly ImageUpload[],
    boardId: number | null,
    at: Point | null,
  ): Promise<ImportOutcome[]> {
    const { repository, blobs, hasher, clock } = this.deps
    if (uploads.length > LIMITS.imagesPerImport) {
      throw new DomainError(`At most ${LIMITS.imagesPerImport} images per import`)
    }
    if (boardId !== null && !repository.boardExists(boardId)) {
      throw new DomainError(`Board ${boardId} does not exist`)
    }

    const outcomes: ImportOutcome[] = []
    for (const upload of uploads) {
      const fileName = upload.fileName
      const imageMime = sniffImageMime(upload.bytes)
      if (imageMime === null) {
        outcomes.push({ fileName, status: 'rejected', reason: 'Not a supported image format' })
        continue
      }
      const problem = checkUpload(upload)
      if (problem !== null) {
        outcomes.push({ fileName, status: 'rejected', reason: problem })
        continue
      }

      const imageHash = hasher.sha256(upload.bytes)
      const existing = repository.findByImageHash(imageHash)
      if (existing !== null) {
        if (existing.inTrash) repository.restoreFromTrash([existing.id])
        const status = existing.inTrash ? 'restored' : 'duplicate'
        outcomes.push({ fileName, status, id: existing.id })
        continue
      }

      const thumbHash = hasher.sha256(upload.thumbnail.bytes)
      await blobs.put(imageHash, upload.bytes)
      await blobs.put(thumbHash, upload.thumbnail.bytes)
      // A concurrent import may have stored the same image meanwhile; insertOrGet resolves that.
      const stored = repository.insertOrGet({
        imageHash,
        imageMime,
        imageBytes: upload.bytes.length,
        imageWidth: upload.width,
        imageHeight: upload.height,
        thumbHash,
        thumbWidth: upload.thumbnail.width,
        thumbHeight: upload.thumbnail.height,
        title: titleFromFileName(fileName),
        createdAt: clock.now().toISOString(),
      })
      outcomes.push({ fileName, status: stored.created ? 'created' : 'duplicate', id: stored.id })
    }

    if (boardId !== null) {
      const ids = outcomes.flatMap((outcome) => (outcome.status === 'rejected' ? [] : [outcome.id]))
      this.addToBoard(boardId, ids, at)
    }
    return outcomes
  }

  getDetail(id: number): ReferenceDetail | null {
    return this.deps.repository.getDetail(id)
  }

  /** Applies edits and returns the updated detail; null when the reference does not exist. */
  update(id: number, patch: ReferencePatch): ReferenceDetail | null {
    const { repository } = this.deps
    const clean: ReferencePatch = {}
    if (patch.title !== undefined) {
      const title = patch.title.trim().slice(0, LIMITS.titleLength)
      if (title.length === 0) throw new DomainError('Title cannot be empty')
      clean.title = title
    }
    if (patch.note !== undefined) clean.note = patch.note.slice(0, LIMITS.noteLength)
    if (patch.source !== undefined) clean.source = patch.source.trim().slice(0, LIMITS.sourceLength)
    if (patch.tags !== undefined) clean.tags = normalizeTags(patch.tags)
    const before = repository.getDetail(id)
    if (!before) return null
    let boardIds: number[] | null = null
    if (patch.boardIds !== undefined) {
      boardIds = [...new Set(patch.boardIds)]
      for (const boardId of boardIds) this.requireBoard(boardId)
    }
    if (!repository.update(id, clean)) return null
    if (boardIds !== null) {
      // Boards that stay checked keep the item where it is on their canvas.
      for (const boardId of before.boardIds) {
        if (!boardIds.includes(boardId)) this.removeFromBoard(boardId, [id])
      }
      for (const boardId of boardIds) {
        if (!before.boardIds.includes(boardId)) this.addToBoard(boardId, [id], null)
      }
    }
    return repository.getDetail(id)
  }

  listBoard(query: BoardQuery): BoardView {
    if (query.inTrash && query.boardId !== null) {
      throw new DomainError('The Trash is not part of any board')
    }
    if (query.boardId !== null) this.requireBoard(query.boardId)
    return this.deps.repository.listBoard({
      boardId: query.boardId,
      inTrash: query.inTrash,
      tags: normalizeTags(query.tags),
      text: query.text.trim(),
    })
  }

  /** Moves references to the Trash. Tags and boards are kept for a later restore. */
  moveToTrash(ids: readonly number[]): number[] {
    const { repository, clock } = this.deps
    return repository.moveToTrash([...new Set(ids)], clock.now().toISOString())
  }

  restoreFromTrash(ids: readonly number[]): number[] {
    return this.deps.repository.restoreFromTrash([...new Set(ids)])
  }

  /**
   * Permanently deletes everything in the Trash. An image or thumbnail file
   * is removed only when no remaining reference uses the same hash.
   */
  emptyTrash(): Promise<EmptyTrashResult> {
    return this.exclusive(async () => {
      const { repository, blobs } = this.deps
      const { purgedIds, unusedHashes } = repository.purgeTrash()
      let deletedFiles = 0
      for (const hash of unusedHashes) {
        if (await blobs.delete(hash)) deletedFiles += 1
      }
      return { deletedReferences: purgedIds.length, deletedFiles }
    })
  }

  /**
   * Takes references off one board; they stay in the Library and on other
   * boards. Notes attached to them on this board go too. Returns the ids
   * that were on the board and the steps that undo the removal exactly.
   */
  removeFromBoard(
    boardId: number,
    ids: readonly number[],
  ): { removed: number[]; undo: CanvasOp[] } {
    this.requireBoard(boardId)
    const unique = [...new Set(ids)]
    const before = new Set(
      this.deps.repository.listCanvas(boardId, true).map((item) => item.referenceId),
    )
    const { undo } = this.applyCanvas(boardId, [{ op: 'removeItems', referenceIds: unique }])
    return { removed: unique.filter((id) => before.has(id)), undo }
  }

  /**
   * Places references on a board: around `at` when given, otherwise below
   * what is already there. References already on the board stay where they
   * are. Returns the ids that are on the board afterwards.
   */
  addToBoard(boardId: number, ids: readonly number[], at: Point | null): number[] {
    const { repository } = this.deps
    this.requireBoard(boardId)
    const current = repository.listCanvas(boardId, true)
    const placed = new Set(current.map((item) => item.referenceId))
    const wanted = [...new Set(ids)]
    const sizes = repository.imageSizes(wanted.filter((id) => !placed.has(id)))
    const sizeOrder = new Map(wanted.map((id, index) => [id, index]))
    sizes.sort((a, b) => (sizeOrder.get(a.referenceId) ?? 0) - (sizeOrder.get(b.referenceId) ?? 0))
    const rects = current.map((item) => ({
      x: item.x,
      y: item.y,
      width: item.imageWidth * item.scale,
      height: item.imageHeight * item.scale,
    }))
    const nextZ = current.reduce((top, item) => Math.max(top, item.z), 0) + 1
    // New items stack above everything on the board, including groups and notes.
    const topZ = Math.max(
      nextZ - 1,
      ...repository.listGroups(boardId).map((group) => group.z),
      ...repository.listNotes(boardId, true).map((note) => note.z),
    )
    const placements = layoutNewItems(rects, sizes, at, topZ + 1)
    repository.upsertItems(
      boardId,
      placements.map((placement) => ({ ...placement, groupId: null })),
    )
    const known = new Set(sizes.map((size) => size.referenceId))
    return wanted.filter((id) => placed.has(id) || known.has(id))
  }

  /**
   * Everything a board's canvas draws: images, groups and notes. References
   * in the Trash, and notes attached to them, are left out.
   */
  getCanvas(boardId: number): CanvasView {
    const { repository } = this.deps
    const board = repository.getBoard(boardId)
    if (!board) throw new DomainError(`Board ${boardId} does not exist`)
    return {
      board,
      items: repository.listCanvas(boardId, false),
      groups: repository.listGroups(boardId),
      notes: repository.listNotes(boardId, false),
    }
  }

  /**
   * Applies one canvas edit atomically: moves, groups, notes, removals.
   * Returns the new canvas, the steps that undo the edit, and the ids of
   * groups and notes it created.
   */
  applyCanvas(boardId: number, ops: readonly CanvasOp[]): ApplyResult {
    const { repository } = this.deps
    this.requireBoard(boardId)
    try {
      return repository.inTransaction(() => {
        const before = snapshotBoard(repository, boardId)
        const { created } = applyOps(repository, boardId, ops)
        const after = snapshotBoard(repository, boardId)
        return { view: this.getCanvas(boardId), undo: inverseOps(before, after), created }
      })
    } catch (error) {
      if (error instanceof CanvasEditError) throw new DomainError(error.message)
      throw error
    }
  }

  setViewMode(boardId: number, mode: BoardViewMode): BoardViewMode {
    this.requireBoard(boardId)
    this.deps.repository.setViewMode(boardId, mode)
    return mode
  }

  /** Image and thumbnail hashes of references (not in the Trash), for copying into a bible. */
  assetInfo(ids: readonly number[]): Array<{
    id: number
    title: string
    imageHash: string
    imageMime: string
    thumbHash: string
  }> {
    return this.deps.repository.assetInfo(ids)
  }

  /** Every tag in use in the Library, by name; the Bible offers them in its tag field. */
  tagNames(): string[] {
    return this.deps.repository.tagNames()
  }

  /** Creates a board, or returns the existing one with the same name (case-insensitive). */
  createBoard(name: string): BoardSummary {
    const { repository, clock } = this.deps
    const clean = name.trim().replace(/\s+/g, ' ').slice(0, LIMITS.boardNameLength)
    if (clean.length === 0) throw new DomainError('Board name cannot be empty')
    return (
      repository.findBoardByName(clean) ?? repository.createBoard(clean, clock.now().toISOString())
    )
  }
}

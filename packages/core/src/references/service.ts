import type { BlobStore, Clock, Hasher, ReferenceRepository } from './ports.ts'
import { applyOps, CanvasEditError, inverseOps, snapshotBoard } from './canvasEdit.ts'
import { encodeClipboardMark, parseClipboardMark } from './clipboardMark.ts'
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
  TagCount,
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

/** What one copy puts on the clipboard. */
export interface CopyPlan {
  /** The references copied: those asked for that are in the Library, in the order given. */
  ids: number[]
  /** The image other apps receive (the first one that can be shared), or null. */
  shared: { id: number; imageHash: string; imageMime: string } | null
  /** Loam's private marker, written next to the image. */
  mark: string
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
   * With `at`, an image already on the board is placed there once more.
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
   * Takes references off one board, every placement of them there; they stay
   * in the Library and on other boards. Notes attached to those placements go
   * too. Returns the ids that were on the board and the steps that undo the
   * removal exactly.
   */
  removeFromBoard(
    boardId: number,
    ids: readonly number[],
  ): { removed: number[]; undo: CanvasOp[] } {
    this.requireBoard(boardId)
    const unique = new Set(ids)
    const placements = this.deps.repository
      .listCanvas(boardId, true)
      .filter((item) => unique.has(item.referenceId))
    const { undo } = this.applyCanvas(boardId, [
      { op: 'removeItems', itemIds: placements.map((item) => item.id) },
    ])
    const removed = new Set(placements.map((item) => item.referenceId))
    return { removed: [...unique].filter((id) => removed.has(id)), undo }
  }

  /**
   * Places references on a board. Around `at` (a drop point) every one of
   * them gets a new placement, also when it is on the board already, so an
   * image can be placed several times. Without `at` they go below what is
   * there, and references already on the board stay as they are. Returns the
   * reference ids on the board afterwards and the ids of the new placements.
   */
  addToBoard(
    boardId: number,
    ids: readonly number[],
    at: Point | null,
  ): { ids: number[]; itemIds: number[] } {
    const { repository } = this.deps
    this.requireBoard(boardId)
    const current = repository.listCanvas(boardId, true)
    const placed = new Set(current.map((item) => item.referenceId))
    const wanted = [...new Set(ids)]
    const sizes = repository.imageSizes(
      at === null ? wanted.filter((id) => !placed.has(id)) : wanted,
    )
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
    const itemIds = repository.putItems(
      boardId,
      placements.map((placement) => ({ ...placement, groupId: null })),
    )
    const known = new Set(sizes.map((size) => size.referenceId))
    return { ids: wanted.filter((id) => placed.has(id) || known.has(id)), itemIds }
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

  /**
   * Plans a copy of references to the clipboard. References in the Trash or gone
   * are left out. Other apps get the first image whose format `shareable`
   * accepts; Loam's marker lists every copied reference with its image hash.
   */
  prepareCopy(ids: readonly number[], shareable: (mime: string) => boolean): CopyPlan {
    const wanted = [...new Set(ids)]
    const byId = new Map(this.deps.repository.assetInfo(wanted).map((info) => [info.id, info]))
    const copied = wanted.flatMap((id) => {
      const info = byId.get(id)
      return info ? [info] : []
    })
    const first = copied.find((info) => shareable(info.imageMime))
    const shared = first
      ? { id: first.id, imageHash: first.imageHash, imageMime: first.imageMime }
      : null
    const mark = encodeClipboardMark({
      refs: copied.map((info) => ({ id: info.id, imageHash: info.imageHash })),
      shared: shared?.imageHash ?? null,
    })
    return { ids: copied.map((info) => info.id), shared, mark }
  }

  /**
   * The references a paste should reuse, in the order they were copied: those in
   * Loam's marker that are still in the Library with the same image. Empty when
   * the clipboard holds no marker (another app copied since), the marker named an
   * image that is no longer on the clipboard, or no marked reference is left.
   */
  copiedReferences(markText: string | null, clipboardHasImage: boolean): number[] {
    const mark = parseClipboardMark(markText)
    if (mark === null) return []
    if (mark.shared !== null && !clipboardHasImage) return []
    const ids = mark.refs.map((ref) => ref.id)
    const current = new Map(
      this.deps.repository.assetInfo(ids).map((info) => [info.id, info.imageHash]),
    )
    return mark.refs.flatMap((ref) => (current.get(ref.id) === ref.imageHash ? [ref.id] : []))
  }

  /**
   * Pastes Loam's own copy: on a canvas (`at` given) the references get new
   * placements around that point; on a board without a point they join it if
   * they are not on it yet; in the Library nothing is imported. Returns empty
   * ids when the clipboard is not Loam's copy, so the normal paste runs instead.
   */
  pasteCopied(
    markText: string | null,
    clipboardHasImage: boolean,
    boardId: number | null,
    at: Point | null,
  ): { ids: number[]; itemIds: number[] } {
    const ids = this.copiedReferences(markText, clipboardHasImage)
    if (ids.length === 0 || boardId === null) return { ids, itemIds: [] }
    return { ids, itemIds: this.addToBoard(boardId, ids, at).itemIds }
  }

  /** Every tag in use in the Library, by name; the Bible offers them in its tag field. */
  tagNames(): string[] {
    return this.deps.repository.tagNames()
  }

  /**
   * Every tag in the Library with its use count, whatever board is open; references in
   * the Trash do not count. The tag picker offers these.
   */
  libraryTags(): TagCount[] {
    return this.deps.repository.libraryTags()
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

  /** Puts the boards in the sidebar in this order; `ids` must list every board exactly once. */
  reorderBoards(ids: readonly number[]): BoardSummary[] {
    if (new Set(ids).size !== ids.length) throw new DomainError('A board is listed twice')
    try {
      return this.deps.repository.reorderBoards(ids)
    } catch (error) {
      throw new DomainError(error instanceof Error ? error.message : String(error))
    }
  }
}

import { isValidPlacement } from './layout.ts'
import type { ReferenceRepository } from './ports.ts'
import {
  NOTE_SIZES,
  PALETTE,
  type BoardGroup,
  type BoardNote,
  type CanvasOp,
  type GroupInput,
  type GroupLink,
  type ItemState,
  type NoteInput,
} from './types.ts'

export class CanvasEditError extends Error {
  override name = 'CanvasEditError'
}

export const NOTE_LIMITS = { textLength: 10_000, minWidth: 10, maxWidth: 20_000 } as const
const GROUP_TITLE_LENGTH = 100
const COORDINATE_LIMIT = 1e9

/** Everything on one board, including items in the Trash, keyed by id. */
export interface BoardSnapshot {
  items: Map<number, ItemState>
  groups: Map<number, BoardGroup>
  notes: Map<number, BoardNote>
}

export function snapshotBoard(repository: ReferenceRepository, boardId: number): BoardSnapshot {
  const items = new Map<number, ItemState>()
  for (const item of repository.listCanvas(boardId, true)) {
    items.set(item.referenceId, {
      referenceId: item.referenceId,
      x: item.x,
      y: item.y,
      scale: item.scale,
      z: item.z,
      groupId: item.groupId,
    })
  }
  return {
    items,
    groups: new Map(repository.listGroups(boardId).map((group) => [group.id, group])),
    notes: new Map(repository.listNotes(boardId, true).map((note) => [note.id, note])),
  }
}

function isFiniteCoordinate(value: number): boolean {
  return Number.isFinite(value) && Math.abs(value) <= COORDINATE_LIMIT
}

function cleanGroup(input: GroupInput): Omit<BoardGroup, 'id'> {
  if (!PALETTE.includes(input.color)) throw new CanvasEditError(`Unknown colour ${input.color}`)
  if (!Number.isInteger(input.z)) throw new CanvasEditError('Group z must be a whole number')
  const title = input.title.trim().slice(0, GROUP_TITLE_LENGTH)
  return { title: title || 'Group', color: input.color, locked: input.locked, z: input.z }
}

function cleanNote(input: NoteInput): Omit<BoardNote, 'id' | 'groupId'> {
  if (!isFiniteCoordinate(input.x) || !isFiniteCoordinate(input.y)) {
    throw new CanvasEditError('Note position is invalid')
  }
  if (
    input.width !== null &&
    (!Number.isFinite(input.width) ||
      input.width < NOTE_LIMITS.minWidth ||
      input.width > NOTE_LIMITS.maxWidth)
  ) {
    throw new CanvasEditError('Note width is invalid')
  }
  if (!NOTE_SIZES.includes(input.fontSize))
    throw new CanvasEditError(`Unknown size ${input.fontSize}`)
  if (!PALETTE.includes(input.color)) throw new CanvasEditError(`Unknown colour ${input.color}`)
  if (!Number.isInteger(input.z)) throw new CanvasEditError('Note z must be a whole number')
  return {
    text: input.text.slice(0, NOTE_LIMITS.textLength),
    x: input.x,
    y: input.y,
    width: input.width,
    fontSize: input.fontSize,
    color: input.color,
    background: input.background,
    z: input.z,
    attachedReferenceId: input.attachedReferenceId,
  }
}

export interface AppliedEdit {
  created: { groups: Record<string, number>; notes: Record<string, number> }
}

/**
 * Applies the steps of one canvas edit in order. Call inside a transaction:
 * any error leaves the board unchanged.
 */
export function applyOps(
  repository: ReferenceRepository,
  boardId: number,
  ops: readonly CanvasOp[],
): AppliedEdit {
  const created = { groups: {} as Record<string, number>, notes: {} as Record<string, number> }

  function resolveGroup(link: GroupLink): number | null {
    if (link.groupKey !== undefined) {
      const id = created.groups[link.groupKey]
      if (id === undefined) throw new CanvasEditError(`No group was created as "${link.groupKey}"`)
      return id
    }
    if (link.groupId !== null && repository.boardOfGroup(link.groupId) !== boardId) {
      throw new CanvasEditError(`Group ${link.groupId} is not on this board`)
    }
    return link.groupId
  }

  function requireOwn(kind: 'group' | 'note', id: number): void {
    const board = kind === 'group' ? repository.boardOfGroup(id) : repository.boardOfNote(id)
    if (board !== null && board !== boardId)
      throw new CanvasEditError(`That ${kind} belongs to another board`)
  }

  for (const step of ops) {
    switch (step.op) {
      case 'putItems': {
        const ids = step.items.map((item) => item.referenceId)
        if (new Set(ids).size !== ids.length) throw new CanvasEditError('A reference appears twice')
        const known = new Set(repository.imageSizes(ids).map((size) => size.referenceId))
        const states: ItemState[] = step.items.map((item) => {
          if (!known.has(item.referenceId)) {
            throw new CanvasEditError(`Reference ${item.referenceId} does not exist`)
          }
          const state = {
            referenceId: item.referenceId,
            x: item.x,
            y: item.y,
            scale: item.scale,
            z: item.z,
            groupId: resolveGroup(item),
          }
          if (!isValidPlacement(state)) {
            throw new CanvasEditError(`Invalid placement for reference ${item.referenceId}`)
          }
          return state
        })
        repository.upsertItems(boardId, states)
        break
      }
      case 'removeItems':
        repository.removeFromBoard(boardId, step.referenceIds)
        break
      case 'putGroups':
        for (const group of step.groups) {
          if (group.id !== undefined) requireOwn('group', group.id)
          const id = repository.putGroup(boardId, { ...cleanGroup(group), id: group.id })
          if (group.key !== undefined) created.groups[group.key] = id
        }
        break
      case 'deleteGroups':
        for (const id of step.ids) requireOwn('group', id)
        repository.deleteGroups(boardId, step.ids)
        break
      case 'putNotes':
        for (const note of step.notes) {
          if (note.id !== undefined) requireOwn('note', note.id)
          const clean = cleanNote(note)
          // A note attached to an image follows the image, not a group.
          const groupId = clean.attachedReferenceId === null ? resolveGroup(note) : null
          const id = repository.putNote(boardId, { ...clean, groupId, id: note.id })
          if (note.key !== undefined) created.notes[note.key] = id
        }
        break
      case 'deleteNotes':
        for (const id of step.ids) requireOwn('note', id)
        repository.deleteNotes(boardId, step.ids)
        break
    }
  }

  // A note can only be attached to an image that is on this board.
  const placed = new Set(repository.listCanvas(boardId, true).map((item) => item.referenceId))
  for (const note of repository.listNotes(boardId, true)) {
    if (note.attachedReferenceId !== null && !placed.has(note.attachedReferenceId)) {
      throw new CanvasEditError(`Note ${note.id} is attached to an image that is not on this board`)
    }
  }
  // A group disappears when its last child leaves it.
  repository.deleteEmptyGroups(boardId)
  return { created }
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * The steps that turn the board from `after` back into `before`. Groups are
 * restored first so restored items and notes can point at them; created
 * objects are removed last.
 */
export function inverseOps(before: BoardSnapshot, after: BoardSnapshot): CanvasOp[] {
  const restoreGroups = [...before.groups.values()].filter(
    (group) => !sameJson(group, after.groups.get(group.id)),
  )
  const restoreItems = [...before.items.values()].filter(
    (item) => !sameJson(item, after.items.get(item.referenceId)),
  )
  const restoreNotes = [...before.notes.values()].filter(
    (note) => !sameJson(note, after.notes.get(note.id)),
  )
  const addedItems = [...after.items.keys()].filter((id) => !before.items.has(id))
  const addedNotes = [...after.notes.keys()].filter((id) => !before.notes.has(id))
  const addedGroups = [...after.groups.keys()].filter((id) => !before.groups.has(id))

  const undo: CanvasOp[] = []
  if (restoreGroups.length > 0) undo.push({ op: 'putGroups', groups: restoreGroups })
  if (addedNotes.length > 0) undo.push({ op: 'deleteNotes', ids: addedNotes })
  if (addedItems.length > 0) undo.push({ op: 'removeItems', referenceIds: addedItems })
  if (restoreItems.length > 0) undo.push({ op: 'putItems', items: restoreItems })
  if (restoreNotes.length > 0) {
    undo.push({ op: 'putNotes', notes: restoreNotes.map((note) => ({ ...note })) })
  }
  if (addedGroups.length > 0) undo.push({ op: 'deleteGroups', ids: addedGroups })
  return undo
}

/** Where the grid is looking: the whole Library, one board, or the Trash. */
export type Place = { kind: 'library' } | { kind: 'board'; boardId: number } | { kind: 'trash' }

export const LIBRARY: Place = { kind: 'library' }
export const TRASH: Place = { kind: 'trash' }

export function samePlace(a: Place, b: Place): boolean {
  if (a.kind === 'board' && b.kind === 'board') return a.boardId === b.boardId
  return a.kind === b.kind
}

export function boardIdOf(place: Place): number | null {
  return place.kind === 'board' ? place.boardId : null
}

import type { ImageSize, Placement, Point } from './types.ts'

/** New items arrive with their longest side at most this many canvas units. */
export const DEFAULT_LONGEST_SIDE = 600
const GAP = 40
const ROW_LENGTH = 8
export const MIN_SCALE = 0.005
export const MAX_SCALE = 50

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** Scale that brings an image's longest side to DEFAULT_LONGEST_SIDE, never enlarging it. */
export function defaultScale(width: number, height: number): number {
  return Math.min(1, DEFAULT_LONGEST_SIDE / Math.max(width, height))
}

/**
 * Places new items on a board. With an anchor (a drop point or the view
 * center) they form one row centered on it; without one they go in rows of
 * eight below everything already on the board. Each new item is stacked
 * above the existing ones, in the given order.
 */
export function layoutNewItems(
  existing: readonly Rect[],
  sizes: readonly ImageSize[],
  anchor: Point | null,
  nextZ: number,
): Placement[] {
  const drawn = sizes.map((size) => {
    const scale = defaultScale(size.width, size.height)
    return { id: size.referenceId, scale, width: size.width * scale, height: size.height * scale }
  })
  if (drawn.length === 0) return []

  if (anchor) {
    const total = drawn.reduce((sum, item) => sum + item.width, 0) + GAP * (drawn.length - 1)
    const tallest = Math.max(...drawn.map((item) => item.height))
    let x = anchor.x - total / 2
    return drawn.map((item, index) => {
      const placement = {
        referenceId: item.id,
        x,
        y: anchor.y - tallest / 2,
        scale: item.scale,
        z: nextZ + index,
      }
      x += item.width + GAP
      return placement
    })
  }

  const left = existing.length > 0 ? Math.min(...existing.map((rect) => rect.x)) : 0
  let y =
    existing.length > 0 ? Math.max(...existing.map((rect) => rect.y + rect.height)) + GAP * 2 : 0
  const placements: Placement[] = []
  for (let start = 0; start < drawn.length; start += ROW_LENGTH) {
    const row = drawn.slice(start, start + ROW_LENGTH)
    let x = left
    for (const item of row) {
      placements.push({
        referenceId: item.id,
        x,
        y,
        scale: item.scale,
        z: nextZ + placements.length,
      })
      x += item.width + GAP
    }
    y += Math.max(...row.map((item) => item.height)) + GAP
  }
  return placements
}

/** True when every number is finite and the scale is in range. */
export function isValidPlacement(placement: Placement): boolean {
  const { x, y, scale, z } = placement
  return (
    [x, y, scale, z].every(Number.isFinite) &&
    Number.isInteger(z) &&
    scale >= MIN_SCALE &&
    scale <= MAX_SCALE &&
    Math.abs(x) <= 1e9 &&
    Math.abs(y) <= 1e9
  )
}

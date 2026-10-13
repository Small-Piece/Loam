import type { Placement } from '@loam/protocol'

/** The canvas camera: screen = canvas * scale + offset. */
export interface View {
  x: number
  y: number
  scale: number
}

export interface Point {
  x: number
  y: number
}

export interface Box {
  x: number
  y: number
  width: number
  height: number
}

export interface Sized {
  imageWidth: number
  imageHeight: number
}

export const MIN_ZOOM = 0.02
export const MAX_ZOOM = 16
export const MIN_ITEM_SCALE = 0.005
export const MAX_ITEM_SCALE = 50

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** Screen point (relative to the canvas element) to canvas units. */
export function toCanvas(view: View, screen: Point): Point {
  return { x: (screen.x - view.x) / view.scale, y: (screen.y - view.y) / view.scale }
}

/** Zooms to a new scale keeping the screen point under the cursor fixed. */
export function zoomAround(view: View, nextScale: number, screen: Point): View {
  const scale = clamp(nextScale, MIN_ZOOM, MAX_ZOOM)
  const ratio = scale / view.scale
  return {
    scale,
    x: screen.x - (screen.x - view.x) * ratio,
    y: screen.y - (screen.y - view.y) * ratio,
  }
}

export function itemBox(item: Placement & Sized): Box {
  return {
    x: item.x,
    y: item.y,
    width: item.imageWidth * item.scale,
    height: item.imageHeight * item.scale,
  }
}

export function boundsOf(boxes: readonly Box[]): Box | null {
  if (boxes.length === 0) return null
  const left = Math.min(...boxes.map((box) => box.x))
  const top = Math.min(...boxes.map((box) => box.y))
  const right = Math.max(...boxes.map((box) => box.x + box.width))
  const bottom = Math.max(...boxes.map((box) => box.y + box.height))
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/** View that shows every box inside the viewport with a margin; 100 % at most. */
export function fitView(boxes: readonly Box[], viewport: { width: number; height: number }): View {
  const bounds = boundsOf(boxes)
  if (!bounds || viewport.width <= 0 || viewport.height <= 0) {
    return { x: viewport.width / 2, y: viewport.height / 2, scale: 1 }
  }
  const margin = 0.92
  const scale = clamp(
    Math.min(
      (viewport.width * margin) / Math.max(bounds.width, 1),
      (viewport.height * margin) / Math.max(bounds.height, 1),
      1,
    ),
    MIN_ZOOM,
    MAX_ZOOM,
  )
  return {
    scale,
    x: viewport.width / 2 - (bounds.x + bounds.width / 2) * scale,
    y: viewport.height / 2 - (bounds.y + bounds.height / 2) * scale,
  }
}

export function intersects(a: Box, b: Box): boolean {
  return (
    a.x <= b.x + b.width && a.x + a.width >= b.x && a.y <= b.y + b.height && a.y + a.height >= b.y
  )
}

export type Corner = 'nw' | 'ne' | 'sw' | 'se'

/**
 * New placement when a corner handle is dragged to a canvas point: the
 * opposite corner stays put and the image keeps its aspect ratio.
 */
export function scaleFromCorner(
  item: Placement & Sized,
  corner: Corner,
  pointer: Point,
): Placement {
  const box = itemBox(item)
  const anchor = {
    x: corner === 'nw' || corner === 'sw' ? box.x + box.width : box.x,
    y: corner === 'nw' || corner === 'ne' ? box.y + box.height : box.y,
  }
  const reachX = corner === 'nw' || corner === 'sw' ? anchor.x - pointer.x : pointer.x - anchor.x
  const reachY = corner === 'nw' || corner === 'ne' ? anchor.y - pointer.y : pointer.y - anchor.y
  // Follow whichever axis the pointer pulls further, so the corner tracks the cursor.
  const scale = clamp(
    Math.max(reachX / item.imageWidth, reachY / item.imageHeight),
    MIN_ITEM_SCALE,
    MAX_ITEM_SCALE,
  )
  const width = item.imageWidth * scale
  const height = item.imageHeight * scale
  return {
    referenceId: item.referenceId,
    z: item.z,
    scale,
    x: corner === 'nw' || corner === 'sw' ? anchor.x - width : anchor.x,
    y: corner === 'nw' || corner === 'ne' ? anchor.y - height : anchor.y,
  }
}

/** Moves the chosen items above (front) or below (back) all others, keeping their own order. */
export function restack(
  items: readonly Placement[],
  chosen: ReadonlySet<number>,
  direction: 'front' | 'back',
): Placement[] {
  const moving = items.filter((item) => chosen.has(item.referenceId)).sort((a, b) => a.z - b.z)
  const others = items.filter((item) => !chosen.has(item.referenceId))
  if (moving.length === 0) return []
  if (direction === 'front') {
    const top = Math.max(...items.map((item) => item.z))
    return moving.map((item, index) => ({ ...item, z: top + 1 + index }))
  }
  const bottom = others.length > 0 ? Math.min(...others.map((item) => item.z)) : moving[0]!.z
  return moving.map((item, index) => ({ ...item, z: bottom - moving.length + index }))
}

/** Reading order (rows top to bottom, then left to right) for stepping through items in the viewer. */
export function readingOrder<T extends Placement & Sized>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => {
    const rowA = Math.round(a.y / 200)
    const rowB = Math.round(b.y / 200)
    return rowA !== rowB ? rowA - rowB : a.x - b.x
  })
}

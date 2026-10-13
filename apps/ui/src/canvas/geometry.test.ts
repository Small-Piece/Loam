import { describe, expect, it } from 'vitest'
import {
  fitView,
  readingOrder,
  restack,
  scaleFromCorner,
  toCanvas,
  zoomAround,
} from './geometry.ts'

const item = { referenceId: 1, x: 100, y: 200, scale: 0.5, z: 3, imageWidth: 800, imageHeight: 400 }

describe('view math', () => {
  it('converts screen points to canvas units', () => {
    expect(toCanvas({ x: 50, y: 20, scale: 2 }, { x: 250, y: 120 })).toEqual({ x: 100, y: 50 })
  })

  it('zooms around a point, keeping it fixed on screen', () => {
    const before = { x: 50, y: 20, scale: 2 }
    const screen = { x: 300, y: 200 }
    const after = zoomAround(before, 4, screen)
    expect(toCanvas(after, screen)).toEqual(toCanvas(before, screen))
    expect(after.scale).toBe(4)
  })

  it('clamps zoom', () => {
    expect(zoomAround({ x: 0, y: 0, scale: 1 }, 1000, { x: 0, y: 0 }).scale).toBe(16)
  })

  it('fits all boxes, centered, never above 100 %', () => {
    const view = fitView([{ x: 0, y: 0, width: 2000, height: 1000 }], { width: 1000, height: 1000 })
    expect(view.scale).toBeCloseTo(0.46)
    expect(view.x + 1000 * view.scale).toBeCloseTo(500) // center x lands mid-screen
    const small = fitView([{ x: 0, y: 0, width: 10, height: 10 }], { width: 1000, height: 1000 })
    expect(small.scale).toBe(1)
  })
})

describe('scaleFromCorner', () => {
  it('se handle: top-left stays put, ratio kept', () => {
    // Box is 400 x 200 at (100, 200). Drag the corner to (900, 400): x-reach 800 wins.
    expect(scaleFromCorner(item, 'se', { x: 900, y: 400 })).toEqual({
      referenceId: 1,
      z: 3,
      scale: 1,
      x: 100,
      y: 200,
    })
  })

  it('nw handle: bottom-right stays put', () => {
    const next = scaleFromCorner(item, 'nw', { x: 300, y: 300 })
    // Anchor (500, 400); reach 200 x 100 -> scale 0.25 -> 200 x 100 box.
    expect(next).toMatchObject({ scale: 0.25, x: 300, y: 300 })
  })

  it('never collapses or flips past the anchor', () => {
    expect(scaleFromCorner(item, 'se', { x: -5000, y: -5000 }).scale).toBe(0.005)
  })
})

describe('restack', () => {
  const items = [
    { referenceId: 1, x: 0, y: 0, scale: 1, z: 1 },
    { referenceId: 2, x: 0, y: 0, scale: 1, z: 2 },
    { referenceId: 3, x: 0, y: 0, scale: 1, z: 3 },
  ]

  it('brings the chosen items to the front in their own order', () => {
    expect(restack(items, new Set([1, 2]), 'front').map((i) => [i.referenceId, i.z])).toEqual([
      [1, 4],
      [2, 5],
    ])
  })

  it('sends the chosen items to the back', () => {
    expect(restack(items, new Set([3]), 'back').map((i) => [i.referenceId, i.z])).toEqual([[3, 0]])
  })
})

describe('readingOrder', () => {
  it('orders by row, then left to right', () => {
    const at = (referenceId: number, x: number, y: number) => ({
      ...item,
      referenceId,
      x,
      y,
    })
    const order = readingOrder([at(1, 500, 10), at(2, 0, 700), at(3, 0, 0)])
    expect(order.map((i) => i.referenceId)).toEqual([3, 1, 2])
  })
})

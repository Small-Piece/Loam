import { describe, expect, it } from 'vitest'
import { defaultScale, isValidPlacement, layoutNewItems } from './layout.ts'

describe('defaultScale', () => {
  it('brings the longest side to 600 units and never enlarges', () => {
    expect(defaultScale(6000, 4000)).toBeCloseTo(0.1)
    expect(defaultScale(1000, 3000)).toBeCloseTo(0.2)
    expect(defaultScale(300, 200)).toBe(1)
  })
})

describe('layoutNewItems', () => {
  const sizes = [
    { referenceId: 1, width: 600, height: 400 },
    { referenceId: 2, width: 300, height: 600 },
  ]

  it('centers a row on the anchor and stacks new items above existing ones', () => {
    const placements = layoutNewItems([], sizes, { x: 1000, y: 500 }, 7)
    // Row width: 600 + 40 + 300 = 940, tallest 600.
    expect(placements).toEqual([
      { referenceId: 1, x: 530, y: 200, scale: 1, z: 7 },
      { referenceId: 2, x: 1170, y: 200, scale: 1, z: 8 },
    ])
  })

  it('without an anchor, starts at the origin on an empty board', () => {
    const [first] = layoutNewItems([], sizes, null, 1)
    expect(first).toMatchObject({ x: 0, y: 0 })
  })

  it('without an anchor, goes below existing content, aligned to its left edge', () => {
    const existing = [
      { x: -200, y: 0, width: 100, height: 100 },
      { x: 50, y: 300, width: 100, height: 250 },
    ]
    const [first, second] = layoutNewItems(existing, sizes, null, 3)
    expect(first).toMatchObject({ x: -200, y: 630 })
    expect(second).toMatchObject({ x: 440, y: 630 })
  })

  it('wraps into rows of eight', () => {
    const many = Array.from({ length: 10 }, (_, index) => ({
      referenceId: index + 1,
      width: 100,
      height: 100,
    }))
    const placements = layoutNewItems([], many, null, 1)
    expect(placements[7]).toMatchObject({ x: 7 * 140, y: 0 })
    expect(placements[8]).toMatchObject({ x: 0, y: 140 })
    expect(placements.map((placement) => placement.z)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  })
})

describe('isValidPlacement', () => {
  const ok = { referenceId: 1, x: 10, y: -20, scale: 0.5, z: 3 }
  it('accepts finite numbers and an in-range scale', () => {
    expect(isValidPlacement(ok)).toBe(true)
  })
  it('rejects NaN, infinity, a non-integer z and scales out of range', () => {
    expect(isValidPlacement({ ...ok, x: Number.NaN })).toBe(false)
    expect(isValidPlacement({ ...ok, y: Number.POSITIVE_INFINITY })).toBe(false)
    expect(isValidPlacement({ ...ok, z: 1.5 })).toBe(false)
    expect(isValidPlacement({ ...ok, scale: 0 })).toBe(false)
    expect(isValidPlacement({ ...ok, scale: 51 })).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'
import { moveBoardBefore, moveBoardStep } from './boardOrder.ts'

describe('moving a board', () => {
  const ids = [1, 2, 3, 4]

  it('drops a board in front of another, or at the end', () => {
    expect(moveBoardBefore(ids, 4, 2)).toEqual([1, 4, 2, 3])
    expect(moveBoardBefore(ids, 1, 4)).toEqual([2, 3, 1, 4])
    expect(moveBoardBefore(ids, 2, null)).toEqual([1, 3, 4, 2])
  })

  it('reports no change when the board stays where it is', () => {
    expect(moveBoardBefore(ids, 2, 2)).toBeNull()
    expect(moveBoardBefore(ids, 2, 3)).toBeNull()
    expect(moveBoardBefore(ids, 4, null)).toBeNull()
    expect(moveBoardBefore(ids, 9, 1)).toBeNull()
    expect(moveBoardBefore(ids, 1, 9)).toBeNull()
  })

  it('moves one step up or down, and not past the ends', () => {
    expect(moveBoardStep(ids, 3, -1)).toEqual([1, 3, 2, 4])
    expect(moveBoardStep(ids, 3, 1)).toEqual([1, 2, 4, 3])
    expect(moveBoardStep(ids, 1, -1)).toBeNull()
    expect(moveBoardStep(ids, 4, 1)).toBeNull()
  })
})

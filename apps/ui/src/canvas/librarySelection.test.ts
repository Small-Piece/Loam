import { describe, expect, it } from 'vitest'
import { clickSelection, draggedIds } from './librarySelection.ts'

const order = [10, 20, 30, 40, 50]
const none = new Set<number>()
const plain = { toggle: false, range: false }
const ctrl = { toggle: true, range: false }
const shift = { toggle: false, range: true }

describe('Library panel selection', () => {
  it('a plain click selects only that tile and makes it the anchor', () => {
    expect(clickSelection(order, new Set([10, 20]), 10, 30, plain)).toEqual({
      selected: new Set([30]),
      anchor: 30,
    })
  })

  it('Ctrl+click adds or removes a tile', () => {
    const added = clickSelection(order, new Set([10]), 10, 40, ctrl)
    expect([...added.selected].sort()).toEqual([10, 40])
    expect(added.anchor).toBe(40)
    expect([...clickSelection(order, added.selected, 40, 10, ctrl).selected]).toEqual([40])
  })

  it('Shift+click selects the range from the anchor in display order, either way', () => {
    expect([...clickSelection(order, new Set([20]), 20, 40, shift).selected]).toEqual([20, 30, 40])
    const back = clickSelection(order, new Set([40]), 40, 10, shift)
    expect([...back.selected].sort()).toEqual([10, 20, 30, 40])
    expect(back.anchor).toBe(40)
    // Ctrl+Shift adds the range to what is selected.
    const both = clickSelection(order, new Set([50]), 10, 20, { toggle: true, range: true })
    expect([...both.selected].sort()).toEqual([10, 20, 50])
  })

  it('Shift+click without an anchor on screen just adds the tile', () => {
    expect(clickSelection(order, none, null, 30, shift)).toEqual({
      selected: new Set([30]),
      anchor: 30,
    })
    expect([...clickSelection(order, new Set([20]), 99, 30, shift).selected].sort()).toEqual([
      20, 30,
    ])
  })

  it('a drag carries every selected tile in display order, or only an unselected dragged tile', () => {
    expect(draggedIds(order, new Set([50, 10, 30]), 30)).toEqual([10, 30, 50])
    expect(draggedIds(order, new Set([50, 10]), 20)).toEqual([20])
    expect(draggedIds(order, none, 40)).toEqual([40])
  })
})

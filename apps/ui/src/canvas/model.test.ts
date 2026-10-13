import { describe, expect, it } from 'vitest'
import type { BoardGroup, BoardNote, CanvasItem } from '@loam/protocol'
import {
  attachOffset,
  attachTarget,
  drawOrder,
  GROUP_HEADER,
  GROUP_PADDING,
  groupAtPoint,
  groupBounds,
  notePosition,
  restackObjects,
  zAfterUngroup,
  type CanvasState,
} from './model.ts'

function item(
  referenceId: number,
  x: number,
  y: number,
  z: number,
  groupId: number | null = null,
): CanvasItem {
  return {
    referenceId,
    x,
    y,
    scale: 0.5,
    z,
    groupId,
    title: `ref-${referenceId}`,
    thumbHash: 'a'.repeat(64),
    thumbWidth: 480,
    thumbHeight: 320,
    imageHash: 'b'.repeat(64),
    imageWidth: 400, // drawn 200 x 100 at scale 0.5
    imageHeight: 200,
    rotation: 0,
    flipX: false,
    flipY: false,
  }
}

function note(id: number, overrides: Partial<BoardNote> = {}): BoardNote {
  return {
    id,
    text: 'note',
    x: 0,
    y: 0,
    width: 100,
    fontSize: 'M',
    color: 'paper',
    background: true,
    z: 1,
    attachedReferenceId: null,
    groupId: null,
    ...overrides,
  }
}

const group = (id: number, z: number, locked = true): BoardGroup => ({
  id,
  title: 'Group',
  color: 'slate',
  locked,
  z,
})
const sizes = new Map([[1, { width: 100, height: 40 }]])

describe('group bounds', () => {
  it('fits all children with padding and a title band', () => {
    const state: CanvasState = {
      groups: [group(9, 5)],
      items: [item(1, 0, 0, 1, 9), item(2, 300, 100, 2, 9), item(3, 5000, 5000, 3)],
      notes: [],
    }
    // Children span x 0..500, y 0..200.
    expect(groupBounds(9, state, sizes)).toEqual({
      x: -GROUP_PADDING,
      y: -GROUP_PADDING - GROUP_HEADER,
      width: 500 + GROUP_PADDING * 2,
      height: 200 + GROUP_PADDING * 2 + GROUP_HEADER,
    })
  })

  it('follows children as they move and includes notes, attached ones too', () => {
    const state: CanvasState = {
      groups: [group(9, 5)],
      items: [item(1, 100, 100, 1, 9)],
      notes: [note(1, { attachedReferenceId: 1, x: 400, y: 0 })], // at 100 + 400*0.5 = 300, width 100
    }
    const box = groupBounds(9, state, sizes)
    expect(box?.x).toBe(100 - GROUP_PADDING)
    expect(box?.width).toBe(300 + GROUP_PADDING * 2) // 100..400
    const moved = { ...state, items: [item(1, 1100, 100, 1, 9)] }
    expect(groupBounds(9, moved, sizes)?.x).toBe(1100 - GROUP_PADDING)
  })

  it('has no box without visible children', () => {
    expect(groupBounds(9, { groups: [group(9, 1)], items: [], notes: [] }, sizes)).toBeNull()
  })
})

describe('attached notes', () => {
  it('sit at their offset from the image, scaled with it', () => {
    const image = item(1, 100, 50, 1)
    const attached = note(1, { attachedReferenceId: 1, x: 40, y: -20 })
    expect(notePosition(attached, new Map([[1, image]]))).toEqual({ x: 120, y: 40 })
    const bigger = { ...image, scale: 1 }
    expect(notePosition(attached, new Map([[1, bigger]]))).toEqual({ x: 140, y: 30 })
  })

  it('attachOffset is the inverse of notePosition', () => {
    const image = item(1, 100, 50, 1)
    const offset = attachOffset({ x: 333, y: 77 }, image)
    expect(
      notePosition(note(1, { attachedReferenceId: 1, ...offset }), new Map([[1, image]])),
    ).toEqual({
      x: 333,
      y: 77,
    })
  })

  it('attach target is the topmost image under the note center', () => {
    const state: CanvasState = {
      groups: [],
      items: [item(1, 0, 0, 1), item(2, 50, 0, 2)],
      notes: [],
    }
    expect(attachTarget({ x: 90, y: 30, width: 20, height: 20 }, state)?.referenceId).toBe(2)
    expect(attachTarget({ x: 1000, y: 1000, width: 10, height: 10 }, state)).toBeNull()
  })
})

describe('draw order', () => {
  it('draws a group behind its children, children by their own z, attached notes on their image', () => {
    const state: CanvasState = {
      groups: [group(9, 5)],
      items: [item(1, 0, 0, 7), item(2, 0, 0, 2, 9), item(3, 0, 0, 1, 9)],
      notes: [note(4, { attachedReferenceId: 3, z: 0 }), note(5, { z: 6 })],
    }
    expect(drawOrder(state)).toEqual(['g:9', 'i:3', 'n:4', 'i:2', 'n:5', 'i:1'])
  })
})

describe('restack and ungroup', () => {
  const state: CanvasState = {
    groups: [group(9, 2)],
    items: [item(1, 0, 0, 1), item(2, 0, 0, 1, 9), item(3, 0, 0, 2, 9), item(4, 0, 0, 3)],
    notes: [],
  }

  it('a child is brought to the front of its own group, not of the board', () => {
    expect([...restackObjects(['i:2'], state, 'front')]).toEqual([['i:2', 3]])
    expect([...restackObjects(['g:9'], state, 'front')]).toEqual([['g:9', 4]])
    expect([...restackObjects(['i:4'], state, 'back')]).toEqual([['i:4', -1]])
  })

  it('ungroup puts the children where the group was in the stack', () => {
    // Top level before: i:1 (1), g:9 (2) [i:2, i:3], i:4 (3)
    expect(Object.fromEntries(zAfterUngroup([9], state))).toEqual({ 'i:2': 2, 'i:3': 3, 'i:4': 4 })
  })
})

describe('dropping onto a group', () => {
  it('finds the group under a point, measured without the dragged objects', () => {
    const state: CanvasState = {
      groups: [group(9, 5)],
      items: [item(1, 0, 0, 1, 9), item(2, 1000, 0, 2, 9)],
      notes: [],
    }
    expect(groupAtPoint({ x: 500, y: 50 }, state, sizes, new Set())).toBe(9)
    // Without item 2 the frame shrinks to item 1, so the same point is outside.
    expect(groupAtPoint({ x: 500, y: 50 }, state, sizes, new Set(['i:2']))).toBeNull()
  })
})

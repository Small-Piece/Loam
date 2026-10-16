import { describe, expect, it } from 'vitest'
import { chooseAnchor, chooseDisplay, placeOn, type DisplayInfo } from './windowPlacement.ts'

const primary: DisplayInfo = { id: 1, workArea: { x: 0, y: 0, width: 2560, height: 1400 } }
const left: DisplayInfo = { id: 2, workArea: { x: -1920, y: 100, width: 1920, height: 1040 } }
const small: DisplayInfo = { id: 3, workArea: { x: 2560, y: 0, width: 1024, height: 700 } }

describe('chooseDisplay', () => {
  it('returns null when the setting is unset or empty, keeping default behavior', () => {
    expect(chooseDisplay(undefined, [primary, left], 1)).toBeNull()
    expect(chooseDisplay('  ', [primary, left], 1)).toBeNull()
  })

  it('"secondary" picks the first display that is not the primary', () => {
    expect(chooseDisplay('secondary', [primary, left, small], 1)).toBe(left)
    expect(chooseDisplay('secondary', [left, primary], 1)).toBe(left)
  })

  it('"secondary" falls back to null with a single monitor', () => {
    expect(chooseDisplay('secondary', [primary], 1)).toBeNull()
  })

  it('a number is an index into the display list', () => {
    expect(chooseDisplay('0', [primary, left], 1)).toBe(primary)
    expect(chooseDisplay('1', [primary, left], 1)).toBe(left)
    expect(chooseDisplay('5', [primary, left], 1)).toBeNull()
  })

  it('ignores anything else', () => {
    expect(chooseDisplay('-1', [primary, left], 1)).toBeNull()
    expect(chooseDisplay('left', [primary, left], 1)).toBeNull()
    expect(chooseDisplay('1.5', [primary, left], 1)).toBeNull()
  })
})

describe('placeOn', () => {
  it('centers the window in the display work area and shows it inactive', () => {
    expect(placeOn(left, { width: 1280, height: 820 })).toEqual({
      bounds: { x: -1600, y: 210, width: 1280, height: 820 },
      inactive: true,
    })
  })

  it('shrinks the window to fit a small display', () => {
    expect(placeOn(small, { width: 1280, height: 820 }).bounds).toEqual({
      x: 2560,
      y: 0,
      width: 1024,
      height: 700,
    })
  })
})

describe('chooseAnchor', () => {
  it('"bottom" anchors to the bottom; unset or anything else keeps the center', () => {
    expect(chooseAnchor('bottom')).toBe('bottom')
    expect(chooseAnchor(' bottom ')).toBe('bottom')
    expect(chooseAnchor(undefined)).toBe('center')
    expect(chooseAnchor('')).toBe('center')
    expect(chooseAnchor('center')).toBe('center')
    expect(chooseAnchor('top')).toBe('center')
  })
})

describe('placeOn with the bottom anchor', () => {
  const size = { width: 1280, height: 820 }

  it('puts the bottom edge on the work area bottom, centered horizontally', () => {
    const { bounds, inactive } = placeOn(primary, size, 'bottom')
    expect(bounds).toEqual({ x: 640, y: 580, width: 1280, height: 820 })
    expect(bounds.y + bounds.height).toBe(primary.workArea.y + primary.workArea.height)
    expect(bounds.x - primary.workArea.x).toBe(
      primary.workArea.x + primary.workArea.width - (bounds.x + bounds.width),
    )
    expect(inactive).toBe(true)
  })

  it('keeps the size it would have centered', () => {
    const centered = placeOn(left, size)
    const bottom = placeOn(left, size, 'bottom')
    expect(bottom.bounds.width).toBe(centered.bounds.width)
    expect(bottom.bounds.height).toBe(centered.bounds.height)
    expect(bottom.bounds.x).toBe(centered.bounds.x)
  })

  it('works on a display with a negative or offset origin', () => {
    // left: x -1920, y 100, 1920 x 1040, so its work area ends at y 1140.
    expect(placeOn(left, size, 'bottom').bounds).toEqual({
      x: -1600,
      y: 320,
      width: 1280,
      height: 820,
    })
    const above: DisplayInfo = { id: 4, workArea: { x: 300, y: -1080, width: 1920, height: 1032 } }
    const bounds = placeOn(above, size, 'bottom').bounds
    expect(bounds).toEqual({ x: 620, y: -868, width: 1280, height: 820 })
    expect(bounds.y + bounds.height).toBe(-48)
  })

  it('shrinks the window to fit a small display', () => {
    expect(placeOn(small, size, 'bottom').bounds).toEqual({
      x: 2560,
      y: 0,
      width: 1024,
      height: 700,
    })
    const short: DisplayInfo = { id: 5, workArea: { x: 0, y: 40, width: 1600, height: 760 } }
    expect(placeOn(short, size, 'bottom').bounds).toEqual({
      x: 160,
      y: 40,
      width: 1280,
      height: 760,
    })
  })
})

import { describe, expect, it } from 'vitest'
import { chooseDisplay, placeOn, type DisplayInfo } from './windowPlacement.ts'

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

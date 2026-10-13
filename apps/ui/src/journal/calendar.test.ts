import { describe, expect, it } from 'vitest'
import { linkPickerDefault } from '../bible/pickerDefault.ts'
import { dayName, monthGrid, shade, shiftMonth } from './calendar.ts'

describe('journal calendar helpers', () => {
  it('lays a month out in Monday-first weeks', () => {
    // October 2026 starts on a Thursday and has 31 days.
    const weeks = monthGrid(2026, 9)
    expect(weeks[0]).toEqual([
      null,
      null,
      null,
      '2026-10-01',
      '2026-10-02',
      '2026-10-03',
      '2026-10-04',
    ])
    expect(weeks.every((week) => week.length === 7)).toBe(true)
    expect(weeks.flat().filter((day) => day !== null)).toHaveLength(31)
    expect(weeks.at(-1)?.at(-1)).toBe(null)
  })

  it('shades by the number of sessions, not by time', () => {
    expect([0, 1, 2, 3, 9].map(shade)).toEqual([0, 1, 2, 3, 3])
  })

  it('names days and moves across year ends', () => {
    expect(dayName('2026-10-13')).toBe('Tuesday 13 October 2026')
    expect(shiftMonth(2026, 11, 1)).toEqual({ year: 2027, month: 0 })
    expect(shiftMonth(2026, 0, -1)).toEqual({ year: 2025, month: 11 })
  })
})

describe('link picker default', () => {
  const sections = [
    { id: 'world', entries: [{ title: 'Floor 5' }] },
    { id: 'creatures', entries: [{ title: 'Pale hunter' }] },
  ]

  it('prefers the section last chosen for links from the same section', () => {
    expect(linkPickerDefault('Floor 6', 'creatures', sections, { creatures: 'creatures' })).toBe(
      'creatures',
    )
  })

  it('falls back to similar titles, then to the section the link is in', () => {
    expect(linkPickerDefault('Floor 6', 'creatures', sections, {})).toBe('world')
    expect(linkPickerDefault('Zorblat', 'creatures', sections, { world: 'creatures' })).toBe(
      'creatures',
    )
    // A remembered section that was removed since is ignored.
    expect(linkPickerDefault('Zorblat', 'creatures', sections, { creatures: 'gone' })).toBe(
      'creatures',
    )
  })
})

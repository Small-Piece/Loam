import { describe, expect, it } from 'vitest'
import {
  calendarDays,
  isDay,
  journalDefaults,
  localDate,
  nextTimeSection,
  recapText,
  sectionText,
  sessionDay,
  sessionTitle,
  todayAndPrevious,
  type DatedSession,
} from './journal.ts'

const session = (
  path: string,
  date: string | null,
  created = '2026-10-01T00:00:00.000Z',
): DatedSession => ({ path, title: path, date, created })

describe('journal dates', () => {
  it('uses the local calendar day, not the UTC one', () => {
    // 23:30 local time stays on the 13th wherever the test runs.
    expect(localDate(new Date(2026, 9, 13, 23, 30))).toBe('2026-10-13')
    expect(localDate(new Date(2026, 0, 2, 0, 5))).toBe('2026-01-02')
  })

  it('accepts only real days', () => {
    expect(isDay('2026-10-13')).toBe(true)
    expect(isDay('2026-02-30')).toBe(false)
    expect(isDay('2026-10-13 Lighting')).toBe(false)
  })

  it('finds a session day in the date field, then the title, then the creation time', () => {
    expect(sessionDay({ date: '2026-10-11' }, '2026-10-13 Lighting', null)).toBe('2026-10-11')
    expect(sessionDay({ date: '' }, '2026-10-13 Lighting', null)).toBe('2026-10-13')
    expect(sessionDay({}, 'Hands', new Date(2026, 9, 9, 12).toISOString())).toBe('2026-10-09')
    expect(sessionDay({ date: 'soon' }, 'Hands', null)).toBeNull()
  })

  it('starts sessions dated today, topics active, resources to watch', () => {
    expect(journalDefaults('sessions', '2026-10-13')).toEqual({ date: '2026-10-13' })
    expect(journalDefaults('topics', '2026-10-13')).toEqual({
      status: 'active',
      started: '2026-10-13',
    })
    expect(journalDefaults('resources', '2026-10-13')).toEqual({ status: 'to watch' })
    expect(journalDefaults('world', '2026-10-13')).toEqual({})
  })

  it('titles a new session with the date, numbered when the date is taken', () => {
    const taken = new Set(['2026-10-13', '2026-10-13 2'])
    expect(sessionTitle('2026-10-12', (title) => taken.has(title))).toBe('2026-10-12')
    expect(sessionTitle('2026-10-13', (title) => taken.has(title))).toBe('2026-10-13 3')
  })
})

describe('today and the previous session', () => {
  it("lists today's sessions oldest first and picks the latest earlier session", () => {
    const sessions = [
      session('a', '2026-10-10'),
      session('b', '2026-10-12', '2026-10-12T08:00:00.000Z'),
      session('c', '2026-10-12', '2026-10-12T15:00:00.000Z'),
      session('d', '2026-10-13', '2026-10-13T10:00:00.000Z'),
      session('e', '2026-10-13', '2026-10-13T09:00:00.000Z'),
      session('f', null),
    ]
    const found = todayAndPrevious(sessions, '2026-10-13')
    expect(found.today.map((item) => item.path)).toEqual(['e', 'd'])
    expect(found.previous?.path).toBe('c')
  })

  it('has no previous session before the first one', () => {
    expect(todayAndPrevious([session('a', '2026-10-13')], '2026-10-13').previous).toBeNull()
    expect(todayAndPrevious([], '2026-10-13')).toEqual({ today: [], previous: null })
  })
})

describe('the "Next time" section', () => {
  it('takes the text up to the next heading of the same or a higher level', () => {
    const body = [
      '## What I practised',
      'Hands.',
      '## Next time',
      '',
      'Draw feet.',
      '### Detail',
      'Toes too.',
      '## Notes',
      'Not this.',
    ].join('\n')
    expect(nextTimeSection(body)).toBe('Draw feet.\n### Detail\nToes too.')
  })

  it('is null when the heading is missing or empty, and ignores headings in code', () => {
    expect(nextTimeSection('## What I learned\nA lot.\n')).toBeNull()
    expect(nextTimeSection('## Next time\n\n## Other\n')).toBeNull()
    expect(nextTimeSection('```\n## Next time\n```\nNo.\n')).toBeNull()
    expect(nextTimeSection('# next time\r\nLight a sphere.\r\n')).toBe('Light a sphere.')
  })
})

describe('calendar', () => {
  it('counts sessions per day for one year, in order', () => {
    const sessions = [
      session('late', '2026-10-13', '2026-10-13T18:00:00.000Z'),
      session('early', '2026-10-13', '2026-10-13T07:00:00.000Z'),
      session('jan', '2026-01-02'),
      session('last-year', '2025-12-31'),
      session('undated', null),
    ]
    expect(calendarDays(sessions, 2026)).toEqual([
      { date: '2026-01-02', sessions: [{ path: 'jan', title: 'jan' }] },
      {
        date: '2026-10-13',
        sessions: [
          { path: 'early', title: 'early' },
          { path: 'late', title: 'late' },
        ],
      },
    ])
    expect(calendarDays(sessions, 2025).map((day) => day.date)).toEqual(['2025-12-31'])
  })
})

describe('recap text', () => {
  it("takes only the Session template's headings, each under its heading", () => {
    const body = [
      'A stray line before any heading.',
      '## What I practised',
      'Hands.',
      '## Private notes',
      'Not for a recap.',
      '## What was hard',
      'The thumb.',
      '## Next time',
      '',
    ].join('\n')
    expect(recapText(body)).toBe('### What I practised\nHands.\n\n### What was hard\nThe thumb.')
    expect(recapText('## Next time\n\n')).toBeNull()
    expect(sectionText('# what i LEARNED\nRim light.\n', 'What I learned')).toBe('Rim light.')
  })
})

/** Calendar helpers for the journal: month grids, shading and day names. */

export const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const

export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const
const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** YYYY-MM-DD for a year, a month (0-11) and a day of the month. */
export function dayKey(year: number, month: number, day: number): string {
  return `${year}-${pad(month + 1)}-${pad(day)}`
}

/**
 * A month as weeks of seven cells, Monday first; cells outside the month are
 * null. Every week is complete, so the grid lines up.
 */
export function monthGrid(year: number, month: number): Array<Array<string | null>> {
  const first = new Date(year, month, 1)
  const days = new Date(year, month + 1, 0).getDate()
  // getDay: 0 is Sunday; Monday-first means Sunday is the 7th column.
  const lead = (first.getDay() + 6) % 7
  const cells: Array<string | null> = Array.from({ length: lead }, () => null)
  for (let day = 1; day <= days; day++) cells.push(dayKey(year, month, day))
  while (cells.length % 7 !== 0) cells.push(null)
  const weeks: Array<Array<string | null>> = []
  for (let at = 0; at < cells.length; at += 7) weeks.push(cells.slice(at, at + 7))
  return weeks
}

/** How dark a day is drawn: by the number of sessions, 0 to 3 (three or more). */
export function shade(sessions: number): 0 | 1 | 2 | 3 {
  if (sessions <= 0) return 0
  if (sessions === 1) return 1
  if (sessions === 2) return 2
  return 3
}

/** "Tuesday 13 October 2026" for a YYYY-MM-DD day. */
export function dayName(day: string): string {
  const [year, month, date] = day.split('-').map(Number)
  if (!year || !month || !date) return day
  const at = new Date(year, month - 1, date)
  return `${WEEKDAY_NAMES[at.getDay()]} ${date} ${MONTHS[month - 1]} ${year}`
}

/** The month before or after, across year ends. */
export function shiftMonth(
  year: number,
  month: number,
  by: number,
): { year: number; month: number } {
  const at = new Date(year, month + by, 1)
  return { year: at.getFullYear(), month: at.getMonth() }
}

/**
 * The new board order after moving one board in front of another (`before`), or to
 * the end when `before` is null. Returns null when the order does not change.
 */
export function moveBoardBefore(
  ids: readonly number[],
  moved: number,
  before: number | null,
): number[] | null {
  if (!ids.includes(moved) || moved === before) return null
  const rest = ids.filter((id) => id !== moved)
  const at = before === null ? rest.length : rest.indexOf(before)
  if (at === -1) return null
  const next = [...rest.slice(0, at), moved, ...rest.slice(at)]
  return next.every((id, index) => id === ids[index]) ? null : next
}

/** The new board order after moving one board a step up (-1) or down (+1); null at the ends. */
export function moveBoardStep(
  ids: readonly number[],
  moved: number,
  step: -1 | 1,
): number[] | null {
  const at = ids.indexOf(moved)
  const to = at + step
  if (at === -1 || to < 0 || to >= ids.length) return null
  const next = [...ids]
  next.splice(at, 1)
  next.splice(to, 0, moved)
  return next
}

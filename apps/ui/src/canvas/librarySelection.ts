/** How a click changes the Library panel selection. */
export interface ClickKeys {
  /** Ctrl (or Cmd): add or remove the tile. */
  toggle: boolean
  /** Shift: select the range from the anchor to the tile. */
  range: boolean
}

/**
 * The selection after a click on tile `id`, given the tiles in display order.
 * A plain click selects only that tile; Ctrl+click toggles it; Shift+click selects
 * the range from the anchor (added to the selection with Ctrl). Returns the new
 * anchor too: the tile clicked, except that a Shift+click keeps the old anchor.
 */
export function clickSelection(
  order: readonly number[],
  selected: ReadonlySet<number>,
  anchor: number | null,
  id: number,
  keys: ClickKeys,
): { selected: Set<number>; anchor: number } {
  const from = anchor === null ? -1 : order.indexOf(anchor)
  const to = order.indexOf(id)
  if (keys.range && from >= 0 && to >= 0) {
    const range = order.slice(Math.min(from, to), Math.max(from, to) + 1)
    const base = keys.toggle ? [...selected] : []
    return { selected: new Set([...base, ...range]), anchor: anchor! }
  }
  if (keys.toggle || keys.range) {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return { selected: next, anchor: id }
  }
  return { selected: new Set([id]), anchor: id }
}

/**
 * The reference ids a drag from tile `id` carries, in display order: every selected
 * tile when the dragged one is selected, otherwise just that one.
 */
export function draggedIds(
  order: readonly number[],
  selected: ReadonlySet<number>,
  id: number,
): number[] {
  if (!selected.has(id)) return [id]
  return order.filter((entry) => selected.has(entry))
}

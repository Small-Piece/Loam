import { useCallback, useMemo, useState } from 'react'

export interface ClickModifiers {
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
}

export interface Selection {
  /** Selected ids, in the order of the visible items. */
  ids: number[]
  has: (id: number) => boolean
  /** The card the detail panel and the viewer open on: the last one clicked. */
  primary: number | null
  /** Plain click selects one; Ctrl toggles; Shift selects the range from the last click. */
  click: (id: number, modifiers: ClickModifiers) => void
  /** Replaces the selection (box select); additive keeps what was selected before. */
  set: (ids: number[], additive: boolean, base?: number[]) => void
  selectAll: () => void
  clear: () => void
}

/** Multi-selection over an ordered list of ids. Ids that leave the list drop out. */
export function useSelection(order: readonly number[]): Selection {
  const [chosen, setChosen] = useState<ReadonlySet<number>>(new Set())
  const [primary, setPrimary] = useState<number | null>(null)
  const [anchor, setAnchor] = useState<number | null>(null)

  const visible = useMemo(() => new Set(order), [order])
  const ids = useMemo(() => order.filter((id) => chosen.has(id)), [order, chosen])
  const has = useCallback((id: number) => chosen.has(id) && visible.has(id), [chosen, visible])

  const click = useCallback(
    (id: number, { ctrlKey, metaKey, shiftKey }: ClickModifiers) => {
      const toggle = ctrlKey || metaKey
      if (shiftKey && anchor !== null && visible.has(anchor)) {
        const from = order.indexOf(anchor)
        const to = order.indexOf(id)
        const range = order.slice(Math.min(from, to), Math.max(from, to) + 1)
        setChosen((current) => (toggle ? new Set([...current, ...range]) : new Set(range)))
        setPrimary(id)
        return
      }
      if (toggle) {
        setChosen((current) => {
          const next = new Set(current)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          return next
        })
      } else {
        setChosen(new Set([id]))
      }
      setPrimary(id)
      setAnchor(id)
    },
    [anchor, order, visible],
  )

  const set = useCallback((next: number[], additive: boolean, base: number[] = []) => {
    setChosen(new Set(additive ? [...base, ...next] : next))
    const last = next.at(-1) ?? null
    if (last !== null) {
      setPrimary(last)
      setAnchor(last)
    }
  }, [])

  const selectAll = useCallback(() => {
    setChosen(new Set(order))
    setPrimary((current) => current ?? order[0] ?? null)
  }, [order])

  const clear = useCallback(() => {
    setChosen(new Set())
    setPrimary(null)
    setAnchor(null)
  }, [])

  const visiblePrimary =
    primary !== null && visible.has(primary) && chosen.has(primary) ? primary : (ids.at(-1) ?? null)
  return { ids, has, primary: visiblePrimary, click, set, selectAll, clear }
}

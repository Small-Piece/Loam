import { useCallback, useRef, useState, type PointerEvent } from 'react'

export interface Box {
  left: number
  top: number
  width: number
  height: number
}

interface Options {
  /** Called while dragging with the ids of cards the box touches. */
  onSelect: (ids: number[], additive: boolean, base: number[]) => void
  /** The selection when the drag started, kept when Ctrl is held. */
  currentSelection: () => number[]
  /** Called for a plain click on empty space (no drag). */
  onEmptyClick: () => void
}

const DRAG_THRESHOLD = 4

function boxFrom(x1: number, y1: number, x2: number, y2: number): Box {
  return {
    left: Math.min(x1, x2),
    top: Math.min(y1, y2),
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
  }
}

function intersects(box: Box, rect: DOMRect): boolean {
  return (
    rect.right >= box.left &&
    rect.left <= box.left + box.width &&
    rect.bottom >= box.top &&
    rect.top <= box.top + box.height
  )
}

/**
 * Rubber-band selection: dragging on empty space between cards draws a box
 * (in viewport coordinates) and selects every card it touches.
 */
export function useBoxSelect({ onSelect, currentSelection, onEmptyClick }: Options) {
  const [box, setBox] = useState<Box | null>(null)
  const drag = useRef<{
    x: number
    y: number
    additive: boolean
    base: number[]
    moved: boolean
  } | null>(null)

  const onPointerDown = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      if (event.button !== 0) return
      if ((event.target as Element).closest('.ref-card')) return
      // A press on the scrollbar scrolls; it does not start a box.
      const area = event.currentTarget.getBoundingClientRect()
      if (event.clientX >= area.left + event.currentTarget.clientWidth) return
      event.currentTarget.setPointerCapture(event.pointerId)
      const additive = event.ctrlKey || event.metaKey || event.shiftKey
      drag.current = {
        x: event.clientX,
        y: event.clientY,
        additive,
        base: additive ? currentSelection() : [],
        moved: false,
      }
    },
    [currentSelection],
  )

  const onPointerMove = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      const start = drag.current
      if (!start) return
      const distance = Math.hypot(event.clientX - start.x, event.clientY - start.y)
      if (!start.moved && distance < DRAG_THRESHOLD) return
      start.moved = true
      const next = boxFrom(start.x, start.y, event.clientX, event.clientY)
      setBox(next)
      const cards = event.currentTarget.querySelectorAll<HTMLElement>('[data-ref-id]')
      const hit: number[] = []
      for (const card of cards) {
        if (intersects(next, card.getBoundingClientRect())) hit.push(Number(card.dataset['refId']))
      }
      onSelect(hit, start.additive, start.base)
    },
    [onSelect],
  )

  const onPointerUp = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      const start = drag.current
      drag.current = null
      setBox(null)
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
      if (start && !start.moved && !start.additive) onEmptyClick()
    },
    [onEmptyClick],
  )

  return {
    box,
    handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp },
  }
}

import { useEffect, useRef, type KeyboardEvent } from 'react'

interface Props {
  /** Shown to screen readers: "Actions for <name>". */
  name: string
  canMoveUp: boolean
  canMoveDown: boolean
  onMove: (step: -1 | 1) => void
  onClose: () => void
}

/**
 * The actions on one board in the sidebar (right-click, the menu key or Shift+F10).
 * Arrow keys move between items, Escape closes.
 */
export function BoardMenu({ name, canMoveUp, canMoveDown, onMove, onClose }: Props) {
  const menu = useRef<HTMLDivElement>(null)

  useEffect(() => {
    menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
    const onPointer = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node)) onClose()
    }
    window.addEventListener('pointerdown', onPointer, true)
    return () => window.removeEventListener('pointerdown', onPointer, true)
  }, [onClose])

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const items = [
      ...(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []),
    ]
    const at = items.indexOf(document.activeElement as HTMLButtonElement)
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onClose()
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      items[(at + step + items.length) % items.length]?.focus()
    }
  }

  const move = (step: -1 | 1) => {
    onClose()
    onMove(step)
  }

  return (
    <div
      ref={menu}
      className="bible-menu board-menu"
      role="menu"
      aria-label={`Actions for ${name}`}
      onKeyDown={onKeyDown}
      onClick={(event) => event.stopPropagation()}
    >
      <button type="button" role="menuitem" disabled={!canMoveUp} onClick={() => move(-1)}>
        Move up <kbd>Alt+↑</kbd>
      </button>
      <button type="button" role="menuitem" disabled={!canMoveDown} onClick={() => move(1)}>
        Move down <kbd>Alt+↓</kbd>
      </button>
    </div>
  )
}

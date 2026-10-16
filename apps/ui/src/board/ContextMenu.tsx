import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'

export interface MenuItem {
  label: string
  /** Shown faintly on the right, e.g. "Ctrl+C". */
  shortcut?: string
  onSelect: () => void
}

interface Props {
  /** Where the pointer was, in window coordinates. */
  x: number
  y: number
  /** Shown to screen readers. */
  label: string
  items: MenuItem[]
  onClose: () => void
}

/**
 * A small right-click menu at the pointer, in the same look as the board and
 * entry menus. Arrow keys move between items, Escape or a click elsewhere closes it.
 */
export function ContextMenu({ x, y, label, items, onClose }: Props) {
  const menu = useRef<HTMLDivElement>(null)
  const [at, setAt] = useState({ left: x, top: y })

  // Keep the menu inside the window.
  useLayoutEffect(() => {
    const el = menu.current
    if (!el) return
    const left = Math.max(4, Math.min(x, window.innerWidth - el.offsetWidth - 4))
    const top = Math.max(4, Math.min(y, window.innerHeight - el.offsetHeight - 4))
    setAt({ left, top })
  }, [x, y])

  useEffect(() => {
    menu.current?.querySelector<HTMLButtonElement>('button')?.focus()
    const onPointer = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node)) onClose()
    }
    const onBlur = () => onClose()
    window.addEventListener('pointerdown', onPointer, true)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('pointerdown', onPointer, true)
      window.removeEventListener('blur', onBlur)
    }
  }, [onClose])

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const buttons = [...(menu.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onClose()
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      buttons[(current + step + buttons.length) % buttons.length]?.focus()
    }
  }

  return (
    <div
      ref={menu}
      className="bible-menu context-menu"
      role="menu"
      aria-label={label}
      style={{ left: at.left, top: at.top }}
      onKeyDown={onKeyDown}
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          onClick={() => {
            onClose()
            item.onSelect()
          }}
        >
          {item.label}
          {item.shortcut && <kbd>{item.shortcut}</kbd>}
        </button>
      ))}
    </div>
  )
}

/** The one-item menu every image surface opens: copy the image (or the selected images). */
export function copyMenuItems(count: number, onCopy: () => void): MenuItem[] {
  return [
    {
      label: count > 1 ? `Copy ${count} images` : 'Copy image',
      shortcut: 'Ctrl+C',
      onSelect: onCopy,
    },
  ]
}

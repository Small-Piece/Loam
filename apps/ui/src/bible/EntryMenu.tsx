import { useEffect, useRef, type KeyboardEvent } from 'react'

export type EntryAction =
  | { kind: 'rename' }
  | { kind: 'duplicate' }
  | { kind: 'move'; section: string }
  | { kind: 'up' }
  | { kind: 'down' }
  | { kind: 'delete' }

interface Props {
  /** Shown to screen readers: "Actions for <title>". */
  title: string
  sections: ReadonlyArray<{ id: string; name: string }>
  currentSection: string
  canMoveUp: boolean
  canMoveDown: boolean
  onAction: (action: EntryAction) => void
  onClose: () => void
  /** Where to place the menu, relative to its positioned parent. */
  style?: React.CSSProperties
}

/**
 * The actions on one entry, the same wherever they are offered: the sidebar
 * (menu button or right-click), the editor header and pillar cards. Arrow keys
 * move between items, Escape closes.
 */
export function EntryMenu({
  title,
  sections,
  currentSection,
  canMoveUp,
  canMoveDown,
  onAction,
  onClose,
  style,
}: Props) {
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

  const run = (action: EntryAction) => {
    onClose()
    onAction(action)
  }
  const others = sections.filter((section) => section.id !== currentSection)

  return (
    <div
      ref={menu}
      className="bible-menu entry-menu"
      role="menu"
      aria-label={`Actions for ${title}`}
      style={style}
      onKeyDown={onKeyDown}
      onClick={(event) => event.stopPropagation()}
    >
      <button type="button" role="menuitem" onClick={() => run({ kind: 'rename' })}>
        Rename <kbd>F2</kbd>
      </button>
      <button type="button" role="menuitem" onClick={() => run({ kind: 'duplicate' })}>
        Duplicate
      </button>
      <button
        type="button"
        role="menuitem"
        disabled={!canMoveUp}
        onClick={() => run({ kind: 'up' })}
      >
        Move up <kbd>Alt+↑</kbd>
      </button>
      <button
        type="button"
        role="menuitem"
        disabled={!canMoveDown}
        onClick={() => run({ kind: 'down' })}
      >
        Move down <kbd>Alt+↓</kbd>
      </button>
      {others.length > 0 && (
        <div className="menu-group" role="group" aria-label="Move to section">
          <div className="menu-heading">Move to section</div>
          {others.map((section) => (
            <button
              key={section.id}
              type="button"
              role="menuitem"
              onClick={() => run({ kind: 'move', section: section.id })}
            >
              {section.name}
            </button>
          ))}
        </div>
      )}
      <button
        type="button"
        role="menuitem"
        className="danger"
        onClick={() => run({ kind: 'delete' })}
      >
        Delete <kbd>Del</kbd>
      </button>
    </div>
  )
}

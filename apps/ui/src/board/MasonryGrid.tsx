import type { MouseEvent } from 'react'
import { assetUrl, type ReferenceCard } from '@loam/protocol'
import type { ClickModifiers } from './useSelection.ts'

interface Props {
  items: ReferenceCard[]
  isSelected: (id: number) => boolean
  onClickCard: (id: number, modifiers: ClickModifiers) => void
  onOpenCard: (id: number) => void
  /** Right-click on a card (window coordinates of the pointer). */
  onCardMenu: (id: number, x: number, y: number) => void
}

function modifiersOf(event: MouseEvent): ClickModifiers {
  return { ctrlKey: event.ctrlKey, metaKey: event.metaKey, shiftKey: event.shiftKey }
}

/** Masonry layout via CSS columns: each card keeps its image's aspect ratio. */
export function MasonryGrid({ items, isSelected, onClickCard, onOpenCard, onCardMenu }: Props) {
  return (
    <div className="masonry">
      {items.map((item) => {
        const selected = isSelected(item.id)
        return (
          <button
            key={item.id}
            type="button"
            className={'ref-card' + (selected ? ' selected' : '')}
            data-testid="ref-card"
            data-ref-id={item.id}
            aria-label={item.title}
            aria-pressed={selected}
            onClick={(event) => onClickCard(item.id, modifiersOf(event))}
            onDoubleClick={() => onOpenCard(item.id)}
            onContextMenu={(event) => {
              event.preventDefault()
              onCardMenu(item.id, event.clientX, event.clientY)
            }}
          >
            <img
              className="ref-card-thumb"
              src={assetUrl(item.thumbHash)}
              width={item.thumbWidth}
              height={item.thumbHeight}
              loading="lazy"
              decoding="async"
              alt=""
              draggable={false}
            />
            <span className="ref-card-body">
              <span className="ref-card-title">{item.title}</span>
              {item.tags.length > 0 && (
                <span className="ref-card-tags">
                  {item.tags.slice(0, 3).map((tag) => (
                    <span key={tag} className="ref-tag">
                      {tag}
                    </span>
                  ))}
                  {item.tags.length > 3 && (
                    <span className="ref-tag more">+{item.tags.length - 3}</span>
                  )}
                </span>
              )}
            </span>
          </button>
        )
      })}
    </div>
  )
}

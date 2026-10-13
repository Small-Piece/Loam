import type { Place } from './place.ts'
import { MaximizeIcon, TrashIcon, XIcon } from '../icons.tsx'

interface Props {
  place: Place
  count: number
  onView: () => void
  onMoveToTrash: () => void
  onRemoveFromBoard: () => void
  onRestore: () => void
  onClear: () => void
}

/** Actions for the current selection. Delete key maps to the first destructive action shown. */
export function SelectionBar({
  place,
  count,
  onView,
  onMoveToTrash,
  onRemoveFromBoard,
  onRestore,
  onClear,
}: Props) {
  return (
    <div className="selection-bar" role="toolbar" aria-label="Selection">
      <span className="selection-count" data-testid="selection-count">
        {count} selected
      </span>
      <button type="button" className="btn ghost" onClick={onView} title="Open viewer (Space)">
        <MaximizeIcon size={12} /> View
      </button>
      {place.kind === 'trash' ? (
        <button type="button" className="btn" onClick={onRestore}>
          Restore
        </button>
      ) : (
        <>
          {place.kind === 'board' && (
            <button
              type="button"
              className="btn"
              onClick={onRemoveFromBoard}
              title="Take off this board; keep in the Library (Delete)"
            >
              Remove from board
            </button>
          )}
          <button
            type="button"
            className="btn danger-outline"
            onClick={onMoveToTrash}
            title={place.kind === 'library' ? 'Move to Trash (Delete)' : 'Move to Trash'}
          >
            <TrashIcon size={12} /> Move to Trash
          </button>
        </>
      )}
      <button type="button" className="btn ghost" onClick={onClear} aria-label="Clear selection">
        <XIcon size={11} />
      </button>
    </div>
  )
}

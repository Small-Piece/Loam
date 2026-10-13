import type { BoardGroup, BoardNote, NoteSize, PaletteColor } from '@loam/protocol'
import { PALETTE_HEX } from './model.ts'

const SIZES: NoteSize[] = ['S', 'M', 'L', 'XL']
const COLORS = Object.keys(PALETTE_HEX) as PaletteColor[]

interface Props {
  notes: BoardNote[]
  groups: BoardGroup[]
  onNoteStyle: (patch: { fontSize?: NoteSize; color?: PaletteColor; background?: boolean }) => void
  onGroupStyle: (patch: { color?: PaletteColor; locked?: boolean }) => void
  onAttachToggle: () => void
  onRename: () => void
}

function Swatches({
  label,
  current,
  onPick,
}: {
  label: string
  current: PaletteColor | undefined
  onPick: (color: PaletteColor) => void
}) {
  return (
    <div className="swatches" role="radiogroup" aria-label={label}>
      {COLORS.map((color) => (
        <button
          key={color}
          type="button"
          role="radio"
          aria-checked={current === color}
          aria-label={`${label}: ${color}`}
          title={color}
          className={'swatch' + (current === color ? ' active' : '')}
          style={{ background: PALETTE_HEX[color] }}
          onClick={() => onPick(color)}
        />
      ))}
    </div>
  )
}

/** Style controls for the selected notes or groups. */
export function ObjectToolbar({
  notes,
  groups,
  onNoteStyle,
  onGroupStyle,
  onAttachToggle,
  onRename,
}: Props) {
  const note = notes[0]
  const group = groups[0]
  return (
    <div
      className="object-toolbar"
      role="toolbar"
      aria-label={notes.length > 0 ? 'Note style' : 'Group style'}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {note && (
        <>
          <div className="size-buttons" role="group" aria-label="Note size">
            {SIZES.map((size) => (
              <button
                key={size}
                type="button"
                className={'btn ghost' + (note.fontSize === size ? ' active' : '')}
                aria-pressed={note.fontSize === size}
                onClick={() => onNoteStyle({ fontSize: size })}
              >
                {size}
              </button>
            ))}
          </div>
          <Swatches
            label="Text colour"
            current={note.color}
            onPick={(color) => onNoteStyle({ color })}
          />
          <button
            type="button"
            className={'btn ghost' + (note.background ? ' active' : '')}
            aria-pressed={note.background}
            onClick={() => onNoteStyle({ background: !note.background })}
          >
            Background
          </button>
          {notes.length === 1 && (
            <button type="button" className="btn ghost" onClick={onAttachToggle}>
              {note.attachedReferenceId === null ? 'Attach to image' : 'Detach'}
            </button>
          )}
        </>
      )}
      {!note && group && (
        <>
          <Swatches
            label="Group colour"
            current={group.color}
            onPick={(color) => onGroupStyle({ color })}
          />
          <button
            type="button"
            className={'btn ghost' + (group.locked ? ' active' : '')}
            aria-pressed={group.locked}
            title="Locked: clicking an image selects the whole group"
            onClick={() => onGroupStyle({ locked: !group.locked })}
          >
            {group.locked ? 'Locked' : 'Unlocked'}
          </button>
          {groups.length === 1 && (
            <button type="button" className="btn ghost" onClick={onRename}>
              Rename
            </button>
          )}
        </>
      )}
    </div>
  )
}

import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { XIcon } from '../icons.tsx'
import { canCreate, tagOptions, tagToAdd, type TagOption } from './tagPicker.ts'

interface Props {
  tags: string[]
  /** Every tag in the Library with its use count, offered while typing. */
  options: TagOption[]
  onChange: (tags: string[]) => void
}

/** About 8 rows show; the rest scroll. Matches .tag-picker-option in board.css. */
const ROW_HEIGHT = 28
const VISIBLE_ROWS = 8
const LIST_PADDING = 8

type Row = { kind: 'tag'; tag: TagOption } | { kind: 'create'; text: string }

/**
 * Tag chips with remove buttons, and an input that offers existing tags (a combobox):
 * focus or type to see them, ↑/↓ to highlight, Enter or click to add, Esc to close.
 * Enter with nothing highlighted, or a comma, adds the typed text; when it names an
 * existing tag in another case, that tag's spelling is used.
 */
export function TagEditor({ tags, options, onChange }: Props) {
  const [draft, setDraft] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const [place, setPlace] = useState<CSSProperties | null>(null)
  const editor = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const listId = useId()

  const rows: Row[] = [
    ...tagOptions(options, tags, draft).map((tag): Row => ({ kind: 'tag', tag })),
    ...(canCreate(options, tags, draft) ? [{ kind: 'create', text: draft.trim() } as Row] : []),
  ]
  const showing = open && rows.length > 0
  const optionId = (index: number) => `${listId}-option-${index}`

  function add(names: string[]) {
    const taken = new Set(tags.map((tag) => tag.toLowerCase()))
    const added: string[] = []
    for (const name of names) {
      if (taken.has(name.toLowerCase())) continue
      taken.add(name.toLowerCase())
      added.push(name)
    }
    setDraft('')
    setActive(-1)
    if (added.length > 0) onChange([...tags, ...added])
  }

  /** Adds the typed text (comma-separated parts), using existing spellings. */
  function commitDraft() {
    const names = draft
      .split(',')
      .map((part) => tagToAdd(options, part))
      .filter((name): name is string => name !== null)
    if (names.length > 0 || draft !== '') add(names)
  }

  function pick(row: Row) {
    add([row.kind === 'tag' ? row.tag.name : row.text])
  }

  // Place the list under the editor, or above it when there is no room below.
  useLayoutEffect(() => {
    if (!showing) return
    const measure = () => {
      const box = editor.current?.getBoundingClientRect()
      if (!box) return
      const height = Math.min(rows.length, VISIBLE_ROWS) * ROW_HEIGHT + LIST_PADDING
      const below = window.innerHeight - box.bottom
      const left = Math.max(4, Math.min(box.left, window.innerWidth - box.width - 4))
      setPlace(
        below >= height + 8 || box.top < below
          ? { left, width: box.width, top: box.bottom + 4 }
          : { left, width: box.width, bottom: window.innerHeight - box.top + 4 },
      )
    }
    measure()
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    return () => {
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
    }
  }, [showing, rows.length])

  // Keep the highlighted row in view while moving through a long list.
  useEffect(() => {
    if (active < 0) return
    list.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [active])

  return (
    <div className="tag-editor" ref={editor}>
      {tags.map((tag) => (
        <span key={tag} className="ref-tag editable">
          {tag}
          <button
            type="button"
            className="ref-tag-x"
            aria-label={`Remove tag ${tag}`}
            onClick={() => onChange(tags.filter((other) => other !== tag))}
          >
            <XIcon size={9} />
          </button>
        </span>
      ))}
      <input
        className="ref-tag-input"
        aria-label="Add tag"
        placeholder="Add tag…"
        maxLength={40}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={showing}
        aria-controls={listId}
        aria-activedescendant={showing && active >= 0 ? optionId(active) : undefined}
        value={draft}
        onFocus={() => setOpen(true)}
        onChange={(event) => {
          setDraft(event.target.value)
          setActive(-1)
          setOpen(true)
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault()
            if (!showing) setOpen(true)
            else setActive((index) => Math.min(index + 1, rows.length - 1))
          } else if (event.key === 'ArrowUp') {
            event.preventDefault()
            setActive((index) => Math.max(index - 1, -1))
          } else if (event.key === 'Enter') {
            event.preventDefault()
            const row = showing && active >= 0 ? rows[active] : undefined
            if (row) pick(row)
            else commitDraft()
          } else if (event.key === ',') {
            event.preventDefault()
            commitDraft()
          } else if (event.key === 'Escape' && showing) {
            // Close the list but keep the text; a second Esc goes to the panel as before.
            event.preventDefault()
            event.stopPropagation()
            setOpen(false)
            setActive(-1)
          } else if (event.key === 'Tab') {
            setOpen(false)
          } else if (event.key === 'Backspace' && draft === '' && tags.length > 0) {
            onChange(tags.slice(0, -1))
          }
        }}
        onBlur={() => {
          setOpen(false)
          setActive(-1)
          commitDraft()
        }}
      />
      {showing && place && (
        <div
          ref={list}
          id={listId}
          className="tag-picker"
          role="listbox"
          aria-label="Existing tags"
          style={place}
          data-testid="tag-picker"
        >
          {rows.map((row, index) => (
            <div
              key={row.kind === 'tag' ? row.tag.name : `create:${row.text}`}
              id={optionId(index)}
              role="option"
              aria-selected={index === active}
              data-index={index}
              className={
                'tag-picker-option' +
                (index === active ? ' active' : '') +
                (row.kind === 'create' ? ' create' : '')
              }
              // Keep the focus in the input, so blur does not add the typed text first.
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActive(index)}
              onClick={() => pick(row)}
            >
              {row.kind === 'tag' ? (
                <>
                  <span className="tag-picker-name">{row.tag.name}</span>
                  <span className="tag-picker-count mono">{row.tag.count}</span>
                </>
              ) : (
                <span className="tag-picker-name">Create &quot;{row.text}&quot;</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

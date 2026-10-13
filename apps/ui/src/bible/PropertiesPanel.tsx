import { useState } from 'react'
import type { FieldValueData, PropertyData } from '@loam/protocol'
import { XIcon } from '../icons.tsx'

/** An entry an entry field can point at. */
export interface PickableEntry {
  id: string
  title: string
  section: string
  path: string
}

interface Props {
  properties: readonly PropertyData[]
  tags: readonly string[]
  tagOptions: readonly string[]
  entries: readonly PickableEntry[]
  onChange: (key: string, value: FieldValueData) => void
  onOpen: (path: string) => void
  /** Creates a missing entry an entry field names, in the field's section. */
  onCreate: (title: string, section: string) => void
  /** For a decision or idea: true when no pillar is ticked. */
  noPillar: boolean | null
}

/** The pillars field of a decision or idea: shown as the pillar check. */
function isPillarCheck(property: PropertyData): boolean {
  return property.key === 'pillars' && property.type === 'entries' && property.section === 'pillars'
}

/** Missing entries an entry field names: the titles from its warning-free refs with no path. */
function missingTargets(property: PropertyData): string[] {
  return property.refs
    .filter((ref) => ref.path === null)
    .map((ref) => /^\[\[([^[\]|#]+)/.exec(ref.value.trim())?.[1]?.trim() ?? ref.value.trim())
    .filter((title) => title !== '' && !/^[a-z0-9]{12}$/.test(title))
}

/** Short texts (alternatives): chips, with a box to add one. */
function ListControl({
  label,
  items,
  onChange,
}: {
  label: string
  items: readonly string[]
  onChange: (items: string[]) => void
}) {
  const [draft, setDraft] = useState('')
  const add = () => {
    const item = draft.trim()
    setDraft('')
    if (item && !items.includes(item)) onChange([...items, item])
  }
  return (
    <div className="prop-chips" role="group" aria-label={label}>
      {items.map((item) => (
        <span key={item} className="chip">
          {item}
          <button
            type="button"
            aria-label={`Remove ${item} from ${label}`}
            onClick={() => onChange(items.filter((other) => other !== item))}
          >
            <XIcon size={10} />
          </button>
        </span>
      ))}
      <input
        className="prop-input prop-add"
        aria-label={`Add to ${label}`}
        placeholder="+ add"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            add()
          }
        }}
        onBlur={add}
      />
    </div>
  )
}

/** "Which pillars does this serve?": every pillar as a chip to tick. Nothing ticked is allowed. */
function PillarCheck({
  property,
  pillars,
  onChange,
}: {
  property: PropertyData
  pillars: readonly PickableEntry[]
  onChange: (value: FieldValueData) => void
}) {
  const current = Array.isArray(property.value) ? property.value : []
  // A pillar named by its title (typed by hand) counts as ticked too.
  const ticked = (pillar: PickableEntry) =>
    current.includes(pillar.id) ||
    property.refs.some((ref) => ref.path === pillar.path && current.includes(ref.value))
  return (
    <div
      className="prop-chips pillar-check"
      role="group"
      aria-label="Which pillars does this serve?"
    >
      {pillars.length === 0 && <span className="bible-muted">No pillars yet.</span>}
      {pillars.map((pillar) => {
        const on = ticked(pillar)
        return (
          <button
            key={pillar.id}
            type="button"
            className={'chip toggle' + (on ? ' on' : '')}
            aria-pressed={on}
            onClick={() => {
              const keep = current.filter(
                (value) =>
                  value !== pillar.id &&
                  !property.refs.some((ref) => ref.value === value && ref.path === pillar.path),
              )
              onChange(on ? keep : [...keep, pillar.id])
            }}
          >
            {pillar.title}
          </button>
        )
      })}
    </div>
  )
}

/** Commits on blur or Enter, so typing does not write a file per keystroke. */
function TextInput({
  label,
  value,
  type,
  onCommit,
}: {
  label: string
  value: string
  type: 'text' | 'number' | 'date'
  onCommit: (value: string) => void
}) {
  const [draft, setDraft] = useState(value)
  const [seen, setSeen] = useState(value)
  if (seen !== value) {
    // The file changed (saved, or edited elsewhere): show its value.
    setSeen(value)
    setDraft(value)
  }
  return (
    <input
      className="prop-input"
      aria-label={label}
      type={type}
      value={draft}
      onChange={(event) => {
        setDraft(event.target.value)
        // A date picker has no typing; its change is the commit.
        if (type === 'date') onCommit(event.target.value)
      }}
      onBlur={() => {
        if (type !== 'date' && draft !== value) onCommit(draft)
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur()
        if (event.key === 'Escape') {
          setDraft(value)
          event.currentTarget.blur()
        }
      }}
    />
  )
}

function Chips({
  label,
  items,
  onRemove,
  render,
}: {
  label: string
  items: readonly string[]
  onRemove: (item: string) => void
  render?: (item: string) => React.ReactNode
}) {
  return (
    <>
      {items.map((item) => (
        <span key={item} className="chip">
          {render ? render(item) : item}
          <button
            type="button"
            aria-label={`Remove ${item} from ${label}`}
            onClick={() => onRemove(item)}
          >
            <XIcon size={10} />
          </button>
        </span>
      ))}
    </>
  )
}

function Control({
  property,
  entries,
  onChange,
  onOpen,
}: {
  property: PropertyData
  entries: readonly PickableEntry[]
  onChange: (value: FieldValueData) => void
  onOpen: (path: string) => void
}) {
  const { label, type, value } = property
  const options = property.options ?? []
  const pickable = entries.filter(
    (entry) =>
      !entry.id.startsWith('path:') && (!property.section || entry.section === property.section),
  )
  switch (type) {
    case 'text':
      return (
        <TextInput
          label={label}
          type="text"
          value={typeof value === 'string' ? value : ''}
          onCommit={(next) => onChange(next === '' ? null : next)}
        />
      )
    case 'number':
      return (
        <TextInput
          label={label}
          type="number"
          value={typeof value === 'number' ? String(value) : ''}
          onCommit={(next) => onChange(next.trim() === '' ? null : Number(next))}
        />
      )
    case 'date':
      return (
        <TextInput
          label={label}
          type="date"
          value={typeof value === 'string' ? value : ''}
          onCommit={(next) => onChange(next === '' ? null : next)}
        />
      )
    case 'list':
      return (
        <ListControl
          label={label}
          items={Array.isArray(value) ? value : []}
          onChange={(items) => onChange(items)}
        />
      )
    case 'checkbox':
      return (
        <input
          type="checkbox"
          aria-label={label}
          checked={value === true}
          onChange={(event) => onChange(event.target.checked)}
        />
      )
    case 'select': {
      const current = typeof value === 'string' ? value : ''
      return (
        <select
          className="prop-input"
          aria-label={label}
          value={current}
          onChange={(event) => onChange(event.target.value === '' ? null : event.target.value)}
        >
          <option value="">—</option>
          {current !== '' && !options.includes(current) && (
            <option value={current}>{current}</option>
          )}
          {options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      )
    }
    case 'multi-select': {
      const current = Array.isArray(value) ? value : []
      return (
        <div className="prop-chips" role="group" aria-label={label}>
          {options.map((option) => {
            const on = current.includes(option)
            return (
              <button
                key={option}
                type="button"
                className={'chip toggle' + (on ? ' on' : '')}
                aria-pressed={on}
                onClick={() =>
                  onChange(on ? current.filter((item) => item !== option) : [...current, option])
                }
              >
                {option}
              </button>
            )
          })}
        </div>
      )
    }
    case 'entry': {
      const current = typeof value === 'string' ? value : ''
      const ref = property.refs[0]
      const known = pickable.some((entry) => entry.id === current)
      return (
        <div className="prop-entry">
          <select
            className="prop-input"
            aria-label={label}
            value={known ? current : ''}
            onChange={(event) => onChange(event.target.value === '' ? null : event.target.value)}
          >
            <option value="">{current && !known ? `(${ref?.title ?? current})` : '—'}</option>
            {pickable.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.title}
              </option>
            ))}
          </select>
          {ref?.path && (
            <button
              type="button"
              className="bible-link-button"
              onClick={() => onOpen(ref.path as string)}
            >
              Open
            </button>
          )}
        </div>
      )
    }
    case 'entries': {
      const current = Array.isArray(value) ? value : []
      const titleOf = (item: string) =>
        property.refs.find((ref) => ref.value === item)?.title ?? item
      return (
        <div className="prop-chips" role="group" aria-label={label}>
          <Chips
            label={label}
            items={current}
            onRemove={(item) => onChange(current.filter((other) => other !== item))}
            render={(item) => {
              const path = property.refs.find((ref) => ref.value === item)?.path
              return path ? (
                <button type="button" className="chip-link" onClick={() => onOpen(path)}>
                  {titleOf(item)}
                </button>
              ) : (
                titleOf(item)
              )
            }}
          />
          <select
            className="prop-input prop-add"
            aria-label={`Add to ${label}`}
            value=""
            onChange={(event) => {
              if (event.target.value) onChange([...current, event.target.value])
            }}
          >
            <option value="">+ add</option>
            {pickable
              .filter((entry) => !current.includes(entry.id))
              .map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.title}
                </option>
              ))}
          </select>
        </div>
      )
    }
  }
}

function TagsControl({
  tags,
  options,
  onChange,
}: {
  tags: readonly string[]
  options: readonly string[]
  onChange: (tags: string[]) => void
}) {
  const [draft, setDraft] = useState('')
  const add = () => {
    const tag = draft.trim()
    setDraft('')
    if (tag && !tags.some((existing) => existing.toLowerCase() === tag.toLowerCase())) {
      onChange([...tags, tag])
    }
  }
  return (
    <div className="prop-chips" role="group" aria-label="Tags">
      <Chips
        label="Tags"
        items={tags}
        onRemove={(tag) => onChange(tags.filter((t) => t !== tag))}
      />
      <input
        className="prop-input prop-add"
        aria-label="Add tag"
        placeholder="+ tag"
        list="bible-tag-options"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ',') {
            event.preventDefault()
            add()
          } else if (event.key === 'Backspace' && draft === '' && tags.length > 0) {
            onChange(tags.slice(0, -1))
          }
        }}
        onBlur={add}
      />
      <datalist id="bible-tag-options">
        {options
          .filter((option) => !tags.some((tag) => tag.toLowerCase() === option.toLowerCase()))
          .map((option) => (
            <option key={option} value={option} />
          ))}
      </datalist>
    </div>
  )
}

/** The section's fields for one entry, plus its tags, above the body. */
export function PropertiesPanel({
  properties,
  tags,
  tagOptions,
  entries,
  onChange,
  onOpen,
  onCreate,
  noPillar,
}: Props) {
  const pillars = entries.filter(
    (entry) => entry.section === 'pillars' && !entry.id.startsWith('path:'),
  )
  return (
    <section className="properties" aria-label="Properties">
      <div className="prop-row">
        <span className="prop-label">Tags</span>
        <TagsControl tags={tags} options={tagOptions} onChange={(next) => onChange('tags', next)} />
      </div>
      {properties.map((property) => (
        <div key={property.key} className="prop-row" data-field={property.key}>
          <span className="prop-label">
            {isPillarCheck(property) ? 'Which pillars does this serve?' : property.label}
          </span>
          <div className="prop-value">
            {isPillarCheck(property) ? (
              <PillarCheck
                property={property}
                pillars={pillars}
                onChange={(next) => onChange(property.key, next)}
              />
            ) : (
              <Control
                property={property}
                entries={entries}
                onChange={(next) => onChange(property.key, next)}
                onOpen={onOpen}
              />
            )}
            {isPillarCheck(property) && noPillar && (
              <span className="no-pillar" role="note" data-testid="no-pillar">
                Serves no pillar
              </span>
            )}
            {(property.type === 'entry' || property.type === 'entries') &&
              property.section &&
              missingTargets(property).map((title) => (
                <button
                  key={title}
                  type="button"
                  className="bible-link-button"
                  onClick={() => onCreate(title, property.section as string)}
                >
                  Create “{title}”
                </button>
              ))}
            {property.warning && (
              <span
                className="prop-warning"
                role="note"
                title="The file keeps this value until you change it"
              >
                ⚠ {property.warning}
                {property.raw !== null && property.value === null
                  ? ` (in the file: ${property.raw})`
                  : ''}
              </span>
            )}
          </div>
        </div>
      ))}
    </section>
  )
}

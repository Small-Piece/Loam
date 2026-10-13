import { useState } from 'react'
import type { FieldDefData } from '@loam/protocol'
import { XIcon } from '../icons.tsx'

type FieldType = FieldDefData['type']

const TYPES: Array<{ type: FieldType; label: string }> = [
  { type: 'text', label: 'Text' },
  { type: 'number', label: 'Number' },
  { type: 'select', label: 'Choice' },
  { type: 'multi-select', label: 'Choices' },
  { type: 'entry', label: 'Entry' },
  { type: 'entries', label: 'Entries' },
  { type: 'date', label: 'Date' },
  { type: 'checkbox', label: 'Checkbox' },
  { type: 'list', label: 'List' },
]

/** A field as edited here; key null until it is saved. */
export interface FieldDraft {
  key: string | null
  label: string
  type: FieldType
  options: string[]
  section: string
}

interface Props {
  sectionName: string
  fields: readonly FieldDefData[]
  /** Fields the app gives this kind of section; shown, not editable. */
  builtIn?: readonly FieldDefData[]
  sections: ReadonlyArray<{ id: string; name: string }>
  onSave: (fields: FieldDraft[]) => Promise<boolean>
  onClose: () => void
}

function toDraft(field: FieldDefData): FieldDraft {
  return {
    key: field.key,
    label: field.label,
    type: field.type,
    options: field.options ?? [],
    section: field.section ?? '',
  }
}

/**
 * A section's properties: add, rename, reorder and remove. Removing a field
 * only removes its definition; the values stay in the entry files.
 */
export function SectionFields({
  sectionName,
  fields,
  builtIn = [],
  sections,
  onSave,
  onClose,
}: Props) {
  const [drafts, setDrafts] = useState<FieldDraft[]>(() => fields.map(toDraft))
  const [busy, setBusy] = useState(false)

  const update = (index: number, patch: Partial<FieldDraft>) =>
    setDrafts((list) => list.map((draft, i) => (i === index ? { ...draft, ...patch } : draft)))
  const move = (index: number, step: number) =>
    setDrafts((list) => {
      const next = [...list]
      const [item] = next.splice(index, 1)
      if (item) next.splice(index + step, 0, item)
      return next
    })

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form
        className="modal section-fields"
        role="dialog"
        aria-modal="true"
        aria-labelledby="fields-title"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onClose()
        }}
        onSubmit={(event) => {
          event.preventDefault()
          setBusy(true)
          void onSave(drafts).then((ok) => {
            setBusy(false)
            if (ok) onClose()
          })
        }}
      >
        <h2 id="fields-title" className="modal-title">
          {sectionName} fields
        </h2>
        <p className="modal-message">
          Properties every entry in {sectionName} has. Removing one keeps its values in the files.
        </p>
        {builtIn.length > 0 && (
          <p className="bible-muted builtin-fields">
            Built in: {builtIn.map((field) => field.label).join(', ')}.
          </p>
        )}
        <ol className="field-list">
          {drafts.map((draft, index) => (
            <li key={draft.key ?? `new-${index}`} className="field-row" data-field-row={index}>
              <input
                className="bible-input"
                aria-label={`Field ${index + 1} name`}
                value={draft.label}
                onChange={(event) => update(index, { label: event.target.value })}
              />
              <select
                className="bible-input"
                aria-label={`Field ${index + 1} type`}
                value={draft.type}
                onChange={(event) => update(index, { type: event.target.value as FieldType })}
              >
                {TYPES.map((option) => (
                  <option key={option.type} value={option.type}>
                    {option.label}
                  </option>
                ))}
              </select>
              {(draft.type === 'select' || draft.type === 'multi-select') && (
                <input
                  className="bible-input field-options"
                  aria-label={`Field ${index + 1} choices`}
                  placeholder="Choices, separated by commas"
                  value={draft.options.join(', ')}
                  onChange={(event) =>
                    update(index, {
                      options: event.target.value
                        .split(',')
                        .map((option) => option.trim())
                        .filter((option, at, all) => option !== '' || at === all.length - 1),
                    })
                  }
                />
              )}
              {(draft.type === 'entry' || draft.type === 'entries') && (
                <select
                  className="bible-input"
                  aria-label={`Field ${index + 1} section`}
                  value={draft.section}
                  onChange={(event) => update(index, { section: event.target.value })}
                >
                  <option value="">Any section</option>
                  {sections.map((section) => (
                    <option key={section.id} value={section.id}>
                      {section.name}
                    </option>
                  ))}
                </select>
              )}
              <span className="field-key mono">{draft.key ?? 'new'}</span>
              <div className="field-buttons">
                <button
                  type="button"
                  className="bible-icon-button"
                  aria-label={`Move ${draft.label || 'field'} up`}
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="bible-icon-button"
                  aria-label={`Move ${draft.label || 'field'} down`}
                  disabled={index === drafts.length - 1}
                  onClick={() => move(index, 1)}
                >
                  ↓
                </button>
                <button
                  type="button"
                  className="bible-icon-button"
                  aria-label={`Remove ${draft.label || 'field'}`}
                  onClick={() => setDrafts((list) => list.filter((_, i) => i !== index))}
                >
                  <XIcon />
                </button>
              </div>
            </li>
          ))}
        </ol>
        <button
          type="button"
          className="board-add"
          onClick={() =>
            setDrafts((list) => [
              ...list,
              { key: null, label: '', type: 'text', options: [], section: '' },
            ])
          }
        >
          + Add field
        </button>
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="btn primary"
            disabled={busy || drafts.some((draft) => draft.label.trim() === '')}
          >
            Save fields
          </button>
        </div>
      </form>
    </div>
  )
}

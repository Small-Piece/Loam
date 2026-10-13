import { useState } from 'react'
import type { VaultViewData } from '@loam/protocol'

export { suggestSection } from './pickerDefault.ts'

type KitUpdate = NonNullable<VaultViewData['kitUpdate']>
type Sections = VaultViewData['sections']

function Modal({
  label,
  children,
  onClose,
}: {
  label: string
  children: React.ReactNode
  onClose: () => void
}) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={label}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onClose()
        }}
      >
        {children}
      </div>
    </div>
  )
}

/** "Kit updates available": what the starter kit would add to bible.json, each with a box. */
export function KitUpdateDialog({
  update,
  onApply,
  onDismiss,
  onClose,
}: {
  update: KitUpdate
  onApply: (chosen: { sections: string[]; fields: Array<{ section: string; key: string }> }) => void
  onDismiss: () => void
  onClose: () => void
}) {
  const [sections, setSections] = useState(() => new Set(update.sections.map((s) => s.id)))
  const [fields, setFields] = useState(
    () => new Set(update.fields.map((item) => `${item.section}.${item.field.key}`)),
  )
  const toggle = (set: Set<string>, key: string, apply: (next: Set<string>) => void) => {
    const next = new Set(set)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    apply(next)
  }
  const bySection = new Map<string, KitUpdate['fields']>()
  for (const item of update.fields) {
    bySection.set(item.section, [...(bySection.get(item.section) ?? []), item])
  }
  return (
    <Modal label="Kit updates" onClose={onClose}>
      <h2 className="modal-title">Kit updates</h2>
      <p className="modal-message">
        Your bible&apos;s starter kit now has these. Adding them only changes bible.json; entry
        files stay as they are, and existing entries show new fields empty.
      </p>
      <div className="kit-update-list">
        {[...bySection.entries()].map(([section, items]) => (
          <fieldset key={section} className="kit-update-group">
            <legend className="bible-label">Fields for {items[0]?.sectionName ?? section}</legend>
            {items.map((item) => {
              const key = `${item.section}.${item.field.key}`
              return (
                <label key={key} className="kit-update-item">
                  <input
                    type="checkbox"
                    checked={fields.has(key)}
                    onChange={() => toggle(fields, key, setFields)}
                  />
                  {item.field.label} <span className="bible-muted">({item.field.type})</span>
                </label>
              )
            })}
          </fieldset>
        ))}
        {update.sections.length > 0 && (
          <fieldset className="kit-update-group">
            <legend className="bible-label">New sections</legend>
            {update.sections.map((section) => (
              <label key={section.id} className="kit-update-item">
                <input
                  type="checkbox"
                  checked={sections.has(section.id)}
                  onChange={() => toggle(sections, section.id, setSections)}
                />
                {section.name}
                {section.fields.length > 0 && (
                  <span className="bible-muted">
                    {' '}
                    (with {section.fields.map((field) => field.label).join(', ')})
                  </span>
                )}
              </label>
            ))}
          </fieldset>
        )}
      </div>
      <div className="modal-actions">
        <button type="button" className="btn ghost" onClick={onDismiss}>
          Not now
        </button>
        <button
          type="button"
          className="btn primary"
          disabled={sections.size === 0 && fields.size === 0}
          onClick={() =>
            onApply({
              sections: [...sections],
              fields: [...fields].map((key) => {
                const at = key.indexOf('.')
                return { section: key.slice(0, at), key: key.slice(at + 1) }
              }),
            })
          }
        >
          Add selected
        </button>
      </div>
    </Modal>
  )
}

/** Where should a new entry from a missing link go? */
export function SectionPicker({
  title,
  sections,
  initial,
  onPick,
  onClose,
}: {
  title: string
  sections: Sections
  initial: string
  onPick: (section: string) => void
  onClose: () => void
}) {
  const [section, setSection] = useState(initial)
  return (
    <Modal label="Create entry" onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          onPick(section)
        }}
      >
        <h2 className="modal-title">Create “{title}”</h2>
        <p className="modal-message">Which section does it belong in?</p>
        <div className="section-choices" role="radiogroup" aria-label="Section">
          {sections.map((candidate) => (
            <label key={candidate.id} className="kit-update-item">
              <input
                type="radio"
                name="section"
                value={candidate.id}
                checked={section === candidate.id}
                onChange={() => setSection(candidate.id)}
              />
              {candidate.name}
            </label>
          ))}
        </div>
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary">
            Create
          </button>
        </div>
      </form>
    </Modal>
  )
}

/** Promote an idea: into Decisions or another section, under a title of its own. */
export function PromoteDialog({
  ideaTitle,
  sections,
  onPromote,
  onClose,
}: {
  ideaTitle: string
  sections: Sections
  onPromote: (section: string, title: string) => void
  onClose: () => void
}) {
  const targets = sections.filter((section) => section.id !== 'ideas')
  const [section, setSection] = useState(
    targets.some((target) => target.id === 'decisions') ? 'decisions' : (targets[0]?.id ?? ''),
  )
  const [title, setTitle] = useState(`${ideaTitle} (decision)`)
  return (
    <Modal label="Promote idea" onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          if (title.trim() && section) onPromote(section, title.trim())
        }}
      >
        <h2 className="modal-title">Promote “{ideaTitle}”</h2>
        <p className="modal-message">
          A new entry is created and linked both ways; the idea is marked promoted. Undo takes both
          back.
        </p>
        <label className="bible-field">
          <span className="bible-label">Into</span>
          <select
            className="bible-input"
            aria-label="Into"
            value={section}
            onChange={(event) => {
              setSection(event.target.value)
              if (title === `${ideaTitle} (decision)` && event.target.value !== 'decisions') {
                setTitle(ideaTitle)
              }
            }}
          >
            {targets.map((target) => (
              <option key={target.id} value={target.id}>
                {target.id === 'decisions' ? 'A decision' : target.name}
              </option>
            ))}
          </select>
        </label>
        <label className="bible-field">
          <span className="bible-label">Title</span>
          <input
            className="bible-input"
            aria-label="Title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={!title.trim()}>
            Promote
          </button>
        </div>
      </form>
    </Modal>
  )
}

/** Asks before a link leaves the app for the system browser. */
export function ExternalLinkDialog({
  url,
  onOpen,
  onClose,
}: {
  url: string
  onOpen: () => void
  onClose: () => void
}) {
  return (
    <Modal label="Open link" onClose={onClose}>
      <h2 className="modal-title">Open this link in your browser?</h2>
      <p className="modal-message external-url mono" data-testid="external-url">
        {url}
      </p>
      <div className="modal-actions">
        <button type="button" className="btn ghost" onClick={onClose} autoFocus>
          Cancel
        </button>
        <button type="button" className="btn primary" onClick={onOpen}>
          Open in browser
        </button>
      </div>
    </Modal>
  )
}

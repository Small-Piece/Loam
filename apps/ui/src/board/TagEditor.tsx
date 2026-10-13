import { useState } from 'react'
import { XIcon } from '../icons.tsx'

interface Props {
  tags: string[]
  onChange: (tags: string[]) => void
}

/** Tag chips with remove buttons; Enter or comma adds the typed tag. */
export function TagEditor({ tags, onChange }: Props) {
  const [draft, setDraft] = useState('')

  function commit() {
    const added = draft
      .split(',')
      .map((tag) => tag.trim())
      .filter((tag) => tag.length > 0)
    setDraft('')
    if (added.length > 0) onChange([...tags, ...added])
  }

  return (
    <div className="tag-editor">
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
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ',') {
            event.preventDefault()
            commit()
          } else if (event.key === 'Backspace' && draft === '' && tags.length > 0) {
            onChange(tags.slice(0, -1))
          }
        }}
        onBlur={commit}
      />
    </div>
  )
}

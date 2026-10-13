import { useState } from 'react'

const NAME_WORDS = 4

/** A short pillar name suggested from the answer: its first few words. */
export function suggestPillarName(answer: string): string {
  const words = answer
    .replace(/[[\]|#]/g, ' ')
    .split(/[\s,.;:!?]+/)
    .filter(Boolean)
  return words.slice(0, NAME_WORDS).join(' ')
}

interface Props {
  /** The full answer and the short name, or null when skipped. */
  onDone: (result: { answer: string; name: string } | null) => void
}

/**
 * After a vault is created: "What should players feel?" in full, then a
 * short name for it. Together they become the first pillar.
 */
export function FirstPillar({ onDone }: Props) {
  const [answer, setAnswer] = useState('')
  const [name, setName] = useState('')
  const [nameTouched, setNameTouched] = useState(false)
  const shownName = nameTouched ? name : suggestPillarName(answer)
  const ready = answer.trim() !== '' && shownName.trim() !== ''

  return (
    <div className="modal-backdrop">
      <form
        className="modal bible-first"
        role="dialog"
        aria-modal="true"
        aria-labelledby="first-title"
        onSubmit={(event) => {
          event.preventDefault()
          if (ready) onDone({ answer: answer.trim(), name: shownName.trim() })
        }}
      >
        <h2 id="first-title" className="modal-title">
          What should players feel?
        </h2>
        <p className="modal-message">
          Describe it in full. It becomes your first pillar: the filter later decisions are checked
          against.
        </p>
        <textarea
          className="bible-first-answer"
          aria-label="What should players feel?"
          autoFocus
          rows={3}
          value={answer}
          placeholder="Wonder at a world that is beautiful and dangerous at the same time."
          onChange={(event) => setAnswer(event.target.value)}
        />
        <label className="bible-field">
          <span className="bible-label">Name it in 2–4 words</span>
          <input
            className="bible-input"
            aria-label="Name it in 2–4 words"
            value={shownName}
            placeholder="Awe before fear"
            onChange={(event) => {
              setNameTouched(true)
              setName(event.target.value)
            }}
          />
        </label>
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={() => onDone(null)}>
            Skip
          </button>
          <button type="submit" className="btn primary" disabled={!ready}>
            Add first pillar
          </button>
        </div>
      </form>
    </div>
  )
}

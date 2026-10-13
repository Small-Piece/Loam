import { useMemo, useState } from 'react'
import type { RequestOf, ResponseOf } from '@loam/protocol'
import { ApiError, call } from '../api.ts'
import { renderMarkdown } from '../bible/markdown.ts'
import { aiReady, useAiStatus } from './useAiStatus.ts'

type Draft = ResponseOf<'journal:recap'>
type Saved = ResponseOf<'journal:saveRecap'>

function messageOf(error: unknown): string {
  return error instanceof ApiError || error instanceof Error ? error.message : String(error)
}

/**
 * "Recap this week" / "Recap this topic": a draft from the user's own session
 * notes, shown here only. Nothing is written until "Save as session note".
 * The button is there only while the local AI helpers are on and ready.
 */
export function RecapPanel({
  vaultId,
  scope,
  label,
  onSaved,
}: {
  vaultId: number
  scope: RequestOf<'journal:recap'>['scope']
  label: string
  onSaved: (saved: Saved) => void
}) {
  const [status] = useAiStatus()
  const [draft, setDraft] = useState<Draft | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const html = useMemo(() => (draft ? renderMarkdown(draft.draft, () => null) : ''), [draft])

  if (!status?.enabled || !status.model.installed) return null
  const ready = aiReady(status)

  async function make() {
    setBusy(true)
    setError(null)
    try {
      setDraft(await call('journal:recap', { vaultId, scope }))
    } catch (problem) {
      setError(messageOf(problem))
    } finally {
      setBusy(false)
    }
  }

  async function save() {
    if (!draft) return
    setBusy(true)
    setError(null)
    try {
      const saved = await call('journal:saveRecap', {
        vaultId,
        title: draft.title,
        text: draft.draft,
        sourceIds: draft.sources.map((source) => source.id),
      })
      setDraft(null)
      onSaved(saved)
    } catch (problem) {
      setError(messageOf(problem))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="recap">
      {!draft && (
        <button
          type="button"
          className="btn"
          disabled={busy || !ready}
          title={ready ? undefined : 'AI is paused'}
          onClick={() => void make()}
        >
          {busy ? 'Writing a draft…' : label}
        </button>
      )}
      {error && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}
      {draft && (
        <section className="recap-draft" aria-label="Recap draft">
          <div className="s-eyebrow">Draft from your notes, not saved</div>
          <div
            className="markdown recap-text"
            data-testid="recap-text"
            // Rendered by marked with raw HTML escaped and link targets checked (markdown.ts).
            dangerouslySetInnerHTML={{ __html: html }}
          />
          <p className="bible-muted recap-sources">
            Built from: {draft.sources.map((source) => source.title).join(', ')}
          </p>
          <div className="settings-actions">
            <button
              type="button"
              className="btn primary"
              disabled={busy}
              onClick={() => void save()}
            >
              Save as session note
            </button>
            <button type="button" className="btn ghost" onClick={() => setDraft(null)}>
              Discard
            </button>
          </div>
        </section>
      )}
    </div>
  )
}

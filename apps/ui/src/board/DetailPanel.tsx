import { useCallback, useEffect, useRef, useState } from 'react'
import {
  assetUrl,
  type BoardSummary,
  type ReferenceDetail,
  type ResponseOf,
  type TagSuggestionData,
} from '@loam/protocol'
import { call, onEvent } from '../api.ts'
import { XIcon } from '../icons.tsx'
import { TagEditor } from './TagEditor.tsx'

interface Props {
  id: number
  boards: BoardSummary[]
  onClose: () => void
  /** Called after a save, so the grid can refresh titles and tags. */
  onSaved: () => void
  onError: (message: string) => void
}

type Patch = {
  title?: string
  note?: string
  source?: string
  tags?: string[]
  boardIds?: number[]
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

/** Full image plus editable fields. Text fields save on blur; tags and boards save at once. */
export function DetailPanel({ id, boards, onClose, onSaved, onError }: Props) {
  const [detail, setDetail] = useState<ReferenceDetail | null>(null)
  const [title, setTitle] = useState('')
  const [note, setNote] = useState('')
  const [source, setSource] = useState('')
  const [uses, setUses] = useState<ResponseOf<'refs:bibleUses'>['uses']>([])
  const [suggestions, setSuggestions] = useState<TagSuggestionData[]>([])
  const reportError = useRef(onError)
  useEffect(() => {
    reportError.current = onError
  })

  // State setters are stable, so show never changes identity.
  const show = useCallback((next: ReferenceDetail | null) => {
    setDetail(next)
    setTitle(next?.title ?? '')
    setNote(next?.note ?? '')
    setSource(next?.source ?? '')
  }, [])

  useEffect(() => {
    let cancelled = false
    call('refs:getDetail', { id })
      .then((response) => {
        if (cancelled) return
        show(response.detail)
        setSuggestions(response.suggestions)
      })
      .catch((error: unknown) => reportError.current(String(error)))
    call('refs:bibleUses', { id })
      .then((response) => {
        if (!cancelled) setUses(response.uses)
      })
      .catch((error: unknown) => reportError.current(String(error)))
    return () => {
      cancelled = true
    }
  }, [id, show])

  // Suggestions for this image may arrive while it is open (the queue runs in the background).
  useEffect(() => {
    let live = true
    let done = -1
    const stop = onEvent('ai:status', (status) => {
      if (status.queue.done === done) return
      done = status.queue.done
      call('refs:getDetail', { id })
        .then((response) => {
          if (live) setSuggestions(response.suggestions)
        })
        .catch(() => undefined)
    })
    return () => {
      live = false
      stop()
    }
  }, [id])

  async function accept(tags: string[]) {
    try {
      const response = await call('refs:acceptSuggestions', { id, tags })
      show(response.detail)
      setSuggestions(response.suggestions)
      onSaved()
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    }
  }

  async function reject(tag: string) {
    try {
      setSuggestions((await call('refs:rejectSuggestion', { id, tag })).suggestions)
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    }
  }

  async function save(patch: Patch) {
    try {
      const response = await call('refs:update', { id, ...patch })
      show(response.detail)
      onSaved()
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
      // Restore the stored values so the form never shows unsaved text as saved.
      if (detail) show(detail)
    }
  }

  if (!detail) {
    return (
      <aside className="detail" aria-label="Reference detail">
        <div className="detail-loading">Loading…</div>
      </aside>
    )
  }

  const { boardIds } = detail
  return (
    <aside className="detail" aria-label="Reference detail">
      <div className="detail-image">
        <img
          src={assetUrl(detail.imageHash)}
          width={detail.imageWidth}
          height={detail.imageHeight}
          alt={detail.title}
          draggable={false}
        />
        <button type="button" className="detail-close" aria-label="Close detail" onClick={onClose}>
          <XIcon size={12} />
        </button>
      </div>

      <div className="detail-body">
        <label className="field">
          <span className="f-lbl">Title</span>
          <input
            className="text-input detail-title"
            value={title}
            maxLength={200}
            onChange={(event) => setTitle(event.target.value)}
            onBlur={() => {
              if (title.trim() === '') setTitle(detail.title)
              else if (title !== detail.title) void save({ title })
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur()
            }}
          />
        </label>

        <label className="field">
          <span className="f-lbl">Note</span>
          <textarea
            className="text-input"
            value={note}
            maxLength={20_000}
            placeholder="What to study in this image…"
            onChange={(event) => setNote(event.target.value)}
            onBlur={() => {
              if (note !== detail.note) void save({ note })
            }}
          />
        </label>

        <div className="field">
          <span className="f-lbl">Tags</span>
          <TagEditor tags={detail.tags} onChange={(tags) => void save({ tags })} />
          {suggestions.length > 0 && (
            <div className="suggested-tags" role="group" aria-label="Suggested tags">
              {suggestions.map((item) => (
                <span key={item.tag} className="suggested-chip" data-testid="suggested-tag">
                  <button
                    type="button"
                    className="suggested-accept"
                    aria-label={'Accept tag ' + item.tag}
                    title={
                      'Suggested by the local model (' +
                      String(Math.round(item.confidence * 100)) +
                      ' %). Click to add.'
                    }
                    onClick={() => void accept([item.tag])}
                  >
                    {item.tag}
                  </button>
                  <button
                    type="button"
                    className="suggested-reject"
                    aria-label={'Reject tag ' + item.tag}
                    onClick={() => void reject(item.tag)}
                  >
                    <XIcon size={10} />
                  </button>
                </span>
              ))}
              <button
                type="button"
                className="btn ghost suggested-all"
                onClick={() => void accept(suggestions.map((item) => item.tag))}
              >
                Accept all
              </button>
            </div>
          )}
        </div>

        <label className="field">
          <span className="f-lbl">Source</span>
          <input
            className="text-input"
            value={source}
            maxLength={2_000}
            placeholder="Artbook p.12, artist name…"
            onChange={(event) => setSource(event.target.value)}
            onBlur={() => {
              if (source !== detail.source) void save({ source })
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur()
            }}
          />
        </label>

        <div className="field">
          <span className="f-lbl">Boards</span>
          {boards.length === 0 ? (
            <span className="field-hint">Create a board in the sidebar to collect references.</span>
          ) : (
            <div className="board-checks">
              {boards.map((board) => (
                <label key={board.id} className="board-check">
                  <input
                    type="checkbox"
                    checked={boardIds.includes(board.id)}
                    onChange={(event) =>
                      void save({
                        boardIds: event.target.checked
                          ? [...boardIds, board.id]
                          : boardIds.filter((boardId) => boardId !== board.id),
                      })
                    }
                  />
                  {board.name}
                </label>
              ))}
            </div>
          )}
        </div>

        {uses.length > 0 && (
          <div className="field" data-testid="bible-uses">
            <span className="f-lbl">Used in bible</span>
            <ul className="bible-uses">
              {uses.map((use) => (
                <li key={`${use.vaultPath}/${use.path}`} title={`${use.vaultPath}/${use.path}`}>
                  {use.title} <span className="field-hint">· {use.vaultTitle}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <dl className="detail-meta mono">
          <dt>Added</dt>
          <dd>{formatDate(detail.createdAt)}</dd>
          <dt>Image</dt>
          <dd>
            {detail.imageWidth} × {detail.imageHeight} ·{' '}
            {detail.imageMime.replace('image/', '').toUpperCase()} ·{' '}
            {formatBytes(detail.imageBytes)}
          </dd>
        </dl>
      </div>
    </aside>
  )
}

import { useEffect, useRef, useState } from 'react'
import type { TopicProgressData } from '@loam/protocol'
import { RecapPanel } from '../ai/RecapPanel.tsx'
import { ApiError, call } from '../api.ts'
import { vaultImageUrl } from '../bible/markdown.ts'
import { dayName } from './calendar.ts'

type Image = TopicProgressData['images'][number]

function messageOf(error: unknown): string {
  return error instanceof ApiError || error instanceof Error ? error.message : String(error)
}

const imageKey = (image: Image) => `${image.session.path}|${image.asset}`

function Caption({ image }: { image: Image }) {
  return (
    <span className="practice-caption">
      <span className="mono">{image.session.date ?? 'no date'}</span> {image.session.title}
    </span>
  )
}

const STATUS_ORDER = ['in progress', 'to watch', 'done'] as const

/**
 * A topic's progress: every practice image from its sessions, oldest to
 * newest; Compare puts two of them side by side at the same height.
 */
export function TopicProgress({
  vaultId,
  path,
  refreshKey,
  onOpen,
  onExternal,
  onError,
}: {
  vaultId: number
  path: string
  /** Changes whenever the vault changed, so the page reloads. */
  refreshKey: number
  onOpen: (path: string) => void
  onExternal: (url: string) => void
  onError: (message: string) => void
}) {
  const [data, setData] = useState<TopicProgressData | null>(null)
  const [comparing, setComparing] = useState(false)
  const [chosen, setChosen] = useState<string[]>([])
  const errorRef = useRef(onError)
  useEffect(() => {
    errorRef.current = onError
  })

  useEffect(() => {
    // refreshKey goes up whenever the vault changed on disk: ask again.
    if (refreshKey < 0) return
    let live = true
    call('journal:topic', { vaultId, path })
      .then((result) => {
        if (live) setData(result)
      })
      .catch((error: unknown) => {
        if (live) errorRef.current(messageOf(error))
      })
    return () => {
      live = false
    }
  }, [vaultId, path, refreshKey])

  if (!data) return <div className="bible-editor-empty">Loading…</div>

  function choose(image: Image) {
    const key = imageKey(image)
    setChosen((current) => {
      if (current.includes(key)) return current.filter((item) => item !== key)
      // Two at a time: a third pick replaces the older one.
      return [...current, key].slice(-2)
    })
  }

  const picked = chosen
    .map((key) => data.images.find((image) => imageKey(image) === key))
    .filter((image): image is Image => image !== undefined)
    .sort((a, b) => data.images.indexOf(a) - data.images.indexOf(b))

  return (
    <div className="topic-progress" data-testid="topic-progress">
      <section className="progress-block" aria-label="Practice images">
        <header className="progress-head">
          <div className="s-eyebrow">Practice images</div>
          {data.images.length >= 2 && (
            <button
              type="button"
              className={'btn ghost' + (comparing ? ' active' : '')}
              aria-pressed={comparing}
              onClick={() => {
                setComparing((on) => !on)
                setChosen([])
              }}
            >
              Compare
            </button>
          )}
        </header>
        {comparing && (
          <p className="bible-muted">
            {picked.length < 2 ? 'Pick two images to put side by side.' : 'Pick another to swap.'}
          </p>
        )}
        {data.images.length === 0 ? (
          <p className="bible-muted">
            Images dropped on this topic&apos;s sessions show here, oldest first.
          </p>
        ) : (
          <ol className="practice-strip">
            {data.images.map((image) => {
              const key = imageKey(image)
              const on = chosen.includes(key)
              return (
                <li key={key} className={'practice-item' + (on ? ' chosen' : '')}>
                  {comparing ? (
                    <button
                      type="button"
                      className="practice-pick"
                      aria-pressed={on}
                      aria-label={`Compare image from ${image.session.title}`}
                      onClick={() => choose(image)}
                    >
                      <img src={vaultImageUrl(image.asset, 'journal')} alt="" draggable={false} />
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="practice-pick"
                      aria-label={`Open ${image.session.title}`}
                      onClick={() => onOpen(image.session.path)}
                    >
                      <img src={vaultImageUrl(image.asset, 'journal')} alt="" draggable={false} />
                    </button>
                  )}
                  <Caption image={image} />
                </li>
              )
            })}
          </ol>
        )}
        {comparing && picked.length === 2 && (
          <div className="compare-view" data-testid="compare-view">
            {picked.map((image) => (
              <figure key={imageKey(image)} className="compare-side">
                <img src={vaultImageUrl(image.asset, 'journal')} alt={image.session.title} />
                <figcaption>
                  <span className="mono">
                    {image.session.date ? dayName(image.session.date) : 'no date'}
                  </span>{' '}
                  · {image.session.title}
                </figcaption>
              </figure>
            ))}
          </div>
        )}
      </section>

      <section className="progress-block" aria-label="Sessions on this topic">
        <div className="s-eyebrow">Sessions</div>
        <RecapPanel
          vaultId={vaultId}
          scope={{ kind: 'topic', path }}
          label="Recap this topic"
          onSaved={(saved) => onOpen(saved.entry.path)}
        />
        {data.sessions.length === 0 ? (
          <p className="bible-muted">Sessions that name this topic show here, newest first.</p>
        ) : (
          <ul className="journal-list">
            {data.sessions.map((session) => (
              <li key={session.path}>
                <span className="mono bible-muted">{session.date ?? 'no date'}</span>{' '}
                <button
                  type="button"
                  className="bible-link-button"
                  onClick={() => onOpen(session.path)}
                >
                  {session.title}
                </button>
                {session.minutes !== null && (
                  <span className="bible-muted"> · {session.minutes} min</span>
                )}
              </li>
            ))}
          </ul>
        )}
        {data.minutes !== null && (
          <p className="bible-muted" data-testid="topic-minutes">
            {data.minutes} minutes logged on this topic.
          </p>
        )}
      </section>

      <section className="progress-block" aria-label="Resources for this topic">
        <div className="s-eyebrow">Resources</div>
        {data.resources.length === 0 ? (
          <p className="bible-muted">Resources that name this topic show here.</p>
        ) : (
          [...STATUS_ORDER, null].map((status) => {
            const items = data.resources.filter((item) =>
              status === null
                ? !(STATUS_ORDER as readonly (string | null)[]).includes(item.status)
                : item.status === status,
            )
            if (items.length === 0) return null
            return (
              <div key={status ?? 'none'} className="topic-resources">
                <span className="trash-kind">{status ?? 'no status'}</span>
                {items.map((item) => (
                  <span key={item.path} className="topic-resource">
                    <button
                      type="button"
                      className="bible-link-button"
                      onClick={() => onOpen(item.path)}
                    >
                      {item.title}
                    </button>
                    {item.url && /^https?:\/\//i.test(item.url) && (
                      <button
                        type="button"
                        className="bible-link-button resource-url"
                        aria-label={`Open link for ${item.title}`}
                        title={item.url}
                        onClick={() => onExternal(item.url ?? '')}
                      >
                        ↗
                      </button>
                    )}
                  </span>
                ))}
              </div>
            )
          })
        )}
      </section>
    </div>
  )
}

import { useEffect, useState } from 'react'
import type { ResponseOf } from '@loam/protocol'
import { ApiError, call } from './api.ts'

type About = ResponseOf<'app:about'>

function messageOf(error: unknown): string {
  return error instanceof ApiError || error instanceof Error ? error.message : String(error)
}

/**
 * The About dialog: version, license, links, where the data lives, where the
 * old UnrealManager folder is, and the third-party notices.
 */
export function AboutDialog({ onClose }: { onClose: () => void }) {
  const [about, setAbout] = useState<About | null>(null)
  const [notices, setNotices] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    call('app:about', {}).then(setAbout, (problem: unknown) => setError(messageOf(problem)))
  }, [])

  function open(url: string) {
    call('app:openExternal', { url }).catch((problem: unknown) => setError(messageOf(problem)))
  }

  function showNotices() {
    call('app:notices', {}).then(
      (reply) => setNotices(reply.text),
      (problem: unknown) => setError(messageOf(problem)),
    )
  }

  const migration = about?.migration
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className={'modal about-dialog' + (notices === null ? '' : ' wide')}
        role="dialog"
        aria-modal="true"
        aria-label="About Loam"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onClose()
        }}
      >
        <h2 className="modal-title">{about ? `${about.name} ${about.version}` : 'Loam'}</h2>
        {error ? <p className="bible-error">{error}</p> : null}
        {about && notices === null ? (
          <>
            <p className="modal-message" data-testid="about-license">
              Free and open-source software under the {about.license} License.
            </p>
            <p className="modal-message">
              Your library, boards and settings are stored in{' '}
              <span className="mono" data-testid="about-data-folder">
                {about.dataFolder}
              </span>
              .
            </p>
            {migration && migration.oldFolderExists ? (
              <p className="modal-message" data-testid="about-migration">
                Your data was copied from UnrealManager on{' '}
                {new Date(migration.migratedAt).toLocaleDateString()} ({migration.references}{' '}
                references). The old folder is still at{' '}
                <span className="mono">{migration.from}</span>. Loam never changes or deletes it;
                once everything here looks right, you can delete it by hand.
              </p>
            ) : null}
            <div className="about-links">
              <button type="button" className="btn ghost" onClick={() => open(about.websiteUrl)}>
                Website
              </button>
              <button type="button" className="btn ghost" onClick={() => open(about.repositoryUrl)}>
                Source code
              </button>
              <button type="button" className="btn ghost" onClick={showNotices}>
                Third-party notices
              </button>
            </div>
          </>
        ) : null}
        {notices !== null ? (
          <pre className="about-notices" data-testid="about-notices" tabIndex={0}>
            {notices}
          </pre>
        ) : null}
        <div className="modal-actions">
          {notices !== null ? (
            <button type="button" className="btn ghost" onClick={() => setNotices(null)}>
              Back
            </button>
          ) : null}
          <button type="button" className="btn primary" onClick={onClose} autoFocus>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

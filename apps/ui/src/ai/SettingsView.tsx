import { useState } from 'react'
import type { AiStatusData } from '@loam/protocol'
import { ApiError, call } from '../api.ts'
import { XIcon } from '../icons.tsx'
import { AiProgressLine } from './AiProgress.tsx'
import { formatBytes } from './progress.ts'
import { useAiStatus } from './useAiStatus.ts'

function messageOf(error: unknown): string {
  return error instanceof ApiError || error instanceof Error ? error.message : String(error)
}

/** Shows exactly what Download fetches before anything leaves the machine. */
function DownloadDialog({
  status,
  onStart,
  onClose,
}: {
  status: AiStatusData
  onStart: () => void
  onClose: () => void
}) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Download the model"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onClose()
        }}
      >
        <h2 className="modal-title">Download the model?</h2>
        <p className="modal-message">
          This is the first time the app goes online. It downloads these files (
          {formatBytes(status.model.totalBytes)} in all) into the app&apos;s models folder and
          checks each one against a checksum built into the app. Nothing of yours is sent.
        </p>
        <ul className="download-urls" data-testid="download-urls">
          {status.model.files.map((file) => (
            <li key={file.name}>
              <span className="mono">{file.url}</span>{' '}
              <span className="bible-muted">({formatBytes(file.size)})</span>
            </li>
          ))}
        </ul>
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onClose} autoFocus>
            Cancel
          </button>
          <button type="button" className="btn primary" onClick={onStart}>
            Download
          </button>
        </div>
      </div>
    </div>
  )
}

/** The Settings workspace: for now, the local AI helpers. */
export function SettingsView() {
  const [status, setStatus] = useAiStatus()
  const [asking, setAsking] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [newApp, setNewApp] = useState('')
  const [error, setError] = useState<string | null>(null)

  async function run(work: () => Promise<AiStatusData>) {
    setError(null)
    try {
      setStatus(await work())
    } catch (problem) {
      setError(messageOf(problem))
    }
  }

  if (!status) return <div className="bible-editor-empty">Loading…</div>
  const { model } = status
  const download = model.download
  const downloading = download.state === 'downloading' || download.state === 'verifying'
  const partial = !model.installed && download.received > 0 && !downloading

  function addApp() {
    const app = newApp.trim()
    setNewApp('')
    if (app === '' || !status) return
    void run(() => call('ai:setPauseApps', { apps: [...status.pauseApps, app] }))
  }

  return (
    <div className="bible-home settings-view">
      <div className="bible-home-inner">
        <header className="bible-home-head">
          <div>
            <div className="s-eyebrow">Settings</div>
            <h1 className="board-title">Settings</h1>
          </div>
        </header>

        {error && (
          <div className="bible-banner" role="alert">
            {error}
          </div>
        )}

        <section className="bible-card" aria-label="Local AI helpers">
          <div className="settings-row">
            <div>
              <h2>Local AI helpers</h2>
              <p className="bible-muted">
                Small helpers that run on this computer only: tag suggestions for Library images and
                recaps of your study sessions. Nothing is applied without you, and nothing leaves
                this machine.
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={status.enabled}
              aria-label="Local AI helpers"
              className={'switch' + (status.enabled ? ' on' : '')}
              onClick={() => void run(() => call('ai:setEnabled', { enabled: !status.enabled }))}
            >
              <span className="switch-knob" />
            </button>
          </div>
          {status.enabled && !model.installed && (
            <p className="bible-muted">Download the model below to start.</p>
          )}
          <AiProgressLine status={status} onStatus={setStatus} />
        </section>

        <section className="bible-card" aria-label="Model">
          <h2>Model</h2>
          <dl className="settings-facts">
            <dt>Model</dt>
            <dd data-testid="model-name">{model.name}</dd>
            <dt>Size</dt>
            <dd>{formatBytes(model.totalBytes)}</dd>
            <dt>License</dt>
            <dd>
              {model.license} (model); {model.runtimeLicense} (runtime)
            </dd>
            <dt>Status</dt>
            <dd data-testid="model-status">
              {model.installed
                ? 'Downloaded'
                : downloading
                  ? `Downloading: ${formatBytes(download.received)} of ${formatBytes(download.total)}`
                  : partial
                    ? `Paused: ${formatBytes(download.received)} of ${formatBytes(download.total)}`
                    : 'Not downloaded'}
            </dd>
          </dl>
          {downloading && (
            <progress
              className="settings-progress"
              aria-label="Download progress"
              value={download.received}
              max={download.total}
            />
          )}
          {download.error && (
            <p className="settings-error" role="alert" data-testid="download-error">
              {download.error}
            </p>
          )}
          <div className="settings-actions">
            {!model.installed && !downloading && (
              <button type="button" className="btn primary" onClick={() => setAsking(true)}>
                {partial ? 'Resume download' : 'Download'}
              </button>
            )}
            {downloading && (
              <button
                type="button"
                className="btn"
                onClick={() => void run(() => call('ai:cancelDownload', {}))}
              >
                Cancel download
              </button>
            )}
            {(model.installed || partial) && (
              <button type="button" className="btn ghost" onClick={() => setConfirmDelete(true)}>
                Delete model
              </button>
            )}
          </div>
        </section>

        <section className="bible-card" aria-label="Pausing">
          <h2>Pause AI while these apps run</h2>
          <p className="bible-muted">
            While one of these programs runs, the helpers stop and free the graphics memory.
          </p>
          <ul className="pause-apps" aria-label="Apps that pause AI">
            {status.pauseApps.map((app) => (
              <li key={app} className="chip">
                {app}
                <button
                  type="button"
                  aria-label={`Remove ${app}`}
                  onClick={() =>
                    void run(() =>
                      call('ai:setPauseApps', {
                        apps: status.pauseApps.filter((other) => other !== app),
                      }),
                    )
                  }
                >
                  <XIcon size={10} />
                </button>
              </li>
            ))}
          </ul>
          <form
            className="pause-add"
            onSubmit={(event) => {
              event.preventDefault()
              addApp()
            }}
          >
            <input
              className="bible-input"
              aria-label="Add a program"
              placeholder="Program file name, e.g. Blender.exe"
              value={newApp}
              onChange={(event) => setNewApp(event.target.value)}
            />
            <button type="submit" className="btn">
              Add
            </button>
          </form>
          <div className="settings-actions">
            <button
              type="button"
              className="btn"
              onClick={() => void run(() => call('ai:setPaused', { paused: !status.paused }))}
            >
              {status.paused ? 'Resume AI' : 'Pause AI'}
            </button>
          </div>
        </section>
      </div>

      {asking && (
        <DownloadDialog
          status={status}
          onClose={() => setAsking(false)}
          onStart={() => {
            setAsking(false)
            void run(() => call('ai:download', {}))
          }}
        />
      )}
      {confirmDelete && (
        <div className="modal-backdrop" onClick={() => setConfirmDelete(false)}>
          <div
            className="modal"
            role="alertdialog"
            aria-modal="true"
            aria-label="Delete the model"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 className="modal-title">Delete the model?</h2>
            <p className="modal-message">
              This frees {formatBytes(model.totalBytes)}. Suggestions you already have stay.
            </p>
            <div className="modal-actions">
              <button
                type="button"
                className="btn ghost"
                onClick={() => setConfirmDelete(false)}
                autoFocus
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn primary"
                onClick={() => {
                  setConfirmDelete(false)
                  void run(() => call('ai:deleteModel', {}))
                }}
              >
                Delete model
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

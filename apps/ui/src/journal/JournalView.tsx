import { useEffect, useState } from 'react'
import type { ResponseOf, VaultViewData } from '@loam/protocol'
import { ApiError, call } from '../api.ts'
import { VaultScreen } from '../bible/VaultScreen.tsx'

type Home = ResponseOf<'journal:home'>

function messageOf(error: unknown): string {
  return error instanceof ApiError || error instanceof Error ? error.message : String(error)
}

/** No journal yet (or changing folders): create one, or open an existing journal folder. */
function JournalHome({
  home,
  canGoBack,
  onBack,
  onOpened,
}: {
  home: Home
  canGoBack: boolean
  onBack: () => void
  onOpened: (view: VaultViewData) => void
}) {
  const [folder, setFolder] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(home.problem)

  async function run(work: () => Promise<void>) {
    setBusy(true)
    setError(null)
    try {
      await work()
    } catch (problem) {
      setError(messageOf(problem))
    } finally {
      setBusy(false)
    }
  }

  const chooseFolder = () =>
    run(async () => {
      const picked = await call('bible:pickFolder', { purpose: 'create' })
      if (picked.path !== null) setFolder(picked.path)
    })

  const create = () =>
    run(async () => {
      onOpened(await call('journal:create', { folder: folder ?? home.suggestedFolder }))
    })

  const openPicked = () =>
    run(async () => {
      const picked = await call('bible:pickFolder', { purpose: 'open' })
      if (picked.path !== null) onOpened(await call('journal:open', { path: picked.path }))
    })

  return (
    <div className="bible-home">
      <div className="bible-home-inner">
        <header className="bible-home-head">
          <div>
            <div className="s-eyebrow">Study journal</div>
            <h1 className="board-title">A record of what you study</h1>
            <p className="bible-muted">
              Sessions, the topics they serve and the resources you learn from, as plain Markdown
              files in a folder you own. Practice images stay next to them.
            </p>
          </div>
          {canGoBack && (
            <button type="button" className="btn ghost" onClick={onBack}>
              Back to the journal
            </button>
          )}
        </header>

        {error && (
          <div className="bible-banner" role="alert">
            {error}
          </div>
        )}

        <section className="bible-card" aria-labelledby="new-journal">
          <h2 id="new-journal">New journal</h2>
          <div className="bible-field">
            <span className="bible-label">Folder</span>
            <div className="bible-folder-row">
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => void chooseFolder()}
              >
                Choose folder…
              </button>
              <span className="mono bible-folder" data-testid="journal-folder">
                {folder ?? home.suggestedFolder}
              </span>
            </div>
            <span className="bible-muted">An empty or new folder. Any folder works.</span>
          </div>
          <button
            type="button"
            className="btn primary"
            disabled={busy}
            onClick={() => void create()}
          >
            Create journal
          </button>
        </section>

        <section className="bible-card" aria-labelledby="open-journal">
          <h2 id="open-journal">Open journal</h2>
          <p className="bible-muted">A journal folder from before, or from another computer.</p>
          <button type="button" className="btn" disabled={busy} onClick={() => void openPicked()}>
            Open folder…
          </button>
        </section>
      </div>
    </div>
  )
}

/** The Journal workspace: reopens the journal, or offers to create or open one. */
export function JournalView() {
  const [home, setHome] = useState<Home | null>(null)
  const [vault, setVault] = useState<VaultViewData | null>(null)
  const [changing, setChanging] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    call('journal:home', {})
      .then((next) => {
        if (!live) return
        setHome(next)
        if (next.current) setVault(next.current)
      })
      .catch((problem: unknown) => {
        if (live) setError(messageOf(problem))
      })
    return () => {
      live = false
    }
  }, [])

  if (error) return <div className="bible-editor-empty">{error}</div>
  if (!home) return <div className="bible-editor-empty">Loading…</div>

  if (vault && !changing) {
    return (
      <VaultScreen
        key={vault.vault.id}
        initial={vault}
        firstRun={false}
        onSwitch={() => setChanging(true)}
      />
    )
  }
  return (
    <JournalHome
      home={home}
      canGoBack={vault !== null}
      onBack={() => setChanging(false)}
      onOpened={(view) => {
        setVault(view)
        setChanging(false)
      }}
    />
  )
}

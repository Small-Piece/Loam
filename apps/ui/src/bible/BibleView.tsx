import { useCallback, useEffect, useState } from 'react'
import type { ResponseOf, VaultViewData } from '@loam/protocol'
import { ApiError, call } from '../api.ts'
import { VaultScreen } from './VaultScreen.tsx'

type Home = ResponseOf<'bible:home'>

function messageOf(error: unknown): string {
  return error instanceof ApiError || error instanceof Error ? error.message : String(error)
}

function folderName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? ''
}

interface HomeProps {
  home: Home
  canGoBack: boolean
  onBack: () => void
  onOpened: (view: VaultViewData, created: boolean) => void
}

/** No vault open (or switching): create a new bible, open one, or pick a recent one. */
function BibleHome({ home, canGoBack, onBack, onOpened }: HomeProps) {
  const [folder, setFolder] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [kit, setKit] = useState(home.kits[0]?.id ?? '')
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
      if (picked.path === null) return
      setFolder(picked.path)
      if (!title.trim()) setTitle(folderName(picked.path))
    })

  const create = () =>
    run(async () => {
      if (!folder) return
      onOpened(await call('bible:create', { folder, kitId: kit, title: title.trim() }), true)
    })

  const openPicked = () =>
    run(async () => {
      const picked = await call('bible:pickFolder', { purpose: 'open' })
      if (picked.path !== null) onOpened(await call('bible:open', { path: picked.path }), false)
    })

  const openRecent = (path: string) =>
    run(async () => onOpened(await call('bible:open', { path }), false))

  const openSample = () =>
    run(async () => {
      const picked = await call('bible:pickFolder', { purpose: 'sample' })
      if (picked.path !== null) {
        onOpened(await call('bible:openSample', { folder: picked.path }), false)
      }
    })

  const selectedKit = home.kits.find((candidate) => candidate.id === kit)

  return (
    <div className="bible-home">
      <div className="bible-home-inner">
        <header className="bible-home-head">
          <div>
            <div className="s-eyebrow">Creative bible</div>
            <h1 className="board-title">A living record of what your game is meant to be</h1>
            <p className="bible-muted">
              Plain Markdown files in your game&apos;s folder: version them with git, share them
              with your team, and let coding agents read them.
            </p>
          </div>
          {canGoBack && (
            <button type="button" className="btn ghost" onClick={onBack}>
              Back to the open bible
            </button>
          )}
        </header>

        {error && (
          <div className="bible-banner" role="alert">
            {error}
          </div>
        )}

        <section className="bible-card" aria-labelledby="new-bible">
          <h2 id="new-bible">New bible</h2>
          <div className="bible-field">
            <span className="bible-label">Game project folder</span>
            <div className="bible-folder-row">
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => void chooseFolder()}
              >
                Choose folder…
              </button>
              <span className="mono bible-folder" data-testid="chosen-folder">
                {folder
                  ? `${folder}${folder.includes('\\') ? '\\' : '/'}bible`
                  : 'A bible folder is created inside it'}
              </span>
            </div>
          </div>
          <label className="bible-field">
            <span className="bible-label">Title</span>
            <input
              className="bible-input"
              aria-label="Bible title"
              value={title}
              placeholder="My game"
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <fieldset className="bible-kits">
            <legend className="bible-label">Starter kit</legend>
            {home.kits.map((candidate) => (
              <label
                key={candidate.id}
                className={'bible-kit' + (candidate.id === kit ? ' active' : '')}
              >
                <input
                  type="radio"
                  name="kit"
                  value={candidate.id}
                  checked={candidate.id === kit}
                  onChange={() => setKit(candidate.id)}
                />
                <span className="bible-kit-name">{candidate.name}</span>
                <span className="bible-kit-text">{candidate.description}</span>
              </label>
            ))}
          </fieldset>
          {selectedKit && (
            <p className="bible-muted" data-testid="kit-sections">
              Sections: {selectedKit.sections.map((section) => section.name).join(', ')}
            </p>
          )}
          <button
            type="button"
            className="btn primary"
            disabled={busy || !folder || !title.trim() || !kit}
            onClick={() => void create()}
          >
            Create bible
          </button>
        </section>

        <section className="bible-card" aria-labelledby="open-bible">
          <h2 id="open-bible">Open bible</h2>
          <button type="button" className="btn" disabled={busy} onClick={() => void openPicked()}>
            Open folder…
          </button>
          {home.recent.length > 0 && (
            <ul className="bible-recent" aria-label="Recent bibles">
              {home.recent.map((recent) => (
                <li key={recent.id}>
                  <button
                    type="button"
                    className="bible-recent-item"
                    disabled={busy || !recent.exists}
                    onClick={() => void openRecent(recent.path)}
                  >
                    <span>{recent.title}</span>
                    <span className="mono bible-muted">
                      {recent.path}
                      {recent.exists ? '' : ' (missing)'}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="bible-card" aria-labelledby="sample-bible">
          <h2 id="sample-bible">Try the sample</h2>
          <p className="bible-muted">
            &ldquo;The Lantern Coast&rdquo; is a small, original horror bible with pillars, places,
            creatures, decisions and ideas. It is copied into a bible folder inside the folder you
            choose, so you can change it freely.
          </p>
          <button type="button" className="btn" disabled={busy} onClick={() => void openSample()}>
            Open the sample bible
          </button>
        </section>
      </div>
    </div>
  )
}

/** The Bible workspace: reopens the last vault, or shows the start screen. */
export function BibleView() {
  const [home, setHome] = useState<Home | null>(null)
  const [vault, setVault] = useState<{ view: VaultViewData; firstRun: boolean } | null>(null)
  const [switching, setSwitching] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadHome = useCallback(async () => {
    try {
      const next = await call('bible:home', {})
      setHome(next)
      return next
    } catch (problem) {
      setError(messageOf(problem))
      return null
    }
  }, [])

  // On first show: reopen the last vault, or offer to create or open one.
  useEffect(() => {
    let live = true
    call('bible:home', {})
      .then((next) => {
        if (!live) return
        setHome(next)
        if (next.current) setVault({ view: next.current, firstRun: false })
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

  if (vault && !switching) {
    return (
      <VaultScreen
        key={vault.view.vault.id}
        initial={vault.view}
        firstRun={vault.firstRun}
        onSwitch={() => {
          void loadHome()
          setSwitching(true)
        }}
      />
    )
  }
  return (
    <BibleHome
      home={home}
      canGoBack={vault !== null}
      onBack={() => setSwitching(false)}
      onOpened={(view, created) => {
        setVault({ view, firstRun: created })
        setSwitching(false)
      }}
    />
  )
}

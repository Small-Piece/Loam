import { useState } from 'react'
import { BibleView } from './bible/BibleView.tsx'
import { ReferenceBoard } from './board/ReferenceBoard.tsx'
import { SettingsView } from './ai/SettingsView.tsx'
import { AboutDialog } from './AboutDialog.tsx'
import { BookIcon, CalendarIcon, GearIcon, ImageIcon, InfoIcon } from './icons.tsx'
import { JournalView } from './journal/JournalView.tsx'

type Workspace = 'library' | 'bible' | 'journal' | 'settings'
const WORKSPACE_KEY = 'loam.workspace'

function readWorkspace(): Workspace {
  try {
    const saved = localStorage.getItem(WORKSPACE_KEY)
    return saved === 'bible' || saved === 'journal' || saved === 'settings' ? saved : 'library'
  } catch {
    return 'library'
  }
}

/** The top-level switch between the Library (references and boards), the Bible and the Journal. */
export function App() {
  const [workspace, setWorkspace] = useState<Workspace>(readWorkspace)
  const [showAbout, setShowAbout] = useState(false)

  function choose(next: Workspace) {
    setWorkspace(next)
    try {
      localStorage.setItem(WORKSPACE_KEY, next)
    } catch {
      // Not remembered; harmless.
    }
  }

  return (
    <div className="app-shell">
      <nav className="app-rail" aria-label="Workspace">
        <button
          type="button"
          className={'rail-button' + (workspace === 'library' ? ' active' : '')}
          aria-pressed={workspace === 'library'}
          aria-label="Library"
          title="Library and boards"
          onClick={() => choose('library')}
        >
          <ImageIcon size={18} />
        </button>
        <button
          type="button"
          className={'rail-button' + (workspace === 'bible' ? ' active' : '')}
          aria-pressed={workspace === 'bible'}
          aria-label="Bible"
          title="Creative bible"
          onClick={() => choose('bible')}
        >
          <BookIcon size={18} />
        </button>
        <button
          type="button"
          className={'rail-button' + (workspace === 'journal' ? ' active' : '')}
          aria-pressed={workspace === 'journal'}
          aria-label="Journal"
          title="Study journal"
          onClick={() => choose('journal')}
        >
          <CalendarIcon size={18} />
        </button>
        <button
          type="button"
          className="rail-button rail-bottom"
          aria-label="About Loam"
          title="About Loam"
          onClick={() => setShowAbout(true)}
        >
          <InfoIcon size={18} />
        </button>
        <button
          type="button"
          className={'rail-button' + (workspace === 'settings' ? ' active' : '')}
          aria-pressed={workspace === 'settings'}
          aria-label="Settings"
          title="Settings"
          onClick={() => choose('settings')}
        >
          <GearIcon size={18} />
        </button>
      </nav>
      {/* One workspace at a time: each has its own keyboard shortcuts. */}
      <div className="app-workspace">
        {workspace === 'library' ? (
          <ReferenceBoard />
        ) : workspace === 'bible' ? (
          <BibleView />
        ) : workspace === 'journal' ? (
          <JournalView />
        ) : (
          <SettingsView />
        )}
      </div>
      {showAbout ? <AboutDialog onClose={() => setShowAbout(false)} /> : null}
    </div>
  )
}

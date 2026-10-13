import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type RefObject,
} from 'react'
import type { EntryViewData, FieldValueData, SaveResultData } from '@loam/protocol'
import { ApiError, call } from '../api.ts'
import { LIBRARY_DRAG_TYPE } from '../canvas/CanvasBoard.tsx'
import { LibraryPanel } from '../canvas/LibraryPanel.tsx'
import { ImageIcon, PencilIcon } from '../icons.tsx'
import { prepareImages } from '../board/images.ts'
import type { IncomingFile } from '../board/useImageIntake.ts'
import { PracticeIntake } from '../journal/PracticeIntake.tsx'
import { TopicProgress } from '../journal/TopicProgress.tsx'
import { EntryMenu, type EntryAction } from './EntryMenu.tsx'
import { PropertiesPanel, type PickableEntry } from './PropertiesPanel.tsx'
import { caretPosition, completeLink, openLinkQuery, rankTitles } from './linkComplete.ts'
import { renderMarkdown, titleKey } from './markdown.ts'

/** Autosave this long after the last keystroke. */
export const AUTOSAVE_MS = 500
const COMPLETE_LIMIT = 8
const VIEW_KEY = 'loam.bible.editorView'

type EditorView = 'split' | 'text' | 'preview'
type Conflict = { kind: 'changed'; theirs: EntryViewData } | { kind: 'gone' }

interface Completion {
  start: number
  items: string[]
  index: number
  left: number
  top: number
}

interface Props {
  vaultId: number
  path: string
  sectionId: string
  sectionName: string
  sections: ReadonlyArray<{ id: string; name: string }>
  /** Every entry in the vault: link targets, autocomplete and entry fields. */
  entries: readonly PickableEntry[]
  tagOptions: readonly string[]
  canMoveUp: boolean
  canMoveDown: boolean
  /** Goes up by one each time this entry's file changed on disk. */
  diskTick: number
  /** Set to a function that saves pending edits, so actions elsewhere can wait for it. */
  flushRef: RefObject<(() => Promise<void>) | null>
  onOpen: (path: string) => void
  onCreateLinked: (title: string) => void
  /** Renames the entry; resolves false when the name was refused. */
  onRename: (title: string) => Promise<boolean>
  onAction: (action: EntryAction) => void
  onError: (message: string) => void
  /** Creates a missing entry an entry field names, in that field's section. */
  onCreateIn: (title: string, section: string) => void
  /** For an idea: opens the promote dialog. */
  onPromote: () => void
  /** Asks before opening an http(s) link in the system browser. */
  onExternal: (url: string) => void
  copyOriginals: boolean
  onCopyOriginals: (copy: boolean) => void
  /** A game bible, or the study journal (sessions take practice images; topics show progress). */
  role: 'bible' | 'journal'
  /** A short message for the user, such as where images went. */
  onNotice: (text: string) => void
}

function readView(): EditorView {
  try {
    const saved = localStorage.getItem(VIEW_KEY)
    if (saved === 'split' || saved === 'text' || saved === 'preview') return saved
  } catch {
    // Storage unavailable: use the default.
  }
  return 'split'
}

function messageOf(error: unknown): string {
  return error instanceof ApiError || error instanceof Error ? error.message : String(error)
}

/** One entry: Markdown on the left, preview on the right, autosaved. */
export function EntryEditor({
  vaultId,
  path,
  sectionId,
  sectionName,
  sections,
  entries,
  tagOptions,
  canMoveUp,
  canMoveDown,
  diskTick,
  flushRef,
  onOpen,
  onCreateLinked,
  onRename,
  onAction,
  onError,
  onCreateIn,
  onPromote,
  onExternal,
  copyOriginals,
  onCopyOriginals,
  role,
  onNotice,
}: Props) {
  const journal = role === 'journal'
  const isSession = journal && sectionId === 'sessions'
  const isTopic = journal && sectionId === 'topics'
  const [libraryOpen, setLibraryOpen] = useState(false)
  // A topic opens on its progress; the editor is one click away.
  const [progress, setProgress] = useState(true)
  const [dropping, setDropping] = useState(false)
  const [entry, setEntry] = useState<EntryViewData | null>(null)
  const [text, setText] = useState('')
  const [savedBody, setSavedBody] = useState('')
  const [titleDraft, setTitleDraft] = useState('')
  const [conflict, setConflict] = useState<Conflict | null>(null)
  const [saving, setSaving] = useState(false)
  const [view, setView] = useState<EditorView>(readView)
  const [completion, setCompletion] = useState<Completion | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)

  const area = useRef<HTMLTextAreaElement>(null)
  const titleInput = useRef<HTMLInputElement>(null)
  // The latest values, for saves that run after a render (timers, unmount).
  const textRef = useRef('')
  const savedRef = useRef('')
  const versionRef = useRef('')
  const conflictRef = useRef<Conflict | null>(null)
  const queue = useRef<Promise<void>>(Promise.resolve())
  // Where the caret goes once the text it belongs to is on screen.
  const pendingCaret = useRef<number | null>(null)
  const errorRef = useRef(onError)
  useEffect(() => {
    errorRef.current = onError
  })

  const adopt = useCallback((loaded: EntryViewData) => {
    setEntry(loaded)
    setText(loaded.body)
    setSavedBody(loaded.body)
    setTitleDraft(loaded.title)
    textRef.current = loaded.body
    savedRef.current = loaded.body
    versionRef.current = loaded.version
    conflictRef.current = null
    setConflict(null)
  }, [])

  const showConflict = useCallback((next: Conflict | null) => {
    conflictRef.current = next
    setConflict(next)
  }, [])

  useEffect(() => {
    let live = true
    call('bible:entry', { vaultId, path })
      .then((loaded) => {
        if (live) adopt(loaded)
      })
      .catch((error: unknown) => errorRef.current(messageOf(error)))
    return () => {
      live = false
    }
  }, [vaultId, path, adopt])

  /** Saves the current text; saves run one after another, never two at once. */
  const save = useCallback(
    (force: boolean): Promise<void> => {
      const run = async () => {
        const body = textRef.current
        if (!force && (body === savedRef.current || conflictRef.current !== null)) return
        setSaving(true)
        try {
          const result = await call('bible:saveEntry', {
            vaultId,
            path,
            body,
            baseVersion: versionRef.current,
            force,
          })
          if (result.status === 'saved') {
            versionRef.current = result.entry.version
            savedRef.current = body
            setSavedBody(body)
            setEntry((current) =>
              current
                ? { ...current, backlinks: result.entry.backlinks, ...derived(result.entry) }
                : current,
            )
            showConflict(null)
          } else {
            showConflict({ kind: 'changed', theirs: result.theirs })
          }
        } catch (error) {
          if (error instanceof ApiError && /no longer exists/.test(error.message)) {
            showConflict({ kind: 'gone' })
          } else {
            errorRef.current(messageOf(error))
          }
        } finally {
          setSaving(false)
        }
      }
      queue.current = queue.current.then(run, run)
      return queue.current
    },
    [vaultId, path, showConflict],
  )

  // Actions on this entry elsewhere (sidebar, cards) wait for pending edits first.
  useEffect(() => {
    flushRef.current = () => save(false)
    return () => {
      flushRef.current = null
    }
  }, [flushRef, save])

  /** Saves property values; queued with body saves, so each builds on the last version. */
  const saveProperty = useCallback(
    (key: string, value: FieldValueData): Promise<void> => {
      // Show the new value at once; the saved entry replaces it (or the old one comes back on error).
      setEntry((current) => {
        if (!current) return current
        if (key === 'tags') {
          return Array.isArray(value) ? { ...current, tags: value } : current
        }
        const properties = current.properties.map((property) =>
          property.key === key ? { ...property, value, warning: null, raw: null } : property,
        )
        return { ...current, properties }
      })
      const run = async () => {
        if (conflictRef.current !== null) return
        setSaving(true)
        try {
          const result = await call('bible:setProperties', {
            vaultId,
            path,
            changes: [{ key, value }],
            baseVersion: versionRef.current,
          })
          if (result.status === 'saved') {
            versionRef.current = result.entry.version
            const { tags, properties, backlinks } = result.entry
            setEntry((current) =>
              current
                ? { ...current, tags, properties, backlinks, ...derived(result.entry) }
                : current,
            )
          } else {
            showConflict({ kind: 'changed', theirs: result.theirs })
          }
        } catch (error) {
          errorRef.current(messageOf(error))
          // Put back what the file holds.
          try {
            const fresh = await call('bible:entry', { vaultId, path })
            const { tags, properties } = fresh
            setEntry((current) => (current ? { ...current, tags, properties } : current))
          } catch {
            // The entry is gone; the next disk change says so.
          }
        } finally {
          setSaving(false)
        }
      }
      queue.current = queue.current.then(run, run)
      return queue.current
    },
    [vaultId, path, showConflict],
  )

  // Autosave after a pause in typing.
  useEffect(() => {
    if (text === savedBody || conflict !== null) return
    const timer = setTimeout(() => void save(false), AUTOSAVE_MS)
    return () => clearTimeout(timer)
  }, [text, savedBody, conflict, save])

  // Leaving the entry (switching, closing the bible) saves what is pending.
  useEffect(() => () => void save(false), [save])

  // The file changed on disk: reload it, or ask when there are unsaved edits.
  useEffect(() => {
    if (diskTick === 0) return
    let live = true
    void (async () => {
      const settled = queue.current
      await settled
      let fresh: EntryViewData
      try {
        fresh = await call('bible:entry', { vaultId, path })
      } catch {
        if (live) showConflict({ kind: 'gone' })
        return
      }
      // A save was queued while this read was on its way: what it read is
      // already old. That save's result (and its own disk event) wins.
      if (!live || queue.current !== settled) return
      if (fresh.version === versionRef.current) {
        // The file is the same; links to it or the entries its fields name may not be.
        const { backlinks, properties } = fresh
        setEntry((current) =>
          current ? { ...current, backlinks, properties, ...derived(fresh) } : current,
        )
        return
      }
      if (textRef.current === savedRef.current || textRef.current === fresh.body) {
        adopt(fresh)
      } else {
        showConflict({ kind: 'changed', theirs: fresh })
      }
    })()
    return () => {
      live = false
    }
  }, [diskTick, vaultId, path, adopt, showConflict])

  function changeView(next: EditorView) {
    setView(next)
    try {
      localStorage.setItem(VIEW_KEY, next)
    } catch {
      // Not remembered; harmless.
    }
  }

  // ---- links -------------------------------------------------------------

  const targets = useMemo(() => {
    const map = new Map<string, string>()
    for (const item of entries)
      if (!map.has(titleKey(item.title))) map.set(titleKey(item.title), item.path)
    return map
  }, [entries])

  const html = useMemo(
    () =>
      renderMarkdown(
        text,
        (title) => targets.get(titleKey(title)) ?? null,
        path,
        journal ? 'journal' : 'vault',
      ),
    [text, targets, path, journal],
  )

  function onPreviewClick(event: MouseEvent<HTMLDivElement>) {
    const link = (event.target as HTMLElement).closest('a')
    if (!link) return
    event.preventDefault()
    const target = link.dataset['path']
    const create = link.dataset['create']
    const external = link.dataset['external']
    if (target) onOpen(target)
    else if (create) onCreateLinked(create)
    else if (external) onExternal(external)
  }

  /**
   * Saves pending text, then runs a request that lists images in the entry
   * and puts their Markdown links where the caret is (or at the end).
   */
  async function attachImages(
    request: (baseVersion: string) => Promise<{
      result: SaveResultData
      images: Array<{ alt: string; link: string }>
    }>,
  ) {
    await save(false)
    const run = async () => {
      if (conflictRef.current !== null) return
      setSaving(true)
      try {
        const { result, images } = await request(versionRef.current)
        if (result.status !== 'saved') {
          showConflict({ kind: 'changed', theirs: result.theirs })
          return
        }
        versionRef.current = result.entry.version
        const { tags, properties, references } = result.entry
        setEntry((current) => (current ? { ...current, tags, properties, references } : current))
        const node = area.current
        const current = textRef.current
        const at = node && document.activeElement === node ? node.selectionStart : current.length
        const links = images.map((image) => `![${image.alt}](${image.link})`).join('\n')
        const before = current.slice(0, at)
        const glue = before === '' || before.endsWith('\n') ? '' : '\n'
        const next = `${before}${glue}${links}\n${current.slice(at)}`
        textRef.current = next
        setText(next)
      } catch (error) {
        errorRef.current(messageOf(error))
      } finally {
        setSaving(false)
      }
    }
    queue.current = queue.current.then(run, run)
    await queue.current
  }

  /** Library images dropped on the entry: copied into the vault, linked where the caret is. */
  function addReferences(ids: number[]) {
    return attachImages((baseVersion) =>
      call('bible:addReferences', { vaultId, path, referenceIds: ids, baseVersion }),
    )
  }

  /** Images from Explorer or the clipboard, on a journal session. */
  async function addPracticeImages(files: IncomingFile[], alsoLibrary: boolean) {
    const prepared = await prepareImages(files)
    const items = prepared.flatMap((item) => (item.ok ? [item.upload] : []))
    const skipped = prepared.length - items.length
    if (skipped > 0) {
      errorRef.current(`${skipped} ${skipped === 1 ? 'file is' : 'files are'} not a readable image`)
    }
    if (items.length === 0) return
    await attachImages(async (baseVersion) => {
      const added = await call('journal:addImages', {
        vaultId,
        path,
        items,
        alsoLibrary,
        baseVersion,
      })
      if (added.library) {
        onNotice(`Added to the Library, tagged ${added.library.tags.join(', ')}`)
      }
      return added
    })
  }

  function updateCompletion(value: string, caret: number) {
    const open = openLinkQuery(value, caret)
    const node = area.current
    if (!open || !node) {
      setCompletion(null)
      return
    }
    const items = rankTitles(
      entries.map((item) => item.title),
      open.query,
      COMPLETE_LIMIT,
    )
    if (items.length === 0) {
      setCompletion(null)
      return
    }
    const at = caretPosition(node, caret)
    setCompletion((current) => ({
      start: open.start,
      items,
      index:
        current && current.start === open.start ? Math.min(current.index, items.length - 1) : 0,
      left: at.left,
      top: at.top,
    }))
  }

  function insertCompletion(title: string) {
    const node = area.current
    if (!node || !completion) return
    const next = completeLink(node.value, node.selectionStart, completion.start, title)
    setText(next.text)
    textRef.current = next.text
    setCompletion(null)
    pendingCaret.current = next.caret
  }

  // Runs after every commit, so right after React writes the completed text into
  // the textarea and before any further key reaches it. (A frame callback can
  // run late in a background window and move the caret mid-typing.)
  useLayoutEffect(() => {
    const caret = pendingCaret.current
    const node = area.current
    if (caret === null || !node) return
    pendingCaret.current = null
    node.focus()
    node.setSelectionRange(caret, caret)
  })

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (!completion) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      const count = completion.items.length
      setCompletion({ ...completion, index: (completion.index + step + count) % count })
    } else if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault()
      const title = completion.items[completion.index]
      if (title) insertCompletion(title)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      setCompletion(null)
    }
  }

  // ---- rename and other actions -----------------------------------------

  async function commitTitle() {
    if (!entry) return
    const next = titleDraft.trim()
    if (next === '' || next === entry.title) {
      setTitleDraft(entry.title)
      return
    }
    if (!(await onRename(next))) setTitleDraft(entry.title)
  }

  function startRename() {
    const input = titleInput.current
    if (!input) return
    input.focus()
    input.select()
  }

  if (!entry) return <div className="bible-editor-empty">Loading…</div>

  const dirty = text !== savedBody
  const status = conflict ? 'Not saved' : saving ? 'Saving…' : dirty ? 'Unsaved' : 'Saved'

  return (
    <section
      className={
        'bible-editor' + (dropping ? ' dropping' : '') + (libraryOpen ? ' with-library' : '')
      }
      aria-label="Entry editor"
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes(LIBRARY_DRAG_TYPE)) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
        setDropping(true)
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropping(false)
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.types.includes(LIBRARY_DRAG_TYPE)) return
        event.preventDefault()
        setDropping(false)
        let ids: number[] = []
        try {
          ids = (JSON.parse(event.dataTransfer.getData(LIBRARY_DRAG_TYPE)) as unknown[]).filter(
            (item): item is number => typeof item === 'number',
          )
        } catch {
          return
        }
        if (ids.length > 0) void addReferences(ids)
      }}
    >
      <div className="bible-editor-main">
        <header className="bible-editor-head">
          <div className="bible-editor-titles">
            <div className="s-eyebrow">{sectionName}</div>
            <label className="bible-title-label" title="Click to rename">
              <input
                ref={titleInput}
                className="bible-title-input"
                aria-label="Entry title"
                value={titleDraft}
                onChange={(event) => setTitleDraft(event.target.value)}
                onBlur={() => void commitTitle()}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    event.currentTarget.blur()
                  } else if (event.key === 'Escape') {
                    setTitleDraft(entry.title)
                    event.currentTarget.blur()
                  }
                }}
              />
              <PencilIcon className="bible-title-pencil" />
            </label>
            <div className="entry-markers">
              {entry.stale && (
                <span
                  className="stale-marker"
                  data-testid="stale-marker"
                  title="Not updated for 60 days, while decisions linked to it changed since"
                >
                  May be out of date
                </span>
              )}
              {entry.promotedFrom && (
                <span className="bible-muted">
                  Promoted from{' '}
                  <button
                    type="button"
                    className="bible-link-button"
                    onClick={() => onOpen(entry.promotedFrom?.path ?? path)}
                  >
                    {entry.promotedFrom.title}
                  </button>
                </span>
              )}
              {entry.promotedTo && (
                <span className="bible-muted">
                  Promoted to{' '}
                  <button
                    type="button"
                    className="bible-link-button"
                    onClick={() => onOpen(entry.promotedTo?.path ?? path)}
                  >
                    {entry.promotedTo.title}
                  </button>
                </span>
              )}
              {isSession && (
                <PracticeIntake
                  onImages={(files, alsoLibrary) => void addPracticeImages(files, alsoLibrary)}
                />
              )}
            </div>
          </div>
          <div className="bible-editor-actions">
            <span className="bible-save-status mono" data-testid="save-status">
              {status}
            </span>
            {sectionId === 'ideas' && !entry.promotedTo && (
              <button type="button" className="btn" onClick={onPromote}>
                Promote…
              </button>
            )}
            <button
              type="button"
              className={'btn ghost' + (libraryOpen ? ' active' : '')}
              aria-pressed={libraryOpen}
              title="Drag Library images onto the entry"
              onClick={() => setLibraryOpen((open) => !open)}
            >
              <ImageIcon /> {journal ? 'Library' : 'References'}
            </button>
            <div className="segmented" role="group" aria-label="Editor layout">
              {isTopic && (
                <button
                  type="button"
                  className={'segment' + (progress ? ' active' : '')}
                  aria-pressed={progress}
                  onClick={() => setProgress(true)}
                >
                  Progress
                </button>
              )}
              {(['text', 'split', 'preview'] as const).map((option) => {
                const on = view === option && !(isTopic && progress)
                return (
                  <button
                    key={option}
                    type="button"
                    className={'segment' + (on ? ' active' : '')}
                    aria-pressed={on}
                    onClick={() => {
                      setProgress(false)
                      changeView(option)
                    }}
                  >
                    {option === 'text' ? 'Text' : option === 'split' ? 'Split' : 'Preview'}
                  </button>
                )
              })}
            </div>
            <div className="bible-menu-anchor">
              <button
                type="button"
                className="btn ghost"
                aria-label="More actions"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen((open) => !open)}
              >
                ⋯
              </button>
              {menuOpen && (
                <EntryMenu
                  title={entry.title}
                  sections={sections}
                  currentSection={sectionId}
                  canMoveUp={canMoveUp}
                  canMoveDown={canMoveDown}
                  onClose={() => setMenuOpen(false)}
                  onAction={(action) =>
                    action.kind === 'rename' ? startRename() : onAction(action)
                  }
                />
              )}
            </div>
          </div>
        </header>

        {conflict?.kind === 'changed' && (
          <div className="bible-banner" role="alert" data-testid="conflict-banner">
            <span>This entry changed on disk while you were editing it.</span>
            <button type="button" className="btn" onClick={() => void save(true)}>
              Keep mine
            </button>
            <button type="button" className="btn" onClick={() => adopt(conflict.theirs)}>
              Load theirs
            </button>
          </div>
        )}
        {conflict?.kind === 'gone' && (
          <div className="bible-banner" role="alert" data-testid="conflict-banner">
            <span>
              This entry&apos;s file was moved or deleted outside the app. Your text is still here;
              copy it before leaving this entry.
            </span>
          </div>
        )}

        <PropertiesPanel
          properties={entry.properties}
          tags={entry.tags}
          tagOptions={tagOptions}
          entries={entries}
          onChange={(key, value) => void saveProperty(key, value)}
          onOpen={onOpen}
          onCreate={onCreateIn}
          noPillar={entry.noPillar}
        />

        {isTopic && progress ? (
          <TopicProgress
            vaultId={vaultId}
            path={path}
            refreshKey={diskTick}
            onOpen={onOpen}
            onExternal={onExternal}
            onError={onError}
          />
        ) : (
          <div className={'bible-panes ' + view}>
            {view !== 'preview' && (
              <div className="bible-text-pane">
                <textarea
                  ref={area}
                  className="bible-textarea"
                  aria-label="Entry text"
                  spellCheck
                  value={text}
                  onChange={(event) => {
                    setText(event.target.value)
                    textRef.current = event.target.value
                    updateCompletion(event.target.value, event.target.selectionStart)
                  }}
                  onKeyDown={onKeyDown}
                  onClick={(event) =>
                    updateCompletion(event.currentTarget.value, event.currentTarget.selectionStart)
                  }
                  onBlur={() => {
                    setCompletion(null)
                    void save(false)
                  }}
                />
                {completion && (
                  <ul
                    className="link-complete"
                    role="listbox"
                    aria-label="Link to entry"
                    style={{ left: completion.left + 12, top: completion.top + 6 }}
                  >
                    {completion.items.map((title, index) => (
                      <li
                        key={title}
                        role="option"
                        aria-selected={index === completion.index}
                        className={index === completion.index ? 'active' : ''}
                        onMouseDown={(event) => {
                          event.preventDefault()
                          insertCompletion(title)
                        }}
                      >
                        {title}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            {view !== 'text' && (
              <div
                className="bible-preview markdown"
                data-testid="entry-preview"
                onClick={onPreviewClick}
                // Rendered by marked with raw HTML escaped and link targets checked (markdown.ts).
                dangerouslySetInnerHTML={{ __html: html }}
              />
            )}
          </div>
        )}

        {entry.servedBy && (
          <footer
            className="bible-backlinks"
            aria-label="Serves this pillar"
            data-testid="served-by"
          >
            <div className="s-eyebrow">Serves this pillar</div>
            {(['decisions', 'ideas'] as const).map((kind) => (
              <span key={kind} className="served-group">
                <span className="bible-muted">
                  {kind === 'decisions' ? 'Decisions' : 'Ideas'} (
                  {entry.servedBy?.[kind].length ?? 0})
                </span>
                {entry.servedBy?.[kind].map((item) => (
                  <button
                    key={item.path}
                    type="button"
                    className="bible-link-button"
                    onClick={() => onOpen(item.path)}
                  >
                    {item.title}
                  </button>
                ))}
              </span>
            ))}
          </footer>
        )}

        <footer className="bible-backlinks" aria-label="Linked from">
          <div className="s-eyebrow">Linked from</div>
          {entry.backlinks.length === 0 ? (
            <span className="bible-muted">No entries link here yet.</span>
          ) : (
            <ul data-testid="backlinks">
              {entry.backlinks.map((link) => (
                <li key={link.path}>
                  <button
                    type="button"
                    className="bible-link-button"
                    onClick={() => onOpen(link.path)}
                  >
                    {link.title}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </footer>
      </div>
      {libraryOpen && (
        <aside className="bible-library" aria-label="References">
          <p className="bible-muted bible-library-hint">
            {journal
              ? "Drag an image onto the entry. It is copied into the journal's _assets folder."
              : "Drag an image onto the entry. It is copied into the bible's _assets folder, so teammates and agents see it too."}
          </p>
          <label className="kit-update-item">
            <input
              type="checkbox"
              checked={copyOriginals}
              onChange={(event) => onCopyOriginals(event.target.checked)}
            />
            Copy originals, not thumbnails
          </label>
          <LibraryPanel
            version={0}
            onBoard={NO_BOARD}
            onError={onError}
            hint="Drag onto the entry to add."
          />
        </aside>
      )}
    </section>
  )
}

/** What the app works out from the whole vault: fresh with every save or disk change. */
function derived(entry: EntryViewData) {
  const { stale, noPillar, servedBy, promotedFrom, promotedTo, references } = entry
  return { stale, noPillar, servedBy, promotedFrom, promotedTo, references }
}

/** The bible has no board: nothing is marked as placed in the Library panel. */
const NO_BOARD: ReadonlySet<number> = new Set()

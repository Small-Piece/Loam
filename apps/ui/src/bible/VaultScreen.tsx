import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
} from 'react'
import type {
  IdeaCardData,
  TimelineItemData,
  PillarCardData,
  ResponseOf,
  TrashItemData,
  VaultViewData,
} from '@loam/protocol'
import { ApiError, call, onEvent } from '../api.ts'
import { ConfirmDialog } from '../board/ConfirmDialog.tsx'
import { PlusIcon, SearchIcon, TrashIcon, XIcon } from '../icons.tsx'
import {
  ExternalLinkDialog,
  KitUpdateDialog,
  PromoteDialog,
  SectionPicker,
} from './BibleDialogs.tsx'
import { IdeasBoard, ReviewPage, TimelinePage } from './DecisionPages.tsx'
import { linkPickerDefault } from './pickerDefault.ts'
import {
  CalendarPage,
  ResourcesPage,
  TodayPage,
  localToday,
  type CalendarDays,
} from '../journal/JournalPages.tsx'
import { EntryEditor } from './EntryEditor.tsx'
import { EntryMenu, type EntryAction } from './EntryMenu.tsx'
import { FirstPillar } from './FirstRun.tsx'
import { PILLAR_SOFT_LIMIT, PillarsPage } from './PillarsPage.tsx'
import type { PickableEntry } from './PropertiesPanel.tsx'
import { SectionFields, type FieldDraft } from './SectionFields.tsx'
import { TrashView } from './TrashView.tsx'

const SEARCH_DELAY_MS = 120
const TOAST_MS = 8000
const PILLARS = 'pillars'
const ENTRY_DRAG = 'application/x-um-entry'
// Search snippets mark matched words with characters 2 and 3 (see the storage index).
const MARK_OPEN = String.fromCharCode(2)
const MARK_CLOSE = String.fromCharCode(3)

type Hit = ResponseOf<'bible:search'>['hits'][number]
type Page =
  'pillars' | 'trash' | 'timeline' | 'ideas' | 'review' | 'today' | 'calendar' | 'resources' | null

/** Sections whose heading opens a page of their own. */
const SECTION_PAGES: Readonly<Record<string, { page: Page; hint: string }>> = {
  pillars: { page: 'pillars', hint: 'Show the pillars as cards' },
  decisions: { page: 'timeline', hint: 'Show the decision log' },
  ideas: { page: 'ideas', hint: 'Show the idea board' },
}

/** In the journal: Sessions opens the calendar, Resources the list by status. */
const JOURNAL_SECTION_PAGES: Readonly<Record<string, { page: Page; hint: string }>> = {
  sessions: { page: 'calendar', hint: 'Show the calendar' },
  resources: { page: 'resources', hint: 'Show resources by status' },
}

interface Toast {
  text: string
  kind: 'info' | 'error'
  undo?: () => Promise<void>
}

interface Props {
  initial: VaultViewData
  /** True right after the vault was created: ask the first-run question. */
  firstRun: boolean
  onSwitch: () => void
}

function messageOf(error: unknown): string {
  return error instanceof ApiError || error instanceof Error ? error.message : String(error)
}

/** Shows matched words from an FTS snippet in bold. */
function Snippet({ text }: { text: string }) {
  const parts: Array<string | { mark: string }> = []
  let at = 0
  for (;;) {
    const open = text.indexOf(MARK_OPEN, at)
    const close = open === -1 ? -1 : text.indexOf(MARK_CLOSE, open + 1)
    if (open === -1 || close === -1) break
    parts.push(text.slice(at, open))
    parts.push({ mark: text.slice(open + 1, close) })
    at = close + 1
  }
  parts.push(text.slice(at))
  return (
    <span className="bible-snippet">
      {parts.map((part, index) =>
        typeof part === 'string' ? part : <mark key={index}>{part.mark}</mark>,
      )}
    </span>
  )
}

/** One open vault: sections and entries on the left; an entry, the Pillars page or the Trash on the right. */
export function VaultScreen({ initial, firstRun, onSwitch }: Props) {
  const journal = initial.role === 'journal'
  const noun = journal ? 'journal' : 'bible'
  const sectionPages = journal ? JOURNAL_SECTION_PAGES : SECTION_PAGES
  const [vault, setVaultState] = useState(initial)
  const [selected, setSelected] = useState<string | null>(initial.lastEntry)
  // The journal opens on Today.
  const [page, setPage] = useState<Page>(journal ? 'today' : null)
  const [diskTick, setDiskTick] = useState(0)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<Hit[] | null>(null)
  const [toast, setToast] = useState<Toast | null>(null)
  const [asking, setAsking] = useState(firstRun)
  const [adding, setAdding] = useState<string | null>(null)
  const [newTitle, setNewTitle] = useState('')
  const [sectionMenu, setSectionMenu] = useState<string | null>(null)
  const [renamingSection, setRenamingSection] = useState<string | null>(null)
  const [sectionName, setSectionName] = useState('')
  const [addingSection, setAddingSection] = useState(false)
  const [removing, setRemoving] = useState<{ id: string; name: string; count: number } | null>(null)
  const [fieldsFor, setFieldsFor] = useState<string | null>(null)
  const [entryMenu, setEntryMenu] = useState<string | null>(null)
  const [renamingEntry, setRenamingEntry] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [dragging, setDragging] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<{ section: string; before: string | null } | null>(
    null,
  )
  const [cards, setCards] = useState<PillarCardData[]>([])
  const [trash, setTrash] = useState<TrashItemData[]>([])
  const [tagOptions, setTagOptions] = useState<string[]>([])

  const vaultId = vault.vault.id
  // Responses can arrive out of order: a refresh asked for before an action
  // may answer after it. Each kind of data keeps a counter, and a response is
  // used only if nothing newer was applied since it was asked for.
  const viewSeq = useRef(0)
  const trashSeq = useRef(0)
  const pillarsSeq = useRef(0)
  const setVault = useCallback((next: VaultViewData) => {
    viewSeq.current += 1
    setVaultState(next)
  }, [])
  const flushRef = useRef<(() => Promise<void>) | null>(null)
  // After a sidebar action, keyboard focus returns to the entry it acted on
  // (its button may be new, after a rename or a move); see the button's ref.
  const focusPath = useRef<string | null>(null)
  const setFocusPath = (path: string) => {
    focusPath.current = path
  }
  const selectedRef = useRef(selected)
  const queryRef = useRef(query)
  const pageRef = useRef(page)
  useEffect(() => {
    selectedRef.current = selected
    queryRef.current = query
    pageRef.current = page
  })

  const entries: PickableEntry[] = useMemo(
    () =>
      vault.sections.flatMap((section) =>
        section.entries.map((entry) => ({ ...entry, section: section.id })),
      ),
    [vault],
  )
  const sectionList = useMemo(() => vault.sections.map(({ id, name }) => ({ id, name })), [vault])
  const sectionOf = useCallback(
    (path: string) =>
      vault.sections.find((section) => section.entries.some((e) => e.path === path)),
    [vault],
  )
  const selectedSection = selected === null ? undefined : sectionOf(selected)

  const showError = useCallback((text: string) => setToast({ text, kind: 'error' }), [])

  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), TOAST_MS)
    return () => clearTimeout(timer)
  }, [toast])

  const runSearch = useCallback(
    async (text: string) => {
      if (text.trim() === '') {
        setHits(null)
        return
      }
      try {
        const result = await call('bible:search', { vaultId, text })
        if (queryRef.current === text) setHits(result.hits)
      } catch (error) {
        showError(messageOf(error))
      }
    },
    [vaultId, showError],
  )

  useEffect(() => {
    const timer = setTimeout(() => void runSearch(query), SEARCH_DELAY_MS)
    return () => clearTimeout(timer)
  }, [query, runSearch])

  const loadPillars = useCallback(async () => {
    try {
      const seq = ++pillarsSeq.current
      const result = await call('bible:pillars', { vaultId })
      if (seq === pillarsSeq.current) setCards(result.cards)
    } catch (error) {
      showError(messageOf(error))
    }
  }, [vaultId, showError])

  const loadTrash = useCallback(async () => {
    try {
      const seq = ++trashSeq.current
      const result = await call('bible:trash', { vaultId })
      if (seq === trashSeq.current) setTrash(result.items)
    } catch (error) {
      showError(messageOf(error))
    }
  }, [vaultId, showError])

  const [timeline, setTimeline] = useState<TimelineItemData[]>([])
  const [ideaCards, setIdeaCards] = useState<IdeaCardData[]>([])
  const [review, setReview] = useState<ResponseOf<'bible:review'>['items']>([])
  const [kitOpen, setKitOpen] = useState(false)
  const [picker, setPicker] = useState<{ title: string; from: string; initial: string } | null>(
    null,
  )
  const [promoting, setPromoting] = useState<{ path: string; title: string } | null>(null)
  const [swapOffer, setSwapOffer] = useState<{ path: string; from: string; to: string } | null>(
    null,
  )
  const [externalUrl, setExternalUrl] = useState<string | null>(null)
  const [todayView, setTodayView] = useState<ResponseOf<'journal:today'> | null>(null)
  const [calendarDays, setCalendarDays] = useState<CalendarDays>([])
  const [calendarYear, setCalendarYear] = useState(() => new Date().getFullYear())
  const calendarYearRef = useRef(calendarYear)
  const [resources, setResources] = useState<ResponseOf<'journal:resources'>['items']>([])
  const pagesSeq = useRef(0)

  /** The decision pages share one counter: only the newest answer is shown. */
  const loadDecisionPage = useCallback(
    async (which: Page) => {
      const seq = ++pagesSeq.current
      try {
        if (which === 'timeline') {
          const result = await call('bible:timeline', { vaultId })
          if (seq === pagesSeq.current) setTimeline(result.items)
        } else if (which === 'ideas') {
          const result = await call('bible:ideas', { vaultId })
          if (seq === pagesSeq.current) setIdeaCards(result.cards)
        } else if (which === 'review') {
          const result = await call('bible:review', { vaultId })
          if (seq === pagesSeq.current) setReview(result.items)
        } else if (which === 'today') {
          const result = await call('journal:today', { vaultId })
          if (seq === pagesSeq.current) setTodayView(result)
        } else if (which === 'calendar') {
          const year = calendarYearRef.current
          const result = await call('journal:calendar', { vaultId, year })
          if (seq === pagesSeq.current && year === calendarYearRef.current) {
            setCalendarDays(result.days)
          }
        } else if (which === 'resources') {
          const result = await call('journal:resources', { vaultId })
          if (seq === pagesSeq.current) setResources(result.items)
        }
      } catch (error) {
        showError(messageOf(error))
      }
    },
    [vaultId, showError],
  )

  const loadTagOptions = useCallback(async () => {
    try {
      setTagOptions((await call('bible:tagOptions', { vaultId })).tags)
    } catch {
      // Suggestions only; typing a tag still works.
    }
  }, [vaultId])

  // Pages load when they open; later changes arrive through bible:changed below.
  function showPage(next: Page) {
    setPage(next)
    if (next === 'pillars') void loadPillars()
    if (next === 'trash') void loadTrash()
    void loadDecisionPage(next)
  }

  // The journal lands on Today, which loads here; other pages load when shown.
  useEffect(() => {
    if (initial.role !== 'journal') return
    let live = true
    call('journal:today', { vaultId })
      .then((result) => {
        if (live) setTodayView(result)
      })
      .catch((error: unknown) => showError(messageOf(error)))
    return () => {
      live = false
    }
  }, [initial.role, vaultId, showError])

  useEffect(() => {
    let live = true
    call('bible:tagOptions', { vaultId })
      .then((result) => {
        if (live) setTagOptions(result.tags)
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [vaultId])

  // Files changed on disk (another editor, git, a coding agent, or our own saves).
  useEffect(
    () =>
      onEvent('bible:changed', (event) => {
        if (event.vaultId !== vaultId) return
        const seq = ++viewSeq.current
        call('bible:view', { vaultId })
          .then((next) => {
            if (seq === viewSeq.current) setVaultState(next)
          })
          .catch((error: unknown) => showError(messageOf(error)))
        if (queryRef.current.trim()) void runSearch(queryRef.current)
        if (pageRef.current === 'pillars') void loadPillars()
        if (pageRef.current === 'trash') void loadTrash()
        void loadDecisionPage(pageRef.current)
        void loadTagOptions()
        // Any change can add or remove a backlink to the open entry, so it always rechecks.
        if (selectedRef.current !== null) setDiskTick((tick) => tick + 1)
      }),
    [vaultId, runSearch, showError, loadPillars, loadTrash, loadTagOptions, loadDecisionPage],
  )

  function open(path: string) {
    setSelected(path)
    setPage(null)
  }

  async function attempt<T>(work: () => Promise<T>): Promise<T | null> {
    try {
      return await work()
    } catch (error) {
      showError(messageOf(error))
      return null
    }
  }

  /** Saves pending edits in the editor before acting on the entry it shows. */
  async function settle(path: string) {
    if (path === selectedRef.current) await flushRef.current?.()
  }

  // ---- entry actions -------------------------------------------------------

  async function createEntry(
    section: string,
    title: string,
    body: string | null,
    intro?: string,
    linkFrom?: string,
  ) {
    const result = await attempt(() =>
      call('bible:createEntry', {
        vaultId,
        section,
        title,
        body,
        intro: intro ?? null,
        linkFrom: linkFrom ?? null,
      }),
    )
    if (!result) return false
    setVault(result.vault)
    open(result.entry.path)
    return true
  }

  async function renameEntry(path: string, title: string): Promise<boolean> {
    await settle(path)
    const result = await attempt(() => call('bible:renameEntry', { vaultId, path, title }))
    if (!result) return false
    setVault(result.vault)
    if (selectedRef.current === path) setSelected(result.entry.path)
    setToast({
      text:
        result.rewritten > 0
          ? `Renamed; updated ${result.rewritten} ${result.rewritten === 1 ? 'link' : 'links'}`
          : 'Renamed',
      kind: 'info',
    })
    setFocusPath(result.entry.path)
    return true
  }

  async function deleteEntry(path: string, title: string) {
    await settle(path)
    const result = await attempt(() => call('bible:deleteEntry', { vaultId, path }))
    if (!result) return
    setVault(result.vault)
    if (selectedRef.current === path) setSelected(null)
    setToast({
      text: `Moved “${title}” to .trash`,
      kind: 'info',
      undo: async () => {
        const back = await call('bible:restoreEntry', {
          vaultId,
          trashPath: result.trashPath,
          path,
        })
        setVault(back.vault)
        open(back.path)
      },
    })
  }

  async function duplicate(path: string) {
    await settle(path)
    const result = await attempt(() => call('bible:duplicateEntry', { vaultId, path }))
    if (!result) return
    setVault(result.vault)
    open(result.entry.path)
    setToast({ text: `Duplicated as “${result.entry.title}”`, kind: 'info' })
  }

  async function moveToSection(path: string, section: string) {
    await settle(path)
    const result = await attempt(() => call('bible:moveEntry', { vaultId, path, section }))
    if (!result) return null
    setVault(result.vault)
    if (selectedRef.current === path) setSelected(result.path)
    const name = result.vault.sections.find((candidate) => candidate.id === section)?.name
    setToast({ text: `Moved to ${name ?? section}`, kind: 'info' })
    setFocusPath(result.path)
    if (result.templateSwap) {
      const from = vault.sections.find((candidate) =>
        candidate.entries.some((e) => e.path === path),
      )
      setSwapOffer({ path: result.path, from: from?.id ?? '', to: name ?? section })
    }
    return result
  }

  /** Replaces the old section's untouched template with the new section's. */
  async function swapTemplate(offer: { path: string; from: string }) {
    setSwapOffer(null)
    await settle(offer.path)
    await attempt(async () => {
      const current = await call('bible:entry', { vaultId, path: offer.path })
      const result = await call('bible:swapTemplate', {
        vaultId,
        path: offer.path,
        fromSection: offer.from,
        baseVersion: current.version,
      })
      if (result.status === 'conflict') throw new Error('The entry changed meanwhile')
      setToast({ text: 'Template swapped', kind: 'info' })
      if (selectedRef.current === offer.path) setDiskTick((tick) => tick + 1)
    })
  }

  /** A missing [[link]] clicked: ask which section the new entry goes in. */
  function createFromLink(title: string, fromSection: string) {
    setPicker({
      title,
      from: fromSection,
      initial: linkPickerDefault(title, fromSection, vault.sections, vault.linkSections),
    })
  }

  async function newSession() {
    const result = await attempt(() => call('journal:newSession', { vaultId }))
    if (!result) return
    setVault(result.vault)
    open(result.entry.path)
  }

  function showYear(year: number) {
    calendarYearRef.current = year
    setCalendarYear(year)
    void loadDecisionPage('calendar')
  }

  async function promote(path: string, section: string, title: string) {
    setPromoting(null)
    await settle(path)
    const result = await attempt(() => call('bible:promote', { vaultId, path, section, title }))
    if (!result) return
    setVault(result.vault)
    open(result.entry.path)
    setToast({
      text: `Promoted to “${result.entry.title}”`,
      kind: 'info',
      undo: async () => {
        setVault(await call('bible:undoPromote', { vaultId, undo: result.undo }))
        open(path)
      },
    })
  }

  async function setIdeaStatus(card: IdeaCardData, status: 'parked' | 'dropped') {
    await attempt(async () => {
      const current = await call('bible:entry', { vaultId, path: card.path })
      await call('bible:setProperties', {
        vaultId,
        path: card.path,
        changes: [{ key: 'status', value: status }],
        baseVersion: current.version,
      })
    })
    void loadDecisionPage('ideas')
  }

  async function setCopyOriginals(copy: boolean) {
    const result = await attempt(() => call('bible:setSettings', { vaultId, copyOriginals: copy }))
    if (result) setVault(result)
  }

  async function applyKitUpdate(chosen: {
    sections: string[]
    fields: Array<{ section: string; key: string }>
  }) {
    setKitOpen(false)
    const result = await attempt(() => call('bible:applyKitUpdate', { vaultId, ...chosen }))
    if (!result) return
    setVault(result)
    setToast({ text: 'Added from the starter kit', kind: 'info' })
    if (selectedRef.current !== null) setDiskTick((tick) => tick + 1)
  }

  async function dismissKitUpdate() {
    setKitOpen(false)
    const result = await attempt(() => call('bible:dismissKitUpdate', { vaultId }))
    if (result) setVault(result)
  }

  async function reorder(section: string, paths: string[], moved: string) {
    const result = await attempt(() =>
      call('bible:reorderEntries', { vaultId, section, paths, moved }),
    )
    if (!result) return
    setVault(result)
    setFocusPath(moved)
    if (pageRef.current === 'pillars') void loadPillars()
  }

  function moveStep(path: string, step: number) {
    const section = sectionOf(path)
    if (!section) return
    const paths = section.entries.map((entry) => entry.path)
    const at = paths.indexOf(path)
    const to = at + step
    if (at === -1 || to < 0 || to >= paths.length) return
    paths.splice(at, 1)
    paths.splice(to, 0, path)
    void reorder(section.id, paths, path)
  }

  function entryAction(path: string, title: string, action: EntryAction) {
    if (action.kind === 'rename') {
      setRenamingEntry(path)
      setRenameDraft(title)
    } else if (action.kind === 'duplicate') void duplicate(path)
    else if (action.kind === 'move') void moveToSection(path, action.section)
    else if (action.kind === 'up') moveStep(path, -1)
    else if (action.kind === 'down') moveStep(path, 1)
    else void deleteEntry(path, title)
  }

  function onEntryKey(event: KeyboardEvent<HTMLButtonElement>, path: string, title: string) {
    if (event.key === 'F2') {
      event.preventDefault()
      entryAction(path, title, { kind: 'rename' })
    } else if (event.key === 'Delete') {
      event.preventDefault()
      void deleteEntry(path, title)
    } else if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault()
      moveStep(path, event.key === 'ArrowUp' ? -1 : 1)
    } else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      event.preventDefault()
      setEntryMenu(path)
    }
  }

  async function commitEntryRename(event: FormEvent | null, path: string, title: string) {
    event?.preventDefault()
    setRenamingEntry(null)
    const next = renameDraft.trim()
    if (next !== '' && next !== title) await renameEntry(path, next)
    else setFocusPath(path)
  }

  // ---- drag and drop -------------------------------------------------------

  function onDragOverEntry(event: DragEvent<HTMLElement>, section: string, path: string) {
    if (!event.dataTransfer.types.includes(ENTRY_DRAG)) return
    event.preventDefault()
    event.stopPropagation()
    const box = event.currentTarget.getBoundingClientRect()
    const list = vault.sections.find((candidate) => candidate.id === section)?.entries ?? []
    const at = list.findIndex((entry) => entry.path === path)
    const before = event.clientY < box.top + box.height / 2 ? path : (list[at + 1]?.path ?? null)
    setDropTarget({ section, before })
  }

  function onDragOverSection(event: DragEvent<HTMLElement>, section: string) {
    if (!event.dataTransfer.types.includes(ENTRY_DRAG)) return
    event.preventDefault()
    setDropTarget({ section, before: null })
  }

  async function onDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault()
    event.stopPropagation()
    const moved = event.dataTransfer.getData(ENTRY_DRAG)
    const target = dropTarget
    setDragging(null)
    setDropTarget(null)
    if (!moved || !target) return
    let path = moved
    let view = vault
    if (sectionOf(moved)?.id !== target.section) {
      // Onto another section: move the file there, then into place.
      const result = await moveToSection(moved, target.section)
      if (!result) return
      path = result.path
      view = result.vault
    }
    const current = view.sections.find((section) => section.id === target.section)?.entries ?? []
    const paths = current.map((entry) => entry.path).filter((candidate) => candidate !== path)
    const at = target.before === null ? -1 : paths.indexOf(target.before)
    paths.splice(at === -1 ? paths.length : at, 0, path)
    if (paths.join('\n') !== current.map((entry) => entry.path).join('\n')) {
      await reorder(target.section, paths, path)
    }
  }

  // ---- sections ------------------------------------------------------------

  async function submitNewEntry(event: FormEvent, section: string) {
    event.preventDefault()
    const title = newTitle.trim()
    if (!title) return
    if (await createEntry(section, title, null)) {
      setAdding(null)
      setNewTitle('')
      if (section === PILLARS && pageRef.current === 'pillars') void loadPillars()
    }
  }

  async function answerFirstRun(result: { answer: string; name: string } | null) {
    setAsking(false)
    if (result === null) return
    const pillars = vault.sections.find((section) => section.id === PILLARS) ?? vault.sections[0]
    if (!pillars) return
    await createEntry(pillars.id, result.name, null, result.answer)
  }

  async function undo() {
    const action = toast?.undo
    setToast(null)
    if (action) await attempt(action)
  }

  async function setSections(next: Array<{ id: string | null; name: string }>) {
    const result = await attempt(() => call('bible:setSections', { vaultId, sections: next }))
    if (result) setVault(result)
  }

  const sectionDrafts = () =>
    vault.sections.map(({ id, name }) => ({ id: id as string | null, name }))

  function moveSection(id: string, step: number) {
    const list = sectionDrafts()
    const from = list.findIndex((section) => section.id === id)
    const to = from + step
    if (from < 0 || to < 0 || to >= list.length) return
    const [moved] = list.splice(from, 1)
    if (moved) list.splice(to, 0, moved)
    void setSections(list)
  }

  async function removeSection(id: string, name: string) {
    setRemoving(null)
    const result = await attempt(() => call('bible:removeSection', { vaultId, sectionId: id }))
    if (!result) return
    setVault(result.vault)
    if (selectedRef.current?.startsWith(`${id}/`)) setSelected(null)
    setToast({
      text: `Moved section “${name}” to .trash`,
      kind: 'info',
      undo: async () => {
        setVault(
          await call('bible:restoreSection', {
            vaultId,
            trashPath: result.trashPath,
            section: result.section,
            position: result.position,
          }),
        )
      },
    })
  }

  async function saveFields(sectionId: string, drafts: FieldDraft[]) {
    const fields = drafts.map((draft) => ({
      key: draft.key,
      label: draft.label.trim(),
      type: draft.type,
      ...(draft.type === 'select' || draft.type === 'multi-select'
        ? { options: draft.options.filter((option) => option !== '') }
        : {}),
      ...((draft.type === 'entry' || draft.type === 'entries') && draft.section
        ? { section: draft.section }
        : {}),
    }))
    const result = await attempt(() =>
      call('bible:setSectionFields', { vaultId, sectionId, fields }),
    )
    if (!result) return false
    setVault(result)
    if (selectedRef.current !== null) setDiskTick((tick) => tick + 1)
    if (pageRef.current === 'pillars') void loadPillars()
    return true
  }

  // ---- trash ---------------------------------------------------------------

  async function restoreTrash(item: TrashItemData) {
    const result = await attempt(() =>
      call('bible:restoreTrash', { vaultId, trashPath: item.trashPath }),
    )
    if (!result) return
    setVault(result.vault)
    setToast({ text: `Restored “${item.name}”`, kind: 'info' })
    void loadTrash()
  }

  async function purgeTrash(item: TrashItemData) {
    const result = await attempt(() =>
      call('bible:purgeTrash', { vaultId, trashPath: item.trashPath }),
    )
    if (!result) return
    trashSeq.current += 1
    setTrash(result.items)
    setToast({ text: `Deleted “${item.name}” permanently`, kind: 'info' })
  }

  const noPillarCount = vault.sections.reduce(
    (count, section) => count + section.entries.filter((entry) => entry.noPillar).length,
    0,
  )
  const sectionNameOf = (id: string) =>
    vault.sections.find((section) => section.id === id)?.name ?? id
  const pillarCount = vault.sections.find((section) => section.id === PILLARS)?.entries.length ?? 0
  const fieldsSection = vault.sections.find((section) => section.id === fieldsFor)

  return (
    <div className="bible-app">
      <aside className="bible-sidebar" aria-label={journal ? 'Journal' : 'Bible'}>
        <div className="bible-vault-head">
          <div className="s-eyebrow">{journal ? 'Journal' : 'Bible'}</div>
          <div className="bible-vault-title" title={vault.vault.path}>
            {vault.vault.title}
          </div>
          <button type="button" className="bible-switch" onClick={onSwitch}>
            {journal ? 'Journal folder…' : 'Switch bible…'}
          </button>
        </div>
        {vault.kitUpdate && (
          <button
            type="button"
            className="kit-notice"
            data-testid="kit-notice"
            onClick={() => setKitOpen(true)}
          >
            Kit updates available
          </button>
        )}

        <label className="search bible-search">
          <SearchIcon />
          <input
            type="search"
            aria-label={`Search the ${noun}`}
            placeholder="Search titles and text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>

        {journal && (
          <nav className="journal-nav" aria-label="Journal pages">
            {(['today', 'calendar'] as const).map((which) => (
              <button
                key={which}
                type="button"
                className={'board-item' + (page === which ? ' active' : '')}
                aria-current={page === which ? 'page' : undefined}
                onClick={() => showPage(which)}
              >
                <span className="board-name">{which === 'today' ? 'Today' : 'Calendar'}</span>
              </button>
            ))}
          </nav>
        )}

        {hits !== null ? (
          <div className="bible-hits" data-testid="search-results">
            {hits.length === 0 && <div className="board-empty">No entries match.</div>}
            {hits.map((hit) => (
              <button
                key={hit.path}
                type="button"
                className={'bible-hit' + (hit.path === selected ? ' active' : '')}
                onClick={() => open(hit.path)}
              >
                <span className="bible-hit-title">{hit.title}</span>
                <Snippet text={hit.snippet} />
              </button>
            ))}
          </div>
        ) : (
          <nav className="bible-sections" aria-label="Sections">
            {vault.sections.map((section, index) => (
              <div
                key={section.id}
                className={
                  'bible-section' +
                  (dropTarget?.section === section.id && dropTarget.before === null
                    ? ' drop-end'
                    : '')
                }
                data-section={section.id}
                onDragOver={(event) => onDragOverSection(event, section.id)}
                onDrop={(event) => void onDrop(event)}
              >
                <div className="bible-section-head">
                  {renamingSection === section.id ? (
                    <form
                      className="bible-inline-form"
                      onSubmit={(event) => {
                        event.preventDefault()
                        setRenamingSection(null)
                        const name = sectionName.trim()
                        if (name && name !== section.name) {
                          void setSections(
                            sectionDrafts().map((item) =>
                              item.id === section.id ? { ...item, name } : item,
                            ),
                          )
                        }
                      }}
                    >
                      <input
                        aria-label="Section name"
                        autoFocus
                        value={sectionName}
                        onChange={(event) => setSectionName(event.target.value)}
                        onBlur={(event) => event.currentTarget.form?.requestSubmit()}
                      />
                    </form>
                  ) : sectionPages[section.id] ? (
                    <button
                      type="button"
                      className={
                        's-eyebrow bible-section-name bible-section-link' +
                        (page === sectionPages[section.id]?.page ? ' active' : '')
                      }
                      title={sectionPages[section.id]?.hint}
                      onClick={() => showPage(sectionPages[section.id]?.page ?? null)}
                    >
                      {section.name}
                    </button>
                  ) : (
                    <span className="s-eyebrow bible-section-name">{section.name}</span>
                  )}
                  <span className="board-count">{section.entries.length}</span>
                  <button
                    type="button"
                    className="bible-icon-button"
                    aria-label={`New entry in ${section.name}`}
                    onClick={() => {
                      setAdding(section.id)
                      setNewTitle('')
                    }}
                  >
                    <PlusIcon size={12} />
                  </button>
                  <button
                    type="button"
                    className="bible-icon-button"
                    aria-label={`${section.name} section options`}
                    aria-expanded={sectionMenu === section.id}
                    onClick={() => setSectionMenu(sectionMenu === section.id ? null : section.id)}
                  >
                    ⋯
                  </button>
                  {sectionMenu === section.id && (
                    <div
                      className="bible-menu"
                      role="menu"
                      onMouseLeave={() => setSectionMenu(null)}
                    >
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setSectionMenu(null)
                          setRenamingSection(section.id)
                          setSectionName(section.name)
                        }}
                      >
                        Rename
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setSectionMenu(null)
                          setFieldsFor(section.id)
                        }}
                      >
                        Fields…
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        disabled={index === 0}
                        onClick={() => {
                          setSectionMenu(null)
                          moveSection(section.id, -1)
                        }}
                      >
                        Move up
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        disabled={index === vault.sections.length - 1}
                        onClick={() => {
                          setSectionMenu(null)
                          moveSection(section.id, 1)
                        }}
                      >
                        Move down
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        className="danger"
                        onClick={() => {
                          setSectionMenu(null)
                          setRemoving({
                            id: section.id,
                            name: section.name,
                            count: section.entries.length,
                          })
                        }}
                      >
                        Remove…
                      </button>
                    </div>
                  )}
                </div>
                {adding === section.id && (
                  <form
                    className="bible-inline-form"
                    onSubmit={(event) => void submitNewEntry(event, section.id)}
                  >
                    <input
                      aria-label="New entry title"
                      autoFocus
                      placeholder="Title"
                      value={newTitle}
                      onChange={(event) => setNewTitle(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Escape') setAdding(null)
                      }}
                      onBlur={() => {
                        if (!newTitle.trim()) setAdding(null)
                      }}
                    />
                    {section.id === PILLARS && pillarCount >= PILLAR_SOFT_LIMIT && (
                      <p className="pillars-note small" role="note">
                        This will be pillar {pillarCount + 1}. Five or fewer keeps them useful as
                        filters.
                      </p>
                    )}
                  </form>
                )}
                {section.entries.map((entry, at) => (
                  <div
                    key={entry.path}
                    className={
                      'bible-entry-row' +
                      (dragging === entry.path ? ' dragging' : '') +
                      (dropTarget?.before === entry.path ? ' drop-before' : '')
                    }
                    onDragOver={(event) => onDragOverEntry(event, section.id, entry.path)}
                    onDrop={(event) => void onDrop(event)}
                  >
                    {renamingEntry === entry.path ? (
                      <form
                        className="bible-inline-form"
                        onSubmit={(event) => void commitEntryRename(event, entry.path, entry.title)}
                      >
                        <input
                          aria-label="Rename entry"
                          autoFocus
                          value={renameDraft}
                          onFocus={(event) => event.currentTarget.select()}
                          onChange={(event) => setRenameDraft(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Escape') {
                              setRenamingEntry(null)
                              setFocusPath(entry.path)
                            }
                          }}
                          onBlur={() => void commitEntryRename(null, entry.path, entry.title)}
                        />
                      </form>
                    ) : (
                      <button
                        type="button"
                        className={
                          'board-item bible-entry' + (entry.path === selected ? ' active' : '')
                        }
                        aria-current={entry.path === selected ? 'page' : undefined}
                        aria-keyshortcuts="F2 Delete Alt+ArrowUp Alt+ArrowDown Shift+F10"
                        data-path={entry.path}
                        ref={(node) => {
                          if (node && focusPath.current === entry.path) {
                            focusPath.current = null
                            node.focus()
                          }
                        }}
                        draggable
                        onClick={() => open(entry.path)}
                        onKeyDown={(event) => onEntryKey(event, entry.path, entry.title)}
                        onContextMenu={(event) => {
                          event.preventDefault()
                          setEntryMenu(entry.path)
                        }}
                        onDragStart={(event) => {
                          event.dataTransfer.setData(ENTRY_DRAG, entry.path)
                          event.dataTransfer.effectAllowed = 'move'
                          setDragging(entry.path)
                        }}
                        onDragEnd={() => {
                          setDragging(null)
                          setDropTarget(null)
                        }}
                      >
                        <span className="board-name">{entry.title}</span>
                        {entry.noPillar && (
                          <span
                            className="entry-flag no-pillar-flag"
                            aria-hidden="true"
                            title="Serves no pillar"
                          />
                        )}
                        {entry.stale && (
                          <span
                            className="entry-flag stale-flag"
                            aria-hidden="true"
                            title="May be out of date"
                          />
                        )}
                      </button>
                    )}
                    <button
                      type="button"
                      className="bible-icon-button entry-more"
                      aria-label={`Actions for ${entry.title}`}
                      aria-haspopup="menu"
                      aria-expanded={entryMenu === entry.path}
                      onClick={() => setEntryMenu(entryMenu === entry.path ? null : entry.path)}
                    >
                      ⋯
                    </button>
                    {entryMenu === entry.path && (
                      <EntryMenu
                        title={entry.title}
                        sections={sectionList}
                        currentSection={section.id}
                        canMoveUp={at > 0}
                        canMoveDown={at < section.entries.length - 1}
                        onClose={() => {
                          setEntryMenu(null)
                          setFocusPath(entry.path)
                        }}
                        onAction={(action) => entryAction(entry.path, entry.title, action)}
                      />
                    )}
                  </div>
                ))}
              </div>
            ))}
            {addingSection ? (
              <form
                className="bible-inline-form"
                onSubmit={(event) => {
                  event.preventDefault()
                  setAddingSection(false)
                  const name = sectionName.trim()
                  if (name) void setSections([...sectionDrafts(), { id: null, name }])
                }}
              >
                <input
                  aria-label="New section name"
                  autoFocus
                  placeholder="Section name"
                  value={sectionName}
                  onChange={(event) => setSectionName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') setAddingSection(false)
                  }}
                />
              </form>
            ) : (
              <button
                type="button"
                className="board-add"
                onClick={() => {
                  setAddingSection(true)
                  setSectionName('')
                }}
              >
                <PlusIcon size={12} /> Add section
              </button>
            )}
          </nav>
        )}
        {noPillarCount > 0 && (
          <button
            type="button"
            className={'board-item bible-review-button' + (page === 'review' ? ' active' : '')}
            onClick={() => showPage('review')}
          >
            <span className="board-name">Serves no pillar</span>
            <span className="board-count">{noPillarCount}</span>
          </button>
        )}
        <button
          type="button"
          className={'board-item bible-trash-button' + (page === 'trash' ? ' active' : '')}
          onClick={() => showPage('trash')}
        >
          <TrashIcon /> <span className="board-name">Trash</span>
        </button>
      </aside>

      <main className="bible-main">
        {page === 'pillars' ? (
          <PillarsPage
            cards={cards}
            sections={sectionList}
            onOpen={open}
            onAdd={() => {
              setAdding(PILLARS)
              setNewTitle('')
            }}
            onReorder={(paths, moved) => void reorder(PILLARS, paths, moved)}
            onAction={(path, title, action) => entryAction(path, title, action)}
            onRename={async (path, title) => {
              const ok = await renameEntry(path, title)
              if (ok) void loadPillars()
              return ok
            }}
          />
        ) : page === 'timeline' ? (
          <TimelinePage
            items={timeline}
            onOpen={open}
            onAdd={() => {
              setAdding('decisions')
              setNewTitle('')
            }}
          />
        ) : page === 'ideas' ? (
          <IdeasBoard
            cards={ideaCards}
            onOpen={open}
            onAdd={() => {
              setAdding('ideas')
              setNewTitle('')
            }}
            onPromote={(card) => setPromoting({ path: card.path, title: card.title })}
            onStatus={(card, status) => void setIdeaStatus(card, status)}
          />
        ) : page === 'review' ? (
          <ReviewPage items={review} sectionName={sectionNameOf} onOpen={open} />
        ) : page === 'today' ? (
          <TodayPage
            vaultId={vaultId}
            onRecapSaved={(saved) => {
              setVault(saved.vault)
              open(saved.entry.path)
            }}
            today={todayView}
            entries={entries}
            onNewSession={() => void newSession()}
            onOpen={open}
            onCreateLinked={(title) => createFromLink(title, 'sessions')}
            onExternal={setExternalUrl}
          />
        ) : page === 'calendar' ? (
          <CalendarPage
            year={calendarYear}
            today={todayView?.today ?? localToday()}
            days={calendarDays}
            onYear={showYear}
            onOpen={open}
          />
        ) : page === 'resources' ? (
          <ResourcesPage
            items={resources}
            onOpen={open}
            onExternal={setExternalUrl}
            onAdd={() => {
              setAdding('resources')
              setNewTitle('')
            }}
          />
        ) : page === 'trash' ? (
          <TrashView
            items={trash}
            onRestore={(item) => void restoreTrash(item)}
            onPurge={(item) => void purgeTrash(item)}
          />
        ) : selected !== null && selectedSection ? (
          <EntryEditor
            key={selected}
            vaultId={vaultId}
            path={selected}
            sectionId={selectedSection.id}
            sectionName={selectedSection.name}
            sections={sectionList}
            entries={entries}
            tagOptions={tagOptions}
            canMoveUp={selectedSection.entries[0]?.path !== selected}
            canMoveDown={selectedSection.entries.at(-1)?.path !== selected}
            diskTick={diskTick}
            flushRef={flushRef}
            onOpen={open}
            onCreateLinked={(title) => createFromLink(title, selectedSection.id)}
            onCreateIn={(title, section) => void createEntry(section, title, null)}
            onPromote={() => {
              const title = entries.find((entry) => entry.path === selected)?.title ?? ''
              setPromoting({ path: selected, title })
            }}
            onExternal={setExternalUrl}
            copyOriginals={vault.settings.copyOriginals}
            onCopyOriginals={(copy) => void setCopyOriginals(copy)}
            onRename={(title) => renameEntry(selected, title)}
            onAction={(action) => {
              const title = entries.find((entry) => entry.path === selected)?.title ?? ''
              entryAction(selected, title, action)
            }}
            onError={showError}
            role={journal ? 'journal' : 'bible'}
            onNotice={(text) => setToast({ text, kind: 'info' })}
          />
        ) : (
          <div className="bible-editor-empty">
            <h2>{vault.vault.title}</h2>
            <p>Pick an entry on the left, or add one with + next to a section.</p>
          </div>
        )}
      </main>

      {asking && <FirstPillar onDone={(result) => void answerFirstRun(result)} />}
      {kitOpen && vault.kitUpdate && (
        <KitUpdateDialog
          update={vault.kitUpdate}
          onApply={(chosen) => void applyKitUpdate(chosen)}
          onDismiss={() => void dismissKitUpdate()}
          onClose={() => setKitOpen(false)}
        />
      )}
      {picker && (
        <SectionPicker
          title={picker.title}
          sections={vault.sections}
          initial={picker.initial}
          onPick={(section) => {
            setPicker(null)
            void createEntry(section, picker.title, null, undefined, picker.from)
          }}
          onClose={() => setPicker(null)}
        />
      )}
      {promoting && (
        <PromoteDialog
          ideaTitle={promoting.title}
          sections={vault.sections}
          onPromote={(section, title) => void promote(promoting.path, section, title)}
          onClose={() => setPromoting(null)}
        />
      )}
      {swapOffer && (
        <ConfirmDialog
          title={`Use the ${swapOffer.to} template?`}
          message={`This entry still has only the template of the section it came from. Replace it with the ${swapOffer.to} template? Its properties stay as they are.`}
          confirmLabel="Use new template"
          onConfirm={() => void swapTemplate(swapOffer)}
          onCancel={() => setSwapOffer(null)}
        />
      )}
      {externalUrl && (
        <ExternalLinkDialog
          url={externalUrl}
          onOpen={() => {
            const url = externalUrl
            setExternalUrl(null)
            void attempt(() => call('app:openExternal', { url }))
          }}
          onClose={() => setExternalUrl(null)}
        />
      )}
      {fieldsSection && (
        <SectionFields
          sectionName={fieldsSection.name}
          fields={fieldsSection.fields.filter((field) => !field.builtIn)}
          builtIn={fieldsSection.fields.filter((field) => field.builtIn)}
          sections={sectionList}
          onSave={(drafts) => saveFields(fieldsSection.id, drafts)}
          onClose={() => setFieldsFor(null)}
        />
      )}
      {removing && (
        <ConfirmDialog
          title={`Remove section “${removing.name}”?`}
          message={
            removing.count > 0
              ? `Its folder and ${removing.count} ${removing.count === 1 ? 'entry move' : 'entries move'} to the ${noun}'s .trash folder. You can undo this.`
              : `Its folder moves to the ${noun}'s .trash folder. You can undo this.`
          }
          confirmLabel="Remove section"
          onConfirm={() => void removeSection(removing.id, removing.name)}
          onCancel={() => setRemoving(null)}
        />
      )}
      {toast && (
        <div className={'toast ' + toast.kind} role="status" data-testid="toast">
          <span data-testid="toast-text">{toast.text}</span>
          {toast.undo && (
            <button type="button" className="toast-action" onClick={() => void undo()}>
              Undo
            </button>
          )}
          <button
            type="button"
            className="toast-close"
            aria-label="Dismiss"
            onClick={() => setToast(null)}
          >
            <XIcon />
          </button>
        </div>
      )}
    </div>
  )
}

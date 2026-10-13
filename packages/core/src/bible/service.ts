import { sniffImageMime, toFtsQuery } from '../references/rules.ts'
import {
  ASSET_PATH,
  ASSETS_DIR,
  REFERENCES_KEY,
  assetFileName,
  assetLinkFrom,
  resolveVaultLink,
} from './assets.ts'
import {
  DATE_KEY,
  DECISIONS,
  IDEAS,
  IDEA_STATUSES,
  KIND_FIELDS,
  PILLARS,
  PILLARS_KEY,
  PROMOTED_FROM,
  PROMOTED_TO,
  STATUS_KEY,
  byDecisionDate,
  fieldRefs,
  isStale,
  kindDefaults,
  sectionFields,
} from './decisions.ts'
import {
  AI_GENERATED_KEY,
  JOURNAL_KIT,
  MINUTES_KEY,
  RECAP_WEEK_DAYS,
  SOURCE_SESSIONS_KEY,
  recapText,
  RATING_KEY,
  RESOURCES,
  SESSIONS,
  TOPICS,
  TOPICS_KEY,
  URL_KEY,
  calendarDays,
  journalDefaults,
  localDate,
  nextTimeSection,
  sessionDay,
  sessionTitle,
  todayAndPrevious,
  type CalendarDay,
  type DatedSession,
} from './journal.ts'
import {
  applyKitUpdate,
  isEmptyUpdate,
  kitFingerprint,
  kitUpdate,
  type KitUpdate,
} from './kitUpdates.ts'
import {
  cleanTags,
  emptyFieldYaml,
  refKey,
  fieldKeyFromLabel,
  formatFieldInput,
  isFieldKey,
  parseFieldDefs,
  readFieldValue,
  type EntryRef,
  type FieldDef,
  type FieldValue,
} from './fields.ts'
import {
  joinEntryFile,
  parseEntry,
  setFields,
  splitEntryFile,
  yamlList,
  yamlString,
} from './frontMatter.ts'
import { rewriteLinks } from './links.ts'
import { fillFirstHeading, pillarParts } from './pillars.ts'
import type {
  BibleClock,
  BibleIndex,
  IndexRow,
  LibraryAssets,
  StarterKits,
  VaultFiles,
  VaultWatcher,
} from './ports.ts'
import { slugify, titleKey, uniqueName } from './slug.ts'
import {
  SECTIONS_TRASH,
  TRASH_LOG,
  parseTrashLog,
  serializeTrashLog,
  withoutTrashSuffix,
  type TrashRecord,
} from './trash.ts'
import {
  TRASH_DIR,
  VAULT_FORMAT,
  type ConfigSection,
  type EntryListItem,
  type EntrySummary,
  type IdeaCard,
  type PracticeImage,
  type RecapSource,
  type ResourceItem,
  type SessionSummary,
  type TimelineItem,
  type TodayView,
  type TopicProgress,
  type VaultRole,
  type VaultSettings,
  type EntryView,
  type IndexedEntry,
  type PillarCard,
  type PropertyView,
  type RecentVault,
  type SearchHit,
  type Section,
  type StarterKit,
  type TrashItem,
  type VaultConfig,
  type VaultView,
} from './types.ts'
import {
  CONFIG_FILE,
  README_FILE,
  VaultError,
  isSectionId,
  newSectionId,
  parseVaultConfig,
  serializeVaultConfig,
  vaultReadme,
} from './vaultConfig.ts'

export { VaultError }

export interface BibleServiceDeps {
  files: VaultFiles
  index: BibleIndex
  watcher: VaultWatcher
  kits: StarterKits
  clock: BibleClock
  /** A new random entry id. */
  newId: () => string
  /** Called after files changed on disk and the index caught up. */
  onChanged: (event: { vaultId: number; paths: string[] }) => void
  /** The Library, for copying reference images into a vault; absent in tests that do not need it. */
  library?: LibraryAssets
  /** Which vaults this service opens: game bibles (the default) or the study journal. */
  role?: VaultRole
  /** SHA-256 of image bytes, to name files in _assets; needed for images not from the Library. */
  hasher?: { sha256(bytes: Uint8Array): string }
}

/** An image to put in a vault: the original and its thumbnail, as the UI prepared them. */
export interface ImageInput {
  fileName: string
  bytes: Uint8Array
  thumbnail: { bytes: Uint8Array }
}

/** What one look over the index finds: who serves which pillar, what may be out of date. */
interface Analysis {
  rows: IndexRow[]
  byPath: Map<string, IndexRow>
  resolve: (target: string) => IndexRow | null
  stale: Set<string>
  noPillar: Set<string>
  servedBy: Map<string, IndexRow[]>
}

/** What undoing a promote needs: both files as they were, and as the promote left them. */
interface PromoteUndo {
  vaultId: number
  ideaPath: string
  ideaBefore: string
  ideaAfter: string
  targetPath: string
  targetAfter: string
}

export const VAULT_FOLDER = 'bible'
export const PILLARS_SECTION = 'pillars'
const ENTRY_EXTENSION = '.md'
// An image a journal entry lists: any image file in _assets, named by hash or by hand.
const PRACTICE_IMAGE = /^_assets\/[^/\\]+\.(png|jpe?g|webp|gif|avif|bmp)$/i
const MAX_TITLE_LENGTH = 200
const RECENT_LIMIT = 10
const SEARCH_LIMIT = 50
const UNORDERED = Number.MAX_SAFE_INTEGER
// A vault-relative entry path: <section>/<file>.md, no folders below it.
const ENTRY_PATH = /^([\p{L}\p{N}][\p{L}\p{N}_-]*)\/([^/\\]+\.md)$/u
const TRASH_ENTRY = /^\.trash\/([\p{L}\p{N}][\p{L}\p{N}_-]*)\/([^/\\]+\.md)$/u
const TRASH_SECTION = /^\.trash\/(?:_sections\/)?([\p{L}\p{N}][\p{L}\p{N}_~-]*)$/u

interface OpenVault {
  id: number
  root: string
  config: VaultConfig
  stopWatching: () => Promise<void>
}

export type SaveResult =
  { status: 'saved'; entry: EntryView } | { status: 'conflict'; theirs: EntryView }

/** A field change from the Properties panel; key "tags" sets the tags. */
export interface PropertyChange {
  key: string
  value: FieldValue
}

/** A field definition from section settings; key null adds a field (its key comes from the label). */
export interface FieldInput {
  key: string | null
  label: string
  type: FieldDef['type']
  options?: string[] | undefined
  section?: string | undefined
}

function isHidden(name: string): boolean {
  return name.startsWith('.')
}

function cleanTitle(title: string): string {
  const clean = title.replace(/[\r\n]+/g, ' ').trim()
  if (clean === '') throw new VaultError('A title cannot be empty')
  if (clean.length > MAX_TITLE_LENGTH)
    throw new VaultError(`A title can be at most ${MAX_TITLE_LENGTH} characters`)
  if (/[[\]|#]/.test(clean))
    throw new VaultError('A title cannot contain [ ] | or #, which links use')
  return clean
}

function fileTitle(name: string): string {
  return name.slice(0, -ENTRY_EXTENSION.length).replace(/[-_]+/g, ' ').trim() || 'Untitled'
}

/** The vault-relative image paths an entry lists in "references". */
function referencePaths(fields: Record<string, unknown>): string[] {
  const raw = fields[REFERENCES_KEY]
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : []
  return list.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
}

/** Alt text for an image link: no brackets, which would end it early. */
function altText(text: string): string {
  return text.replace(/[[\]]/g, '')
}

/** A field value as a list of strings: a list, or one string. */
function asStrings(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : []
  return list.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
}

function summaryOf(session: DatedSession): SessionSummary {
  return { path: session.path, title: session.title, date: session.date }
}

/** Inserts `suffix` before the extension: "a.md" -> "a~x.md". */
function withSuffix(name: string, suffix: string): string {
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? `${name}${suffix}` : `${name.slice(0, dot)}${suffix}${name.slice(dot)}`
}

/**
 * The Creative Bible: a vault of Markdown files is the source of truth; the
 * index only mirrors it, so any part of it can be rebuilt from the files.
 */
export class BibleService {
  private readonly deps: BibleServiceDeps
  private current: OpenVault | null = null
  /** Operations that rewrite bible.json run one after another (see exclusive). */
  private configWork: Promise<unknown> = Promise.resolve()
  private configBusy = 0
  private readonly promotes = new Map<string, PromoteUndo>()
  private promoteCount = 0

  constructor(deps: BibleServiceDeps) {
    this.deps = deps
  }

  private get role(): VaultRole {
    return this.deps.role ?? 'bible'
  }

  /** The word for this service's vaults in messages. */
  private get noun(): string {
    return this.role === 'journal' ? 'journal' : 'bible'
  }

  /** The starter kits for this service's vaults (bible kits, or the Journal kit). */
  kits(): StarterKit[] {
    return this.deps.kits.list().filter((kit) => kit.role === this.role)
  }

  /** True when the open vault is this one. */
  owns(vaultId: number): boolean {
    return this.current?.id === vaultId
  }

  /** Tags used in the open vault (none when no vault is open). */
  openVaultTags(): string[] {
    return this.current ? this.deps.index.vaultTags(this.current.id) : []
  }

  recent(): RecentVault[] {
    const { files, index } = this.deps
    return index.recentVaults(RECENT_LIMIT, this.role).map((vault) => ({
      ...vault,
      exists: files.exists(files.join(vault.path, CONFIG_FILE)),
    }))
  }

  /**
   * The open vault, or the most recently opened one, reopened. When that fails
   * (moved, deleted, unreadable) the reason comes back instead.
   */
  async home(): Promise<{ current: VaultView | null; problem: string | null }> {
    if (this.current) return { current: this.view(this.current.id), problem: null }
    const last = this.deps.index.recentVaults(1, this.role)[0]
    if (!last) return { current: null, problem: null }
    try {
      return { current: await this.open(last.path), problem: null }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      return { current: null, problem: `Could not reopen ${last.path}: ${reason}` }
    }
  }

  /**
   * Creates a vault with the kit's sections, bible.json and README.md, then
   * opens it: a bible in <folder>/bible, the journal in <folder> itself.
   */
  async create(folder: string, kitId: string, title: string): Promise<VaultView> {
    const { files } = this.deps
    const kit = this.kits().find((candidate) => candidate.id === kitId)
    if (!kit) throw new VaultError(`Unknown starter kit: ${kitId}`)
    const vaultTitle = cleanTitle(title)
    const root = this.role === 'journal' ? folder : files.join(folder, VAULT_FOLDER)
    if (files.exists(files.join(root, CONFIG_FILE))) {
      throw new VaultError(`This folder already has a ${this.noun}. Use Open ${this.noun} instead.`)
    }
    if (files.list(root).length > 0) {
      throw new VaultError(`${root} already exists and is not empty. Pick another folder.`)
    }
    const sections: ConfigSection[] = kit.sections.map(({ id, name, fields }) => ({
      id,
      name,
      fields,
      extra: {},
    }))
    files.mkdir(root)
    for (const section of sections) files.mkdir(files.join(root, section.id))
    const config: VaultConfig = {
      format: VAULT_FORMAT,
      title: vaultTitle,
      kit: kit.id,
      sections,
      extra: {},
    }
    await files.writeTextAtomic(files.join(root, CONFIG_FILE), serializeVaultConfig(config))
    files.createText(files.join(root, README_FILE), vaultReadme(vaultTitle, sections))
    return this.open(root)
  }

  /** Opens a vault folder: brings the index up to date with the files and starts watching. */
  async open(folder: string): Promise<VaultView> {
    const { files, index, clock, watcher } = this.deps
    // The game project folder works too: its bible/ subfolder is opened.
    const nested = files.join(folder, VAULT_FOLDER)
    const root =
      this.role === 'bible' &&
      !files.exists(files.join(folder, CONFIG_FILE)) &&
      files.exists(files.join(nested, CONFIG_FILE))
        ? nested
        : folder
    const configPath = files.join(root, CONFIG_FILE)
    if (!files.exists(configPath)) {
      throw new VaultError(
        `No bible.json in this folder. Pick a ${this.noun} folder, or create a new ${this.noun}.`,
      )
    }
    const config = parseVaultConfig(files.readText(configPath))
    const kitRole = this.deps.kits.list().find((kit) => kit.id === config.kit)?.role ?? 'bible'
    if (kitRole !== this.role) {
      throw new VaultError(
        kitRole === 'journal'
          ? 'This folder is your study journal. Open it from Journal.'
          : 'This folder is a game bible, not a journal. Open it from Bible.',
      )
    }
    await this.close()
    files.removeStaleTemporaryFiles(root)
    for (const section of config.sections)
      files.removeStaleTemporaryFiles(files.join(root, section.id))
    const summary = index.upsertVault(root, config.title, clock.now().toISOString(), this.role)
    const vault: OpenVault = { id: summary.id, root, config, stopWatching: async () => undefined }
    this.current = vault
    this.reconcile(vault)
    vault.stopWatching = await watcher.watch(root, (paths) => this.filesChanged(vault, paths))
    return this.view(vault.id)
  }

  async close(): Promise<void> {
    const vault = this.current
    this.current = null
    if (vault) await vault.stopWatching()
  }

  /** The vault that is open, checking that `vaultId` names it. */
  private vault(vaultId: number): OpenVault {
    const vault = this.current
    if (!vault || vault.id !== vaultId) throw new VaultError(`That ${this.noun} is not open`)
    return vault
  }

  private section(vault: OpenVault, sectionId: string): ConfigSection {
    const section = vault.config.sections.find((candidate) => candidate.id === sectionId)
    if (!section) throw new VaultError(`No section ${sectionId} in this bible`)
    return section
  }

  view(vaultId: number): VaultView {
    const { index } = this.deps
    const vault = this.vault(vaultId)
    const bySection = new Map<string, EntryListItem[]>()
    const analysis = this.analyse(vault)
    const all = analysis.rows
    for (const entry of all) {
      const list = bySection.get(entry.section) ?? []
      list.push({
        path: entry.path,
        title: entry.title,
        id: entry.entryId,
        stale: analysis.stale.has(entry.path),
        noPillar: analysis.noPillar.has(entry.path),
      })
      bySection.set(entry.section, list)
    }
    const last = index.lastEntry(vault.id)
    return {
      vault: { id: vault.id, path: vault.root, title: vault.config.title },
      sections: vault.config.sections.map(({ id, name, fields }) => ({
        id,
        name,
        fields: sectionFields(id, fields),
        entries: bySection.get(id) ?? [],
      })),
      lastEntry: last !== null && all.some((entry) => entry.path === last) ? last : null,
      kitUpdate: this.pendingKitUpdate(vault),
      settings: this.settings(vault),
      role: this.role,
      linkSections: this.linkSections(vault),
    }
  }

  /** Remembered link-picker sections, for sections that still exist. */
  private linkSections(vault: OpenVault): Record<string, string> {
    const known = new Set(vault.config.sections.map((section) => section.id))
    const out: Record<string, string> = {}
    for (const [from, to] of Object.entries(this.deps.index.linkSections(vault.id))) {
      if (known.has(from) && known.has(to)) out[from] = to
    }
    return out
  }

  private absolute(vault: OpenVault, path: string): string {
    return this.deps.files.join(vault.root, ...path.split('/'))
  }

  /** Validates a vault-relative entry path from the UI and returns its section and file name. */
  private entryPath(vault: OpenVault, path: string): { section: string; name: string } {
    const match = ENTRY_PATH.exec(path)
    const section = match?.[1]
    const name = match?.[2]
    if (!section || !name || name.startsWith('.') || name.includes('..')) {
      throw new VaultError(`Not an entry path: ${path}`)
    }
    this.section(vault, section)
    return { section, name }
  }

  /** An existing entry's path and current text. */
  private readExisting(vault: OpenVault, path: string): { file: string; text: string } {
    this.entryPath(vault, path)
    const file = this.absolute(vault, path)
    if (!this.deps.files.exists(file)) throw new VaultError('This entry no longer exists')
    return { file, text: this.deps.files.readText(file) }
  }

  // ---- index -------------------------------------------------------------

  /** Reads one entry file into an index row, or null when it is gone. */
  private readIndexed(vault: OpenVault, path: string): IndexedEntry | null {
    const { files } = this.deps
    const file = this.absolute(vault, path)
    const stat = files.stat(file)
    if (!stat) return null
    const [section = '', name = ''] = path.split('/')
    const parsed = parseEntry(files.readText(file), fileTitle(name))
    return {
      path,
      entryId: parsed.id ?? `path:${path}`,
      section,
      title: parsed.title,
      titleKey: titleKey(parsed.title),
      order: parsed.order ?? UNORDERED,
      updated: parsed.updated,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      body: parsed.body,
      links: parsed.links,
      tags: parsed.tags,
      created: parsed.created,
      refs: fieldRefs(this.fieldsOf(vault, section), parsed.fields),
      assets: referencePaths(parsed.fields)
        .map((asset) => ASSET_PATH.exec(asset)?.[1])
        .filter((hash): hash is string => hash !== undefined),
    }
  }

  private reindex(vault: OpenVault, path: string): void {
    const entry = this.readIndexed(vault, path)
    if (entry) this.deps.index.putEntry(vault.id, entry)
    else this.deps.index.removeEntry(vault.id, path)
  }

  /** Entry files in the vault's sections right now, by vault-relative path. */
  private entryFiles(vault: OpenVault): string[] {
    const { files } = this.deps
    const paths: string[] = []
    for (const section of vault.config.sections) {
      for (const item of files.list(files.join(vault.root, section.id))) {
        if (item.isDirectory || isHidden(item.name) || !item.name.endsWith(ENTRY_EXTENSION))
          continue
        paths.push(`${section.id}/${item.name}`)
      }
    }
    return paths
  }

  /** Brings the index in line with the files: new and changed files are read, missing ones dropped. */
  private reconcile(vault: OpenVault): void {
    const { files, index } = this.deps
    index.inTransaction(() => {
      const known = index.indexedFiles(vault.id)
      const present = new Set<string>()
      for (const path of this.entryFiles(vault)) {
        present.add(path)
        const stat = files.stat(this.absolute(vault, path))
        const seen = known.get(path)
        if (stat && seen && seen.mtimeMs === stat.mtimeMs && seen.size === stat.size) continue
        this.reindex(vault, path)
      }
      for (const path of known.keys()) if (!present.has(path)) index.removeEntry(vault.id, path)
    })
  }

  /** Drops this vault's whole index and reads every file again. */
  rebuildIndex(vaultId: number): VaultView {
    const vault = this.vault(vaultId)
    this.deps.index.inTransaction(() => this.deps.index.clear(vault.id))
    this.reconcile(vault)
    return this.view(vault.id)
  }

  /**
   * Runs an operation that rewrites bible.json after the ones before it. The
   * watcher's re-read of bible.json waits for them too, so it never puts an
   * older section list back in memory halfway through an operation.
   */
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    this.configBusy += 1
    const run = this.configWork.then(work, work).finally(() => {
      this.configBusy -= 1
    })
    this.configWork = run.catch(() => undefined)
    return run
  }

  /** The watcher saw these vault-relative paths change. */
  private filesChanged(vault: OpenVault, paths: string[]): void {
    if (this.configBusy === 0) this.applyFileChanges(vault, paths)
    else void this.configWork.then(() => this.applyFileChanges(vault, paths))
  }

  private applyFileChanges(vault: OpenVault, paths: string[]): void {
    if (this.current !== vault) return
    const { files, index } = this.deps
    let sectionsChanged = false
    index.inTransaction(() => {
      for (const path of paths) {
        if (path === CONFIG_FILE) {
          try {
            vault.config = parseVaultConfig(files.readText(files.join(vault.root, CONFIG_FILE)))
            sectionsChanged = true
          } catch {
            // A half-edited bible.json keeps the last good one until it parses again.
          }
          continue
        }
        const match = ENTRY_PATH.exec(path)
        if (!match || !vault.config.sections.some((section) => section.id === match[1])) continue
        if (match[2]?.startsWith('.')) continue
        this.reindex(vault, path)
      }
    })
    if (sectionsChanged) this.reconcile(vault)
    this.deps.onChanged({ vaultId: vault.id, paths })
  }

  // ---- entries -----------------------------------------------------------

  /** Finds an entry by id, or by title for values typed by hand. */
  private resolver(vault: OpenVault): (idOrTitle: string) => EntryRef | null {
    const entries = this.deps.index.listEntries(vault.id)
    return (idOrTitle) => {
      const byId = entries.find((entry) => entry.entryId === idOrTitle)
      const found = byId ?? entries.find((entry) => entry.titleKey === titleKey(idOrTitle))
      return found
        ? { id: found.entryId, path: found.path, title: found.title, section: found.section }
        : null
    }
  }

  private entryView(vault: OpenVault, path: string, text: string): EntryView {
    const { files, index } = this.deps
    const [section = '', name = ''] = path.split('/')
    const parsed = parseEntry(text, fileTitle(name))
    const resolve = this.resolver(vault)
    const fields = this.fieldsOf(vault, section)
    const analysis = this.analyse(vault)
    const summary = (row: IndexRow | null | undefined): EntrySummary | null =>
      row ? { path: row.path, title: row.title } : null
    const linked = (key: string) => {
      const raw = parsed.fields[key]
      return typeof raw === 'string' && raw.trim() ? summary(analysis.resolve(raw)) : null
    }
    const served = analysis.servedBy.get(path) ?? []
    const properties: PropertyView[] = fields.map((field) => ({
      ...field,
      ...readFieldValue(field, parsed.fields[field.key], resolve),
    }))
    return {
      path,
      id: parsed.id ?? `path:${path}`,
      section,
      title: parsed.title,
      body: parsed.body,
      version: files.hash(text),
      backlinks: index
        .linkingTo(vault.id, titleKey(parsed.title))
        .filter((source) => source.path !== path),
      tags: parsed.tags,
      properties,
      stale: analysis.stale.has(path),
      noPillar: section === DECISIONS || section === IDEAS ? analysis.noPillar.has(path) : null,
      promotedFrom: linked(PROMOTED_FROM),
      promotedTo: linked(PROMOTED_TO),
      servedBy:
        section === PILLARS
          ? {
              decisions: served
                .filter((row) => row.section === DECISIONS)
                .map((row) => ({ path: row.path, title: row.title })),
              ideas: served
                .filter((row) => row.section === IDEAS)
                .map((row) => ({ path: row.path, title: row.title })),
            }
          : null,
      references: referencePaths(parsed.fields),
    }
  }

  getEntry(vaultId: number, path: string): EntryView {
    const vault = this.vault(vaultId)
    const { text } = this.readExisting(vault, path)
    this.deps.index.setLastEntry(vault.id, path)
    return this.entryView(vault, path, text)
  }

  /** Tags for autocomplete: every tag used in this vault. */
  vaultTags(vaultId: number): string[] {
    return this.deps.index.vaultTags(this.vault(vaultId).id)
  }

  private requireFreeTitle(vault: OpenVault, title: string, except: string | null): void {
    const key = titleKey(title)
    const clash = this.deps.index
      .listEntries(vault.id)
      .find((entry) => entry.titleKey === key && entry.path !== except)
    if (clash) throw new VaultError(`An entry called "${clash.title}" already exists`)
  }

  /** The title with " copy" (then " copy 2"...) added until no entry uses it. */
  private freeCopyTitle(vault: OpenVault, title: string): string {
    const used = new Set(this.deps.index.listEntries(vault.id).map((entry) => entry.titleKey))
    const base = `${title} copy`
    for (let count = 1; ; count++) {
      const candidate = count === 1 ? base : `${base} ${count}`
      if (!used.has(titleKey(candidate))) return cleanTitle(candidate)
    }
  }

  private template(vault: OpenVault, sectionId: string): string {
    const kit = this.kits().find((candidate) => candidate.id === vault.config.kit)
    return kit?.sections.find((section) => section.id === sectionId)?.template ?? ''
  }

  /** The next free file name for a title in a section folder. */
  private freeName(vault: OpenVault, sectionId: string, title: string, except?: string): string {
    const { files } = this.deps
    const folder = files.join(vault.root, sectionId)
    return uniqueName(
      slugify(title),
      ENTRY_EXTENSION,
      (candidate) => candidate !== except && files.exists(files.join(folder, candidate)),
    )
  }

  /** One past the highest `order` in a section. */
  private nextOrder(vault: OpenVault, sectionId: string): number {
    const orders = this.deps.index
      .listEntries(vault.id)
      .filter((entry) => entry.section === sectionId && entry.order < UNORDERED)
      .map((entry) => entry.order)
    return Math.floor(Math.max(0, ...orders)) + 1
  }

  /**
   * Creates an entry. `body` null starts from the section's starter-kit
   * template; `intro` then goes under the template's first heading. New
   * entries get every field of their section, empty.
   */
  async createEntry(
    vaultId: number,
    sectionId: string,
    title: string,
    body: string | null,
    intro: string | null = null,
    extraFields: ReadonlyArray<[string, string]> = [],
  ): Promise<{ entry: EntryView; vault: VaultView }> {
    const { files, index, clock, newId } = this.deps
    const vault = this.vault(vaultId)
    this.section(vault, sectionId)
    // Dates are the user's local calendar day, never the UTC one.
    const today = localDate(clock.now())
    const defaults = {
      ...kindDefaults(sectionId, today),
      ...(this.role === 'journal' ? journalDefaults(sectionId, today) : {}),
    }
    const clean = cleanTitle(title)
    this.requireFreeTitle(vault, clean, null)
    files.mkdir(files.join(vault.root, sectionId))
    const path = `${sectionId}/${this.freeName(vault, sectionId, clean)}`
    const now = clock.now().toISOString()
    const frontMatter = setFields(
      '',
      [
        ['id', yamlString(newId())],
        ['title', yamlString(clean)],
        ['tags', yamlList([])],
        ['order', String(this.nextOrder(vault, sectionId))],
        ['created', now],
        ['updated', now],
        ...this.fieldsOf(vault, sectionId).map((field): [string, string] => [
          field.key,
          defaults[field.key] ?? emptyFieldYaml(field),
        ]),
        ...extraFields,
      ],
      '\n',
    )
    let content = body ?? this.template(vault, sectionId)
    if (body === null && intro !== null && intro.trim() !== '') {
      content = fillFirstHeading(content, intro.trim())
    }
    const text = `---\n${frontMatter}---\n${content}`
    await files.writeTextAtomic(this.absolute(vault, path), text)
    index.inTransaction(() => this.reindex(vault, path))
    index.setLastEntry(vault.id, path)
    return { entry: this.entryView(vault, path, text), vault: this.view(vault.id) }
  }

  /**
   * Creates an entry for a missing [[link]] in an entry of `fromSection`, and
   * remembers the section chosen so the picker offers it first next time.
   */
  async createLinkedEntry(
    vaultId: number,
    fromSection: string,
    sectionId: string,
    title: string,
  ): Promise<{ entry: EntryView; vault: VaultView }> {
    const vault = this.vault(vaultId)
    this.section(vault, fromSection)
    this.section(vault, sectionId)
    const created = await this.createEntry(vaultId, sectionId, title, null)
    this.deps.index.setLinkSection(vault.id, fromSection, sectionId)
    return { entry: created.entry, vault: this.view(vault.id) }
  }

  /** Writes new front-matter values (and optionally a new body) after a version check. */
  private async writeEntry(
    vault: OpenVault,
    path: string,
    baseVersion: string,
    force: boolean,
    change: (current: string) => { fields: Array<[string, string]>; body?: string } | null,
  ): Promise<SaveResult> {
    const { files, index, clock, newId } = this.deps
    const { file, text: current } = this.readExisting(vault, path)
    if (files.hash(current) !== baseVersion && !force) {
      return { status: 'conflict', theirs: this.entryView(vault, path, current) }
    }
    const planned = change(current)
    if (planned === null) return { status: 'saved', entry: this.entryView(vault, path, current) }
    const parts = splitEntryFile(current)
    const parsed = parseEntry(current, fileTitle(path.split('/')[1] ?? ''))
    const fields: Array<[string, string]> = [
      ...planned.fields,
      ['updated', clock.now().toISOString()],
    ]
    if (parsed.id === null) fields.unshift(['id', yamlString(newId())])
    if (parts.head === '') fields.unshift(['title', yamlString(parsed.title)])
    const text = joinEntryFile({
      ...parts,
      head: parts.head || `---${parts.eol}`,
      frontMatter: setFields(parts.frontMatter, fields, parts.eol),
      close: parts.close || `---${parts.eol}`,
      body: planned.body ?? parts.body,
    })
    await files.writeTextAtomic(file, text)
    index.inTransaction(() => this.reindex(vault, path))
    return { status: 'saved', entry: this.entryView(vault, path, text) }
  }

  /**
   * Saves an entry's body. When the file changed on disk since `baseVersion`
   * the save is refused with the version on disk, unless `force` is set.
   */
  async saveEntry(
    vaultId: number,
    path: string,
    body: string,
    baseVersion: string,
    force: boolean,
  ): Promise<SaveResult> {
    const vault = this.vault(vaultId)
    return this.writeEntry(vault, path, baseVersion, force, (current) =>
      splitEntryFile(current).body === body ? null : { fields: [], body },
    )
  }

  /**
   * Sets property values from the Properties panel. Each value is checked
   * against its field and written as a plain front-matter key; every other
   * line of the file stays as it is.
   */
  async setProperties(
    vaultId: number,
    path: string,
    changes: readonly PropertyChange[],
    baseVersion: string,
  ): Promise<SaveResult> {
    const vault = this.vault(vaultId)
    const { section } = this.entryPath(vault, path)
    const fields = this.fieldsOf(vault, section)
    const entries = this.deps.index.listEntries(vault.id)
    // A file without an id has only a path-based one, which a move or rename would break.
    const entryExists = (id: string, limit: string | undefined) =>
      !id.startsWith('path:') &&
      entries.some((entry) => entry.entryId === id && (!limit || entry.section === limit))
    const lines: Array<[string, string]> = []
    for (const change of changes) {
      if (change.key === 'tags') {
        if (!Array.isArray(change.value)) throw new VaultError('Tags must be a list')
        lines.push(['tags', yamlList(cleanTags(change.value))])
        continue
      }
      const field = fields.find((candidate) => candidate.key === change.key)
      if (!field) throw new VaultError(`${section} has no field ${change.key}`)
      try {
        lines.push([field.key, formatFieldInput(field, change.value, entryExists)])
      } catch (error) {
        throw new VaultError(error instanceof Error ? error.message : String(error))
      }
    }
    return this.writeEntry(vault, path, baseVersion, false, () =>
      lines.length === 0 ? null : { fields: lines },
    )
  }

  /** Renames an entry: new title and file name, and every [[link]] to it rewritten. */
  async renameEntry(
    vaultId: number,
    path: string,
    title: string,
  ): Promise<{ entry: EntryView; vault: VaultView; rewritten: number }> {
    const { files, index, clock, newId } = this.deps
    const vault = this.vault(vaultId)
    const { section, name } = this.entryPath(vault, path)
    const { file, text: current } = this.readExisting(vault, path)
    const clean = cleanTitle(title)
    this.requireFreeTitle(vault, clean, path)
    const parsed = parseEntry(current, fileTitle(name))
    const oldTitle = parsed.title

    const parts = splitEntryFile(current)
    const fields: Array<[string, string]> = [
      ['title', yamlString(clean)],
      ['updated', clock.now().toISOString()],
    ]
    if (parsed.id === null) fields.unshift(['id', yamlString(newId())])
    // Links inside the entry itself (to itself) follow the rename too.
    const own = rewriteLinks(parts.body, oldTitle, clean)
    let rewritten = own.count
    const text = joinEntryFile({
      ...parts,
      head: parts.head || `---${parts.eol}`,
      frontMatter: setFields(parts.frontMatter, fields, parts.eol),
      close: parts.close || `---${parts.eol}`,
      body: own.text,
    })

    const keepName = name === `${slugify(clean)}${ENTRY_EXTENSION}`
    const newName = keepName ? name : this.freeName(vault, section, clean, name)
    const newPath = `${section}/${newName}`
    await files.writeTextAtomic(this.absolute(vault, newPath), text)
    if (newPath !== path) await files.remove(file)

    // Every other entry that linked to the old title.
    const sources = index
      .linkingTo(vault.id, titleKey(oldTitle))
      .filter((source) => source.path !== path)
    for (const source of sources) {
      const sourceFile = this.absolute(vault, source.path)
      if (!files.exists(sourceFile)) continue
      const sourceText = files.readText(sourceFile)
      const sourceParts = splitEntryFile(sourceText)
      const result = rewriteLinks(sourceParts.body, oldTitle, clean)
      if (result.count === 0) continue
      rewritten += result.count
      await files.writeTextAtomic(sourceFile, joinEntryFile({ ...sourceParts, body: result.text }))
    }

    index.inTransaction(() => {
      if (newPath !== path) index.removeEntry(vault.id, path)
      this.reindex(vault, newPath)
      for (const source of sources) this.reindex(vault, source.path)
    })
    if (index.lastEntry(vault.id) === path) index.setLastEntry(vault.id, newPath)
    return { entry: this.entryView(vault, newPath, text), vault: this.view(vault.id), rewritten }
  }

  /** Copies an entry as "<title> copy": a new id, the same body and fields, placed last. */
  async duplicateEntry(
    vaultId: number,
    path: string,
  ): Promise<{ entry: EntryView; vault: VaultView }> {
    const { files, index, clock, newId } = this.deps
    const vault = this.vault(vaultId)
    const { section, name } = this.entryPath(vault, path)
    const { text: current } = this.readExisting(vault, path)
    const parsed = parseEntry(current, fileTitle(name))
    const title = this.freeCopyTitle(vault, parsed.title)
    const parts = splitEntryFile(current)
    const now = clock.now().toISOString()
    const text = joinEntryFile({
      ...parts,
      head: parts.head || `---${parts.eol}`,
      frontMatter: setFields(
        parts.frontMatter,
        [
          ['id', yamlString(newId())],
          ['title', yamlString(title)],
          ['order', String(this.nextOrder(vault, section))],
          ['created', now],
          ['updated', now],
        ],
        parts.eol,
      ),
      close: parts.close || `---${parts.eol}`,
    })
    const copyPath = `${section}/${this.freeName(vault, section, title)}`
    await files.writeTextAtomic(this.absolute(vault, copyPath), text)
    index.inTransaction(() => this.reindex(vault, copyPath))
    index.setLastEntry(vault.id, copyPath)
    return { entry: this.entryView(vault, copyPath, text), vault: this.view(vault.id) }
  }

  /**
   * Moves an entry's file to another section's folder, last in that section.
   * Its id and title stay, so links and entry fields keep resolving.
   */
  async moveEntry(
    vaultId: number,
    path: string,
    sectionId: string,
  ): Promise<{ path: string; vault: VaultView; templateSwap: boolean }> {
    const { files, index } = this.deps
    const vault = this.vault(vaultId)
    const { section, name } = this.entryPath(vault, path)
    this.section(vault, sectionId)
    if (section === sectionId) return { path, vault: this.view(vault.id), templateSwap: false }
    const { file, text: current } = this.readExisting(vault, path)
    // Still only the old section's template, untouched: offer the new section's instead.
    const fromTemplate = this.template(vault, section)
    const toTemplate = this.template(vault, sectionId)
    const templateSwap =
      fromTemplate !== '' &&
      toTemplate !== '' &&
      toTemplate !== fromTemplate &&
      splitEntryFile(current).body === fromTemplate
    const parts = splitEntryFile(current)
    const text = joinEntryFile({
      ...parts,
      head: parts.head || `---${parts.eol}`,
      frontMatter: setFields(
        parts.frontMatter,
        [['order', String(this.nextOrder(vault, sectionId))]],
        parts.eol,
      ),
      close: parts.close || `---${parts.eol}`,
    })
    files.mkdir(files.join(vault.root, sectionId))
    const parsed = parseEntry(current, fileTitle(name))
    const target = `${sectionId}/${this.freeName(vault, sectionId, parsed.title)}`
    await files.writeTextAtomic(this.absolute(vault, target), text)
    await files.remove(file)
    index.inTransaction(() => {
      index.removeEntry(vault.id, path)
      this.reindex(vault, target)
    })
    if (index.lastEntry(vault.id) === path) index.setLastEntry(vault.id, target)
    return { path: target, vault: this.view(vault.id), templateSwap }
  }

  /**
   * Replaces an entry's body with its section's template, if the body is still
   * exactly the template of `fromSection`. Front-matter keys stay as they are.
   */
  async swapTemplate(
    vaultId: number,
    path: string,
    fromSection: string,
    baseVersion: string,
  ): Promise<SaveResult> {
    const vault = this.vault(vaultId)
    const { section } = this.entryPath(vault, path)
    const from = this.template(vault, fromSection)
    const to = this.template(vault, section)
    return this.writeEntry(vault, path, baseVersion, false, (current) => {
      if (from === '' || splitEntryFile(current).body !== from) {
        throw new VaultError('The entry was written meanwhile; its text was left alone')
      }
      return { fields: [], body: to }
    })
  }

  /** Writes a new `order` into one entry, leaving the rest of the file alone. */
  private async writeOrder(vault: OpenVault, path: string, order: number): Promise<void> {
    const { file, text } = this.readExisting(vault, path)
    const parts = splitEntryFile(text)
    await this.deps.files.writeTextAtomic(
      file,
      joinEntryFile({
        ...parts,
        head: parts.head || `---${parts.eol}`,
        frontMatter: setFields(parts.frontMatter, [['order', String(order)]], parts.eol),
        close: parts.close || `---${parts.eol}`,
      }),
    )
  }

  /**
   * Puts a section's entries in the given order after `moved` was dragged.
   * Usually only the moved entry's `order` changes (it takes a value between
   * its neighbours); when there is no room, the section is numbered 1, 2, 3...
   */
  async reorderEntries(
    vaultId: number,
    sectionId: string,
    paths: readonly string[],
    moved: string,
  ): Promise<VaultView> {
    const { index } = this.deps
    const vault = this.vault(vaultId)
    this.section(vault, sectionId)
    const current = index.listEntries(vault.id).filter((entry) => entry.section === sectionId)
    const orders = new Map(current.map((entry) => [entry.path, entry.order]))
    if (paths.length !== current.length || paths.some((path) => !orders.has(path))) {
      throw new VaultError('The section changed meanwhile; try again')
    }
    const at = paths.indexOf(moved)
    if (at === -1) throw new VaultError('The moved entry is not in this section')
    const before = at > 0 ? (orders.get(paths[at - 1] ?? '') ?? UNORDERED) : null
    const after = at < paths.length - 1 ? (orders.get(paths[at + 1] ?? '') ?? UNORDERED) : null
    const others = paths
      .filter((path) => path !== moved)
      .map((path) => orders.get(path) ?? UNORDERED)
    const othersSorted = others.every((order, i) => i === 0 || order > (others[i - 1] ?? 0))
    const allOrdered = others.every((order) => order < UNORDERED)

    let single: number | null = null
    if (othersSorted && allOrdered) {
      if (before === null && after === null) single = 1
      else if (before === null && after !== null) single = after - 1
      else if (after === null && before !== null) single = Math.floor(before) + 1
      else if (before !== null && after !== null && after - before > 1e-6)
        single = (before + after) / 2
    }
    const writes: Array<[string, number]> =
      single !== null
        ? [[moved, single]]
        : paths
            .map((path, i): [string, number] => [path, i + 1])
            .filter(([path, order]) => orders.get(path) !== order)
    for (const [path, order] of writes) await this.writeOrder(vault, path, order)
    index.inTransaction(() => {
      for (const [path] of writes) this.reindex(vault, path)
    })
    return this.view(vault.id)
  }

  // ---- trash ---------------------------------------------------------------

  private trashLogPath(vault: OpenVault): string {
    return this.deps.files.join(vault.root, TRASH_DIR, TRASH_LOG)
  }

  private readTrashLog(vault: OpenVault): TrashRecord[] {
    const file = this.trashLogPath(vault)
    return parseTrashLog(this.deps.files.exists(file) ? this.deps.files.readText(file) : null)
  }

  private async writeTrashLog(vault: OpenVault, records: readonly TrashRecord[]): Promise<void> {
    await this.deps.files.writeTextAtomic(this.trashLogPath(vault), serializeTrashLog(records))
  }

  private async forgetTrash(vault: OpenVault, trashPath: string): Promise<void> {
    const records = this.readTrashLog(vault)
    const rest = records.filter((record) => record.trashPath !== trashPath)
    if (rest.length !== records.length) await this.writeTrashLog(vault, rest)
  }

  /** Moves an entry file into <vault>/.trash/<section>/; returns where it went, for Undo. */
  async deleteEntry(
    vaultId: number,
    path: string,
  ): Promise<{ trashPath: string; vault: VaultView }> {
    const { files, index, clock } = this.deps
    const vault = this.vault(vaultId)
    const { section, name } = this.entryPath(vault, path)
    const { file, text } = this.readExisting(vault, path)
    const trashFolder = files.join(vault.root, TRASH_DIR, section)
    const trashName = files.exists(files.join(trashFolder, name))
      ? withSuffix(name, `~${clock.now().getTime()}`)
      : name
    await files.move(file, files.join(trashFolder, trashName))
    const trashPath = `${TRASH_DIR}/${section}/${trashName}`
    index.inTransaction(() => index.removeEntry(vault.id, path))
    if (index.lastEntry(vault.id) === path) index.setLastEntry(vault.id, null)
    await this.writeTrashLog(vault, [
      ...this.readTrashLog(vault).filter((record) => record.trashPath !== trashPath),
      {
        trashPath,
        kind: 'entry',
        from: path,
        name: parseEntry(text, fileTitle(name)).title,
        deletedAt: clock.now().toISOString(),
      },
    ])
    return { trashPath, vault: this.view(vault.id) }
  }

  /** Moves a deleted entry back; to a new name if its old one was taken meanwhile. */
  async restoreEntry(
    vaultId: number,
    trashPath: string,
    path: string,
  ): Promise<{ path: string; vault: VaultView }> {
    const { files, index } = this.deps
    const vault = this.vault(vaultId)
    const { section, name } = this.entryPath(vault, path)
    if (!TRASH_ENTRY.test(trashPath) || trashPath.includes('..')) {
      throw new VaultError(`Not a trash path: ${trashPath}`)
    }
    const from = this.absolute(vault, trashPath)
    if (!files.exists(from)) throw new VaultError('The deleted entry is no longer in .trash')
    const folder = files.join(vault.root, section)
    const base = name.slice(0, -ENTRY_EXTENSION.length)
    const target = uniqueName(base, ENTRY_EXTENSION, (candidate) =>
      files.exists(files.join(folder, candidate)),
    )
    const restored = `${section}/${target}`
    await files.move(from, this.absolute(vault, restored))
    index.inTransaction(() => this.reindex(vault, restored))
    await this.forgetTrash(vault, trashPath)
    return { path: restored, vault: this.view(vault.id) }
  }

  /** Everything in .trash, newest first; items deleted outside the app have no time. */
  listTrash(vaultId: number): TrashItem[] {
    const { files } = this.deps
    const vault = this.vault(vaultId)
    const records = new Map(this.readTrashLog(vault).map((record) => [record.trashPath, record]))
    const sectionName = (id: string) =>
      vault.config.sections.find((section) => section.id === id)?.name ?? null
    const trashRoot = files.join(vault.root, TRASH_DIR)
    const items: TrashItem[] = []
    const countEntries = (folder: string) =>
      files.list(folder).filter((item) => !item.isDirectory && item.name.endsWith(ENTRY_EXTENSION))
        .length

    const addSection = (trashPath: string, folderName: string) => {
      const record = records.get(trashPath)
      const id = record?.from ?? withoutTrashSuffix(folderName)
      items.push({
        trashPath,
        kind: 'section',
        name: record?.name ?? id,
        from: id,
        sectionName: null,
        deletedAt: record?.deletedAt ?? null,
        entryCount: countEntries(this.absolute(vault, trashPath)),
      })
    }

    for (const item of files.list(trashRoot)) {
      if (!item.isDirectory || isHidden(item.name)) continue
      if (item.name === SECTIONS_TRASH) {
        for (const section of files.list(files.join(trashRoot, SECTIONS_TRASH))) {
          if (section.isDirectory && isSectionId(withoutTrashSuffix(section.name))) {
            addSection(`${TRASH_DIR}/${SECTIONS_TRASH}/${section.name}`, section.name)
          }
        }
        continue
      }
      const asSection = `${TRASH_DIR}/${item.name}`
      const loggedEntries = [...records.values()].some(
        (record) => record.kind === 'entry' && record.trashPath.startsWith(`${asSection}/`),
      )
      // A section removed by the first version of the app sits directly in .trash.
      const legacySection =
        records.get(asSection)?.kind === 'section' ||
        (!loggedEntries &&
          sectionName(item.name) === null &&
          isSectionId(withoutTrashSuffix(item.name)))
      if (legacySection) {
        addSection(asSection, item.name)
        continue
      }
      for (const entry of files.list(files.join(trashRoot, item.name))) {
        if (entry.isDirectory || isHidden(entry.name) || !entry.name.endsWith(ENTRY_EXTENSION)) {
          continue
        }
        const trashPath = `${TRASH_DIR}/${item.name}/${entry.name}`
        const record = records.get(trashPath)
        const from = record?.from ?? `${item.name}/${withoutTrashSuffix(entry.name)}`
        const file = this.absolute(vault, trashPath)
        items.push({
          trashPath,
          kind: 'entry',
          name: record?.name ?? parseEntry(files.readText(file), fileTitle(entry.name)).title,
          from,
          sectionName: sectionName(from.split('/')[0] ?? ''),
          deletedAt: record?.deletedAt ?? null,
          entryCount: 0,
        })
      }
    }
    return items.sort((a, b) => (b.deletedAt ?? '').localeCompare(a.deletedAt ?? ''))
  }

  /** Puts a trashed entry or section back where it came from. */
  async restoreFromTrash(
    vaultId: number,
    trashPath: string,
  ): Promise<{ path: string | null; vault: VaultView }> {
    const vault = this.vault(vaultId)
    const item = this.listTrash(vaultId).find((candidate) => candidate.trashPath === trashPath)
    if (!item) throw new VaultError('That is no longer in .trash')
    if (item.kind === 'entry') {
      const section = item.from.split('/')[0] ?? ''
      if (!vault.config.sections.some((candidate) => candidate.id === section)) {
        throw new VaultError(`Its section ${section} is gone; restore the section first`)
      }
      return this.restoreEntry(vaultId, trashPath, item.from)
    }
    const record = this.readTrashLog(vault).find((candidate) => candidate.trashPath === trashPath)
    const section = record?.section ?? { id: item.from, name: item.name, fields: [], extra: {} }
    const view = await this.restoreSection(
      vaultId,
      trashPath,
      section,
      record?.position ?? vault.config.sections.length,
    )
    return { path: null, vault: view }
  }

  /** Deletes a trashed entry or section for good. */
  async purgeFromTrash(vaultId: number, trashPath: string): Promise<TrashItem[]> {
    const vault = this.vault(vaultId)
    const item = this.listTrash(vaultId).find((candidate) => candidate.trashPath === trashPath)
    if (!item) throw new VaultError('That is no longer in .trash')
    const target = this.absolute(vault, trashPath)
    if (item.kind === 'entry') await this.deps.files.remove(target)
    else await this.deps.files.removeTree(target)
    await this.forgetTrash(vault, trashPath)
    return this.listTrash(vaultId)
  }

  search(vaultId: number, text: string): { hits: SearchHit[]; ms: number } {
    const vault = this.vault(vaultId)
    const started = this.deps.clock.monotonicMs()
    const query = toFtsQuery(text)
    const hits = query === null ? [] : this.deps.index.search(vault.id, query, SEARCH_LIMIT)
    return { hits, ms: this.deps.clock.monotonicMs() - started }
  }

  // ---- pillars -------------------------------------------------------------

  /** The Pillars section's entries as cards, in order. */
  pillars(vaultId: number): PillarCard[] {
    const { files } = this.deps
    const vault = this.vault(vaultId)
    const analysis = this.analyse(vault)
    return analysis.rows
      .filter((entry) => entry.section === PILLARS_SECTION)
      .map((entry) => {
        const file = this.absolute(vault, entry.path)
        const body = files.exists(file) ? parseEntry(files.readText(file), entry.title).body : ''
        const served = analysis.servedBy.get(entry.path) ?? []
        return {
          path: entry.path,
          title: entry.title,
          ...pillarParts(body),
          decisions: served.filter((row) => row.section === DECISIONS).length,
          ideas: served.filter((row) => row.section === IDEAS).length,
        }
      })
  }

  // ---- decision tools ------------------------------------------------------

  private fieldsOf(vault: OpenVault, sectionId: string): FieldDef[] {
    const section = vault.config.sections.find((candidate) => candidate.id === sectionId)
    return sectionFields(sectionId, section?.fields ?? [])
  }

  private settings(vault: OpenVault): VaultSettings {
    const assets = vault.config.extra['assets']
    const copy =
      assets !== null && typeof assets === 'object' && !Array.isArray(assets)
        ? (assets as Record<string, unknown>)['copy']
        : undefined
    // The journal holds the user's own work, so it keeps originals unless told otherwise.
    if (copy === undefined && vault.config.kit === JOURNAL_KIT) return { copyOriginals: true }
    return { copyOriginals: copy === 'original' }
  }

  /**
   * One pass over the index: which decisions and ideas serve which pillar
   * (by id, or a title typed by hand), which name none, and which entries
   * may be out of date.
   */
  private analyse(vault: OpenVault): Analysis {
    const { index, clock } = this.deps
    const rows = index.listEntries(vault.id)
    const byPath = new Map(rows.map((row) => [row.path, row]))
    const byId = new Map(rows.map((row) => [row.entryId, row]))
    const byKey = new Map<string, IndexRow>()
    for (const row of rows) if (!byKey.has(row.titleKey)) byKey.set(row.titleKey, row)
    const resolve = (target: string) =>
      byId.get(target) ?? byKey.get(titleKey(refKey(target))) ?? null

    const decisionUpdates = new Map<string, Array<string | null>>()
    const servedBy = new Map<string, IndexRow[]>()
    const serving = new Set<string>()
    const linkedFromDecision = (source: IndexRow, target: IndexRow | null | undefined) => {
      if (!target || target.path === source.path) return
      const list = decisionUpdates.get(target.path) ?? []
      list.push(source.updated)
      decisionUpdates.set(target.path, list)
    }
    for (const ref of index.allRefs(vault.id)) {
      const source = byPath.get(ref.source)
      const target = byId.get(ref.target) ?? byKey.get(ref.targetKey) ?? null
      if (!source || !target) continue
      if (source.section === DECISIONS) linkedFromDecision(source, target)
      const tool = source.section === DECISIONS || source.section === IDEAS
      if (tool && ref.key === PILLARS_KEY && target.section === PILLARS) {
        serving.add(source.path)
        const list = servedBy.get(target.path) ?? []
        if (!list.includes(source)) list.push(source)
        servedBy.set(target.path, list)
      }
    }
    for (const link of index.allLinks(vault.id)) {
      const source = byPath.get(link.source)
      if (source?.section === DECISIONS) linkedFromDecision(source, byKey.get(link.targetKey))
    }
    const now = clock.now()
    const stale = new Set<string>()
    const noPillar = new Set<string>()
    for (const row of rows) {
      if (isStale(row.updated, decisionUpdates.get(row.path) ?? [], now)) stale.add(row.path)
      if ((row.section === DECISIONS || row.section === IDEAS) && !serving.has(row.path)) {
        noPillar.add(row.path)
      }
    }
    return { rows, byPath, resolve, stale, noPillar, servedBy }
  }

  /** Reads one entry's front-matter fields. */
  private fieldsAt(vault: OpenVault, row: IndexRow): Record<string, unknown> {
    const file = this.absolute(vault, row.path)
    if (!this.deps.files.exists(file)) return {}
    return parseEntry(this.deps.files.readText(file), row.title).fields
  }

  private pillarSummaries(analysis: Analysis, raw: unknown): EntrySummary[] {
    const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : []
    const out: EntrySummary[] = []
    for (const item of list) {
      if (typeof item !== 'string') continue
      const row = analysis.resolve(item)
      if (row?.section === PILLARS && !out.some((entry) => entry.path === row.path)) {
        out.push({ path: row.path, title: row.title })
      }
    }
    return out
  }

  /** Every decision, newest first. */
  timeline(vaultId: number): TimelineItem[] {
    const vault = this.vault(vaultId)
    const analysis = this.analyse(vault)
    return analysis.rows
      .filter((row) => row.section === DECISIONS)
      .map((row) => {
        const fields = this.fieldsAt(vault, row)
        const date = typeof fields[DATE_KEY] === 'string' ? (fields[DATE_KEY] as string) : null
        const status =
          typeof fields[STATUS_KEY] === 'string' ? (fields[STATUS_KEY] as string) : null
        return {
          path: row.path,
          title: row.title,
          date,
          status,
          pillars: this.pillarSummaries(analysis, fields[PILLARS_KEY]),
          noPillar: analysis.noPillar.has(row.path),
          created: row.created,
        }
      })
      .sort(byDecisionDate)
      .map(({ created: _created, ...item }) => item)
  }

  /** Every idea, for the board's columns (an unknown status counts as parked). */
  ideas(vaultId: number): IdeaCard[] {
    const vault = this.vault(vaultId)
    const analysis = this.analyse(vault)
    return analysis.rows
      .filter((row) => row.section === IDEAS)
      .map((row) => {
        const fields = this.fieldsAt(vault, row)
        const raw = fields[STATUS_KEY]
        const status =
          typeof raw === 'string' && (IDEA_STATUSES as readonly string[]).includes(raw)
            ? raw
            : 'parked'
        const to = fields[PROMOTED_TO]
        const target = typeof to === 'string' && to.trim() ? analysis.resolve(to) : null
        return {
          path: row.path,
          title: row.title,
          status,
          pillars: this.pillarSummaries(analysis, fields[PILLARS_KEY]),
          noPillar: analysis.noPillar.has(row.path),
          promotedTo: target ? { path: target.path, title: target.title } : null,
        }
      })
  }

  /** Decisions and ideas that name no pillar. */
  review(vaultId: number): Array<EntrySummary & { section: string }> {
    const analysis = this.analyse(this.vault(vaultId))
    return analysis.rows
      .filter((row) => analysis.noPillar.has(row.path))
      .sort((a, b) => a.section.localeCompare(b.section) || a.order - b.order)
      .map((row) => ({ path: row.path, title: row.title, section: row.section }))
  }

  /**
   * Promotes an idea into a decision or an entry of another section: the new
   * entry gets the idea's pillars and promoted_from (the idea's id); the idea
   * gets status promoted and promoted_to. Undo puts both files back.
   */
  async promoteIdea(
    vaultId: number,
    ideaPath: string,
    sectionId: string,
    title: string,
  ): Promise<{ entry: EntryView; vault: VaultView; undo: string }> {
    const { files, clock } = this.deps
    const vault = this.vault(vaultId)
    const { section } = this.entryPath(vault, ideaPath)
    if (section !== IDEAS) throw new VaultError('Only ideas can be promoted')
    if (sectionId === IDEAS) throw new VaultError('Promote it to a decision or another section')
    this.section(vault, sectionId)
    const { file: ideaFile, text: ideaBefore } = this.readExisting(vault, ideaPath)
    const idea = parseEntry(ideaBefore, title)
    if (idea.id === null)
      throw new VaultError('This idea has no id yet; edit and save it once first')
    const pillars = Array.isArray(idea.fields[PILLARS_KEY])
      ? (idea.fields[PILLARS_KEY] as unknown[]).filter(
          (item): item is string => typeof item === 'string',
        )
      : []
    const carriesPillars = this.fieldsOf(vault, sectionId).some(
      (field) => field.key === PILLARS_KEY,
    )
    const created = await this.createEntry(vaultId, sectionId, title, null, null, [
      [PROMOTED_FROM, yamlString(idea.id)],
      ...(carriesPillars && pillars.length > 0
        ? [[PILLARS_KEY, yamlList(pillars)] as [string, string]]
        : []),
    ])
    const parts = splitEntryFile(ideaBefore)
    const ideaAfter = joinEntryFile({
      ...parts,
      frontMatter: setFields(
        parts.frontMatter,
        [
          [STATUS_KEY, 'promoted'],
          [PROMOTED_TO, yamlString(created.entry.id)],
          ['updated', clock.now().toISOString()],
        ],
        parts.eol,
      ),
    })
    await files.writeTextAtomic(ideaFile, ideaAfter)
    this.deps.index.inTransaction(() => this.reindex(vault, ideaPath))
    const targetText = files.readText(this.absolute(vault, created.entry.path))
    const undo = `promote-${++this.promoteCount}`
    this.promotes.set(undo, {
      vaultId: vault.id,
      ideaPath,
      ideaBefore,
      ideaAfter: files.hash(ideaAfter),
      targetPath: created.entry.path,
      targetAfter: files.hash(targetText),
    })
    return {
      entry: this.entryView(vault, created.entry.path, targetText),
      vault: this.view(vault.id),
      undo,
    }
  }

  /** Undoes a promote in one step, if neither file was changed since. */
  async undoPromote(vaultId: number, undo: string): Promise<VaultView> {
    const { files, index } = this.deps
    const vault = this.vault(vaultId)
    const record = this.promotes.get(undo)
    if (!record || record.vaultId !== vault.id) throw new VaultError('Nothing to undo')
    const ideaFile = this.absolute(vault, record.ideaPath)
    const targetFile = this.absolute(vault, record.targetPath)
    const unchanged = (file: string, hash: string) =>
      files.exists(file) && files.hash(files.readText(file)) === hash
    if (!unchanged(ideaFile, record.ideaAfter) || !unchanged(targetFile, record.targetAfter)) {
      throw new VaultError('The idea or the new entry changed since; undo it by hand')
    }
    await files.writeTextAtomic(ideaFile, record.ideaBefore)
    await files.remove(targetFile)
    this.promotes.delete(undo)
    index.inTransaction(() => {
      this.reindex(vault, record.ideaPath)
      index.removeEntry(vault.id, record.targetPath)
    })
    if (index.lastEntry(vault.id) === record.targetPath)
      index.setLastEntry(vault.id, record.ideaPath)
    return this.view(vault.id)
  }

  // ---- references ----------------------------------------------------------

  /**
   * Copies Library images into <vault>/_assets (thumbnails, or originals when
   * the vault says so), lists them in the entry's "references" and returns the
   * Markdown links to put in its body.
   */
  async addReferences(
    vaultId: number,
    path: string,
    referenceIds: readonly number[],
    baseVersion: string,
  ): Promise<{ result: SaveResult; images: Array<{ alt: string; link: string }> }> {
    const { library } = this.deps
    if (!library) throw new VaultError('The Library is not available')
    const vault = this.vault(vaultId)
    this.entryPath(vault, path)
    const originals = this.settings(vault).copyOriginals
    const images: Array<{ alt: string; link: string }> = []
    const added: string[] = []
    for (const item of library.describe(referenceIds)) {
      const hash = originals ? item.imageHash : item.thumbHash
      const bytes = await library.read(hash)
      const asset = await this.storeAsset(vault, hash, bytes, item.imageMime)
      if (asset === null) continue
      added.push(asset)
      images.push({ alt: altText(item.title), link: assetLinkFrom(path, asset) })
    }
    const result = await this.listReferences(vault, path, baseVersion, added)
    return { result, images }
  }

  /** Writes image bytes to _assets/<hash>.<ext> unless already there; null when not an image. */
  private async storeAsset(
    vault: OpenVault,
    hash: string,
    bytes: Uint8Array,
    fallbackMime: string | null,
  ): Promise<string | null> {
    const { files } = this.deps
    const mime = sniffImageMime(bytes) ?? fallbackMime
    const name = mime === null ? null : assetFileName(hash, mime)
    if (name === null) return null
    const asset = `${ASSETS_DIR}/${name}`
    const target = this.absolute(vault, asset)
    if (!files.exists(target)) await files.writeBytesAtomic(target, bytes)
    return asset
  }

  /** Adds asset paths to an entry's "references", keeping the ones it lists. */
  private listReferences(
    vault: OpenVault,
    path: string,
    baseVersion: string,
    added: readonly string[],
  ): Promise<SaveResult> {
    if (added.length === 0) throw new VaultError('Nothing to add: the images could not be read')
    return this.writeEntry(vault, path, baseVersion, false, (current) => {
      const existing = referencePaths(parseEntry(current, '').fields)
      const merged = [...existing, ...added.filter((asset) => !existing.includes(asset))]
      return { fields: [[REFERENCES_KEY, yamlList(merged)]] }
    })
  }

  /**
   * Puts new images (dropped from Explorer or pasted) into _assets, the
   * originals or thumbnails as the vault says, lists them in the entry's
   * "references" and returns the Markdown links plus the names of the
   * entry's topics (for tagging the same images in the Library).
   */
  async addImages(
    vaultId: number,
    path: string,
    images: readonly ImageInput[],
    baseVersion: string,
  ): Promise<{
    result: SaveResult
    images: Array<{ alt: string; link: string }>
    topics: string[]
  }> {
    const { hasher } = this.deps
    if (!hasher) throw new VaultError('Images cannot be added here')
    const vault = this.vault(vaultId)
    this.entryPath(vault, path)
    const originals = this.settings(vault).copyOriginals
    const links: Array<{ alt: string; link: string }> = []
    const added: string[] = []
    for (const image of images) {
      const bytes = originals ? image.bytes : image.thumbnail.bytes
      const asset = await this.storeAsset(vault, hasher.sha256(bytes), bytes, null)
      if (asset === null) continue
      if (!added.includes(asset)) added.push(asset)
      links.push({
        alt: altText(image.fileName.replace(/\.[^.]+$/, '')),
        link: assetLinkFrom(path, asset),
      })
    }
    const result = await this.listReferences(vault, path, baseVersion, added)
    const fields = parseEntry(this.readExisting(vault, path).text, '').fields
    const analysis = this.analyse(vault)
    return { result, images: links, topics: this.topicNames(analysis, fields[TOPICS_KEY]) }
  }

  /** The titles a topics field names: the entries it points at, or the text typed. */
  private topicNames(analysis: Analysis, raw: unknown): string[] {
    const names: string[] = []
    for (const item of asStrings(raw)) {
      const row = analysis.resolve(item)
      const name = row ? row.title : refKey(item).trim()
      if (name !== '' && !/^[a-z0-9]{12}$/.test(name) && !names.includes(name)) names.push(name)
    }
    return names
  }

  // ---- journal ---------------------------------------------------------------

  /** The open vault, checking it is the journal. */
  private journal(vaultId: number): OpenVault {
    const vault = this.vault(vaultId)
    if (this.role !== 'journal') throw new VaultError('This is not the journal')
    return vault
  }

  /** Every session with its day, read from the files. */
  private sessions(
    vault: OpenVault,
    rows: readonly IndexRow[],
  ): Array<DatedSession & { row: IndexRow; fields: Record<string, unknown> }> {
    return rows
      .filter((row) => row.section === SESSIONS)
      .map((row) => {
        const fields = this.fieldsAt(vault, row)
        return {
          path: row.path,
          title: row.title,
          date: sessionDay(fields, row.title, row.created),
          created: row.created,
          row,
          fields,
        }
      })
  }

  /** Today's sessions, and the "Next time" of the latest session before today. */
  today(vaultId: number): TodayView {
    const vault = this.journal(vaultId)
    const today = localDate(this.deps.clock.now())
    const sessions = this.sessions(vault, this.deps.index.listEntries(vault.id))
    const found = todayAndPrevious(sessions, today)
    const previous = found.previous
    let nextTime: string | null = null
    if (previous) {
      const file = this.absolute(vault, previous.path)
      if (this.deps.files.exists(file)) {
        nextTime = nextTimeSection(parseEntry(this.deps.files.readText(file), previous.title).body)
      }
    }
    return {
      today,
      sessions: found.today.map(summaryOf),
      previous: previous ? { ...summaryOf(previous), nextTime } : null,
    }
  }

  /** A new session for today, titled with the date, from the Session template. */
  async newSession(vaultId: number): Promise<{ entry: EntryView; vault: VaultView }> {
    const vault = this.journal(vaultId)
    this.section(vault, SESSIONS)
    const used = new Set(this.deps.index.listEntries(vault.id).map((entry) => entry.titleKey))
    const title = sessionTitle(localDate(this.deps.clock.now()), (candidate) =>
      used.has(titleKey(candidate)),
    )
    return this.createEntry(vaultId, SESSIONS, title, null)
  }

  /**
   * The user's own words for a recap: this week's sessions (today and the six
   * days before) or a topic's sessions, oldest first. Only the text under the
   * Session template's headings is taken, and recaps saved from an AI draft
   * are left out.
   */
  recapSources(
    vaultId: number,
    scope: { kind: 'week' } | { kind: 'topic'; path: string },
  ): RecapSource[] {
    const vault = this.journal(vaultId)
    const analysis = this.analyse(vault)
    let sessions = this.sessions(vault, analysis.rows)
    if (scope.kind === 'week') {
      const now = this.deps.clock.now()
      const first = new Date(now)
      first.setDate(first.getDate() - (RECAP_WEEK_DAYS - 1))
      const from = localDate(first)
      const to = localDate(now)
      sessions = sessions.filter(
        (item) => item.date !== null && item.date >= from && item.date <= to,
      )
    } else {
      const { section } = this.entryPath(vault, scope.path)
      const topic = analysis.byPath.get(scope.path)
      if (section !== TOPICS || !topic) throw new VaultError('Pick a topic to recap')
      const linked = new Set(
        this.linkedToTopic(vault, analysis, topic, SESSIONS).map((row) => row.path),
      )
      sessions = sessions.filter((item) => linked.has(item.path))
    }
    const out: RecapSource[] = []
    for (const item of sessions
      .filter((entry) => entry.fields[AI_GENERATED_KEY] !== true)
      .sort(
        (a, b) =>
          (a.date ?? '').localeCompare(b.date ?? '') ||
          (a.created ?? '').localeCompare(b.created ?? ''),
      )) {
      const file = this.absolute(vault, item.path)
      if (!this.deps.files.exists(file)) continue
      const text = recapText(parseEntry(this.deps.files.readText(file), item.title).body)
      if (text !== null) {
        out.push({
          id: item.row.entryId,
          path: item.path,
          title: item.title,
          date: item.date,
          text,
        })
      }
    }
    return out
  }

  /**
   * Saves an accepted recap draft as a new Session the user can edit, marked
   * ai_generated with the ids of the sessions it was built from. The only way
   * AI text reaches a journal file.
   */
  async saveRecap(
    vaultId: number,
    title: string,
    text: string,
    sourceIds: readonly string[],
  ): Promise<{ entry: EntryView; vault: VaultView }> {
    const vault = this.journal(vaultId)
    this.section(vault, SESSIONS)
    const base = cleanTitle(title)
    const used = new Set(this.deps.index.listEntries(vault.id).map((entry) => entry.titleKey))
    let free = base
    for (let count = 2; used.has(titleKey(free)); count++) free = cleanTitle(`${base} ${count}`)
    const body = text.endsWith('\n') ? text : `${text}\n`
    return this.createEntry(vaultId, SESSIONS, free, body, null, [
      [AI_GENERATED_KEY, 'true'],
      [SOURCE_SESSIONS_KEY, yamlList(sourceIds)],
    ])
  }

  /** Days of a year with sessions, for the month view and the year heat map. */
  calendar(vaultId: number, year: number): CalendarDay[] {
    const vault = this.journal(vaultId)
    return calendarDays(this.sessions(vault, this.deps.index.listEntries(vault.id)), year)
  }

  /** Entries of a section whose topics field points at the topic. */
  private linkedToTopic(
    vault: OpenVault,
    analysis: Analysis,
    topic: IndexRow,
    section: string,
  ): IndexRow[] {
    const out: IndexRow[] = []
    for (const ref of this.deps.index.allRefs(vault.id)) {
      if (ref.key !== TOPICS_KEY) continue
      const source = analysis.byPath.get(ref.source)
      if (!source || source.section !== section || out.includes(source)) continue
      if (analysis.resolve(ref.target)?.path === topic.path) out.push(source)
    }
    return out
  }

  private resourceItem(
    analysis: Analysis,
    row: IndexRow,
    fields: Record<string, unknown>,
  ): ResourceItem {
    const text = (key: string): string | null => {
      const value = fields[key]
      if (typeof value === 'number') return String(value)
      return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
    }
    const topics: EntrySummary[] = []
    for (const item of asStrings(fields[TOPICS_KEY])) {
      const target = analysis.resolve(item)
      if (target && !topics.some((topic) => topic.path === target.path)) {
        topics.push({ path: target.path, title: target.title })
      }
    }
    return {
      path: row.path,
      title: row.title,
      status: text(STATUS_KEY),
      url: text(URL_KEY),
      rating: text(RATING_KEY),
      topics,
    }
  }

  /** Every resource with its status, link and topics, in section order. */
  resources(vaultId: number): ResourceItem[] {
    const vault = this.journal(vaultId)
    const analysis = this.analyse(vault)
    return analysis.rows
      .filter((row) => row.section === RESOURCES)
      .sort((a, b) => a.order - b.order || a.titleKey.localeCompare(b.titleKey))
      .map((row) => this.resourceItem(analysis, row, this.fieldsAt(vault, row)))
  }

  /**
   * A topic's progress: practice images from its sessions (oldest first), the
   * sessions (newest first), its resources, and minutes if any were logged.
   */
  topicProgress(vaultId: number, path: string): TopicProgress {
    const vault = this.journal(vaultId)
    const { section } = this.entryPath(vault, path)
    if (section !== TOPICS) throw new VaultError('Only topics have a progress page')
    const analysis = this.analyse(vault)
    const topic = analysis.byPath.get(path)
    if (!topic) throw new VaultError('This entry no longer exists')
    const linked = new Set(
      this.linkedToTopic(vault, analysis, topic, SESSIONS).map((row) => row.path),
    )
    const sessions = this.sessions(vault, analysis.rows)
      .filter((session) => linked.has(session.path))
      .sort(
        (a, b) =>
          (a.date ?? '').localeCompare(b.date ?? '') ||
          (a.created ?? '').localeCompare(b.created ?? '') ||
          a.title.localeCompare(b.title),
      )
    const images: PracticeImage[] = []
    let minutes = 0
    let logged = false
    for (const session of sessions) {
      for (const asset of referencePaths(session.fields)) {
        if (
          PRACTICE_IMAGE.test(asset) &&
          !images.some((image) => image.asset === asset && image.session.path === session.path)
        ) {
          images.push({ asset, session: summaryOf(session) })
        }
      }
      const value = session.fields[MINUTES_KEY]
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        minutes += value
        logged = true
      }
    }
    const resources = this.linkedToTopic(vault, analysis, topic, RESOURCES).map((row) =>
      this.resourceItem(analysis, row, this.fieldsAt(vault, row)),
    )
    return {
      images,
      sessions: [...sessions].reverse().map((session) => {
        const value = session.fields[MINUTES_KEY]
        return {
          ...summaryOf(session),
          minutes: typeof value === 'number' && Number.isFinite(value) ? value : null,
        }
      }),
      resources,
      minutes: logged ? minutes : null,
    }
  }

  /** Which entries (in any vault the app knows) use these image hashes. */
  assetUses(hashes: readonly string[]): Array<{
    vaultId: number
    vaultTitle: string
    vaultPath: string
    path: string
    title: string
  }> {
    return this.deps.index.entriesUsingAssets(hashes)
  }

  /**
   * An image inside the open vault, for the preview: the absolute path when
   * the vault-relative path stays inside the vault and the file exists.
   */
  vaultFile(relativePath: string): string | null {
    const vault = this.current
    if (!vault) return null
    const clean = resolveVaultLink('', `/${relativePath}`)
    if (clean === null || clean !== relativePath) return null
    if (clean.split('/').some((part) => part.startsWith('.'))) return null
    if (!/\.(png|jpe?g|webp|gif|avif|bmp)$/i.test(clean)) return null
    const file = this.absolute(vault, clean)
    return this.deps.files.stat(file) ? file : null
  }

  async setSettings(vaultId: number, settings: VaultSettings): Promise<VaultView> {
    return this.exclusive(async () => {
      const vault = this.vault(vaultId)
      const current = vault.config.extra['assets']
      const assets =
        current !== null && typeof current === 'object' && !Array.isArray(current) ? current : {}
      vault.config = {
        ...vault.config,
        extra: {
          ...vault.config.extra,
          assets: { ...assets, copy: settings.copyOriginals ? 'original' : 'thumbnail' },
        },
      }
      await this.writeConfig(vault)
      return this.view(vault.id)
    })
  }

  // ---- kit updates ---------------------------------------------------------

  private pendingKitUpdate(vault: OpenVault): KitUpdate | null {
    const kit = this.kitOf(vault)
    if (!kit) return null
    const update = kitUpdate(kit, vault.config)
    if (isEmptyUpdate(update)) return null
    return this.deps.index.kitSeen(vault.id) === kitFingerprint(kit) ? null : update
  }

  private kitOf(vault: OpenVault): StarterKit | null {
    const id = vault.config.kit
    if (!id || id === 'blank') return null
    return this.kits().find((candidate) => candidate.id === id) ?? null
  }

  /** Adds the chosen sections and fields from the vault's kit to bible.json. Entry files are not touched. */
  async applyKitUpdate(
    vaultId: number,
    chosen: {
      sections: readonly string[]
      fields: ReadonlyArray<{ section: string; key: string }>
    },
  ): Promise<VaultView> {
    return this.exclusive(async () => {
      const { files, index } = this.deps
      const vault = this.vault(vaultId)
      const kit = this.kitOf(vault)
      if (!kit) throw new VaultError('This bible has no starter kit to update from')
      const update = kitUpdate(kit, vault.config)
      vault.config = applyKitUpdate(vault.config, update, chosen)
      for (const section of update.sections) {
        if (chosen.sections.includes(section.id)) files.mkdir(files.join(vault.root, section.id))
      }
      await this.writeConfig(vault)
      index.setKitSeen(vault.id, kitFingerprint(kit))
      this.reconcile(vault)
      return this.view(vault.id)
    })
  }

  /** Hides the kit update notice until the kit changes again. */
  dismissKitUpdate(vaultId: number): VaultView {
    const vault = this.vault(vaultId)
    const kit = this.kitOf(vault)
    if (kit) this.deps.index.setKitSeen(vault.id, kitFingerprint(kit))
    return this.view(vault.id)
  }

  // ---- sections ----------------------------------------------------------

  setSections(
    vaultId: number,
    sections: ReadonlyArray<{ id: string | null; name: string }>,
  ): Promise<VaultView> {
    return this.exclusive(() => this.setSectionsNow(vaultId, sections))
  }

  setSectionFields(
    vaultId: number,
    sectionId: string,
    inputs: readonly FieldInput[],
  ): Promise<VaultView> {
    return this.exclusive(() => this.setSectionFieldsNow(vaultId, sectionId, inputs))
  }

  removeSection(
    vaultId: number,
    sectionId: string,
  ): Promise<{ trashPath: string; section: Section; position: number; vault: VaultView }> {
    return this.exclusive(() => this.removeSectionNow(vaultId, sectionId))
  }

  restoreSection(
    vaultId: number,
    trashPath: string,
    section: Section & { fields?: FieldDef[]; extra?: Record<string, unknown> },
    position: number,
  ): Promise<VaultView> {
    return this.exclusive(() => this.restoreSectionNow(vaultId, trashPath, section, position))
  }

  private async writeConfig(vault: OpenVault): Promise<void> {
    const { files } = this.deps
    await files.writeTextAtomic(
      files.join(vault.root, CONFIG_FILE),
      serializeVaultConfig(vault.config),
    )
  }

  /**
   * Sets the section list: names and order of the existing sections, plus new
   * ones (id null). Every existing section must be listed; removal is separate.
   * Each section keeps its fields and any keys the app does not know.
   */
  private async setSectionsNow(
    vaultId: number,
    sections: ReadonlyArray<{ id: string | null; name: string }>,
  ): Promise<VaultView> {
    const { files } = this.deps
    const vault = this.vault(vaultId)
    const next: ConfigSection[] = []
    for (const section of sections) {
      const name = section.name.trim()
      if (name === '') throw new VaultError('A section needs a name')
      if (section.id === null) {
        const id = newSectionId(name, [...vault.config.sections, ...next])
        files.mkdir(files.join(vault.root, id))
        next.push({ id, name, fields: [], extra: {} })
      } else {
        next.push({ ...this.section(vault, section.id), name })
      }
    }
    const listed = new Set(next.map((section) => section.id))
    if (listed.size !== next.length) throw new VaultError('A section is listed twice')
    if (vault.config.sections.some((section) => !listed.has(section.id))) {
      throw new VaultError('Every section must be listed; remove sections one at a time')
    }
    vault.config = { ...vault.config, sections: next }
    await this.writeConfig(vault)
    return this.view(vault.id)
  }

  /**
   * Sets a section's fields: labels, order, new fields and removals. Removing
   * a field only removes its definition; values stay in the entry files.
   */
  private async setSectionFieldsNow(
    vaultId: number,
    sectionId: string,
    inputs: readonly FieldInput[],
  ): Promise<VaultView> {
    const vault = this.vault(vaultId)
    const section = this.section(vault, sectionId)
    const builtIn = new Set((KIND_FIELDS[sectionId] ?? []).map((field) => field.key))
    for (const input of inputs) {
      if (input.key !== null && builtIn.has(input.key)) {
        throw new VaultError(
          `${input.label} is built into ${section.name} and cannot be changed here`,
        )
      }
    }
    const taken = new Set([
      ...builtIn,
      ...inputs.map((input) => input.key).filter((key): key is string => !!key),
    ])
    const defs: Record<string, unknown>[] = []
    for (const input of inputs) {
      const label = input.label.trim()
      if (label === '') throw new VaultError('A field needs a label')
      let key = input.key
      if (key === null) {
        key = fieldKeyFromLabel(label, taken)
        taken.add(key)
      } else if (!isFieldKey(key)) {
        throw new VaultError(`"${key}" cannot be a field key`)
      }
      if (input.section !== undefined && input.section !== '') this.section(vault, input.section)
      defs.push({ ...input, key, label })
    }
    const fields = parseFieldDefs(defs)
    if (fields.length !== inputs.length) throw new VaultError('A field is invalid or listed twice')
    for (const field of fields) {
      if ((field.type === 'select' || field.type === 'multi-select') && !field.options?.length) {
        throw new VaultError(`${field.label} needs at least one choice`)
      }
    }
    vault.config = {
      ...vault.config,
      sections: vault.config.sections.map((candidate) =>
        candidate.id === section.id ? { ...candidate, fields } : candidate,
      ),
    }
    await this.writeConfig(vault)
    return this.view(vault.id)
  }

  /** Moves a section's folder into .trash/_sections and drops it from bible.json; returns what Undo needs. */
  private async removeSectionNow(
    vaultId: number,
    sectionId: string,
  ): Promise<{ trashPath: string; section: Section; position: number; vault: VaultView }> {
    const { files, index, clock } = this.deps
    const vault = this.vault(vaultId)
    const position = vault.config.sections.findIndex((section) => section.id === sectionId)
    const section = vault.config.sections[position]
    if (!section) throw new VaultError(`No section ${sectionId} in this bible`)
    const sectionsTrash = files.join(vault.root, TRASH_DIR, SECTIONS_TRASH)
    const trashName = files.exists(files.join(sectionsTrash, sectionId))
      ? `${sectionId}~${clock.now().getTime()}`
      : sectionId
    const trashPath = `${TRASH_DIR}/${SECTIONS_TRASH}/${trashName}`
    const folder = files.join(vault.root, sectionId)
    if (files.exists(folder)) await files.move(folder, files.join(sectionsTrash, trashName))
    else files.mkdir(files.join(sectionsTrash, trashName))
    vault.config = {
      ...vault.config,
      sections: vault.config.sections.filter((candidate) => candidate.id !== sectionId),
    }
    await this.writeConfig(vault)
    await this.writeTrashLog(vault, [
      ...this.readTrashLog(vault).filter((record) => record.trashPath !== trashPath),
      {
        trashPath,
        kind: 'section',
        from: section.id,
        name: section.name,
        deletedAt: clock.now().toISOString(),
        section: {
          id: section.id,
          name: section.name,
          fields: section.fields,
          extra: section.extra,
        },
        position,
      },
    ])
    this.reconcile(vault)
    if (index.lastEntry(vault.id)?.startsWith(`${sectionId}/`)) index.setLastEntry(vault.id, null)
    return {
      trashPath,
      section: { id: section.id, name: section.name },
      position,
      vault: this.view(vault.id),
    }
  }

  private async restoreSectionNow(
    vaultId: number,
    trashPath: string,
    section: Section & { fields?: FieldDef[]; extra?: Record<string, unknown> },
    position: number,
  ): Promise<VaultView> {
    const { files } = this.deps
    const vault = this.vault(vaultId)
    if (!TRASH_SECTION.test(trashPath) || trashPath.includes('..')) {
      throw new VaultError(`Not a trash path: ${trashPath}`)
    }
    if (!isSectionId(section.id)) throw new VaultError(`Not a section id: ${section.id}`)
    if (vault.config.sections.some((existing) => existing.id === section.id)) {
      throw new VaultError(`A section ${section.id} exists again; rename it first`)
    }
    const folder = files.join(vault.root, section.id)
    if (files.exists(folder))
      throw new VaultError(`A folder ${section.id} exists again; move it first`)
    // Undo passes only id and name; the trash log has the fields and other keys.
    const record = this.readTrashLog(vault).find((candidate) => candidate.trashPath === trashPath)
    const from = this.absolute(vault, trashPath)
    if (files.exists(from)) await files.move(from, folder)
    else files.mkdir(folder)
    const sections = [...vault.config.sections]
    sections.splice(Math.min(position, sections.length), 0, {
      id: section.id,
      name: section.name,
      fields: section.fields ?? record?.section?.fields ?? [],
      extra: section.extra ?? record?.section?.extra ?? {},
    })
    vault.config = { ...vault.config, sections }
    await this.writeConfig(vault)
    await this.forgetTrash(vault, trashPath)
    this.reconcile(vault)
    return this.view(vault.id)
  }
}

import type { FieldDef, ReadField } from './fields.ts'
import type { KitUpdate } from './kitUpdates.ts'

/** Version of the vault layout written to bible.json. */
export const VAULT_FORMAT = 1

/** Folders inside a vault the app never indexes. */
export const TRASH_DIR = '.trash'

/** A section of the vault: one folder of entries. The id is the folder name. */
export interface Section {
  id: string
  name: string
}

/** A section as bible.json declares it; keys the app does not know are kept in `extra`. */
export interface ConfigSection extends Section {
  fields: FieldDef[]
  extra: Record<string, unknown>
}

/** bible.json, as the app reads it. Unknown keys are kept in `extra` and written back. */
export interface VaultConfig {
  format: number
  title: string
  kit: string | null
  sections: ConfigSection[]
  extra: Record<string, unknown>
}

export interface StarterKitSection extends Section {
  /** Body used for a new entry in this section, or '' for none. */
  template: string
  /** Properties a new vault's section gets. */
  fields: FieldDef[]
}

/** What a vault is to the app: a game bible, or the study journal. */
export type VaultRole = 'bible' | 'journal'

export interface StarterKit {
  id: string
  name: string
  description: string
  /** Which kind of vault the kit makes; a kit.json without "role" makes bibles. */
  role: VaultRole
  sections: StarterKitSection[]
}

/** One entry file as parsed from disk. */
export interface ParsedEntry {
  /** Front-matter id, or null when the file has none yet. */
  id: string | null
  title: string
  tags: string[]
  order: number | null
  created: string | null
  updated: string | null
  body: string
  /** Lower-cased titles of every [[link]] in the body, once each. */
  links: string[]
  /** Every front-matter field as parsed, for section properties. */
  fields: Record<string, unknown>
}

/** What the index stores per entry. */
export interface IndexedEntry {
  path: string
  entryId: string
  section: string
  title: string
  titleKey: string
  order: number
  updated: string | null
  mtimeMs: number
  size: number
  body: string
  links: string[]
  tags: string[]
  created: string | null
  /** Entries this entry's fields point at, as stored (id or title). */
  refs: Array<{ key: string; target: string }>
  /** Content hashes of the _assets images listed in its "references". */
  assets: string[]
}

export interface EntrySummary {
  path: string
  title: string
}

/** An entry in the sidebar: its path, title and id ("path:..." when the file has none yet). */
export interface EntryListItem extends EntrySummary {
  id: string
  /** Not updated for 60 days while decisions linked to it changed since. */
  stale: boolean
  /** A decision or idea that names no pillar. */
  noPillar: boolean
}

export interface SectionView extends Section {
  fields: FieldDef[]
  entries: EntryListItem[]
}

export interface VaultSummary {
  id: number
  path: string
  title: string
}

export interface VaultView {
  vault: VaultSummary
  sections: SectionView[]
  /** Path of the entry to open, the one open last if it still exists. */
  lastEntry: string | null
  /** What the vault's starter kit offers that the vault lacks; null when nothing new to show. */
  kitUpdate: KitUpdate | null
  settings: VaultSettings
  role: VaultRole
  /** The section last chosen for entries created from missing links, by the link's section. */
  linkSections: Record<string, string>
}

/** Vault settings kept in bible.json. */
export interface VaultSettings {
  /** Copy original images into _assets instead of thumbnails. */
  copyOriginals: boolean
}

export interface EntryView {
  path: string
  id: string
  section: string
  title: string
  body: string
  /** Hash of the file's bytes; a save names the version it was based on. */
  version: string
  backlinks: EntrySummary[]
  tags: string[]
  /** The section's fields with this entry's values. */
  properties: PropertyView[]
  stale: boolean
  /** For a decision or idea: whether it names no pillar; null for other entries. */
  noPillar: boolean | null
  promotedFrom: EntrySummary | null
  promotedTo: EntrySummary | null
  /** For a pillar: the decisions and ideas that serve it. */
  servedBy: { decisions: EntrySummary[]; ideas: EntrySummary[] } | null
  /** Vault-relative paths of the images it lists in "references". */
  references: string[]
}

/** A decision in the timeline. */
export interface TimelineItem {
  path: string
  title: string
  date: string | null
  status: string | null
  pillars: EntrySummary[]
  noPillar: boolean
}

/** An idea on the board. */
/** A journal session as the Today page and the calendar list it. */
export interface SessionSummary {
  path: string
  title: string
  /** YYYY-MM-DD, or null when the session has no day. */
  date: string | null
}

/** The journal's Today page: today's sessions and where the last one said to go next. */
export interface TodayView {
  today: string
  sessions: SessionSummary[]
  previous: (SessionSummary & { nextTime: string | null }) | null
}

/** One session's own words, as a recap is built from them. */
export interface RecapSource {
  /** The session's front-matter id (what source_sessions lists). */
  id: string
  path: string
  title: string
  date: string | null
  /** Only the text under the Session template's headings. */
  text: string
}

/** One practice image in a topic's timeline. */
export interface PracticeImage {
  /** Vault-relative path in _assets. */
  asset: string
  session: SessionSummary
}

/** A resource in the Resources list or on a topic page. */
export interface ResourceItem {
  path: string
  title: string
  status: string | null
  url: string | null
  rating: string | null
  topics: EntrySummary[]
}

/** A topic's page: its practice images over time, its sessions and resources. */
export interface TopicProgress {
  /** Oldest first. */
  images: PracticeImage[]
  /** Newest first. */
  sessions: Array<SessionSummary & { minutes: number | null }>
  resources: ResourceItem[]
  /** Minutes logged on the topic's sessions; null when none were logged. */
  minutes: number | null
}

export interface IdeaCard {
  path: string
  title: string
  status: string
  pillars: EntrySummary[]
  noPillar: boolean
  promotedTo: EntrySummary | null
}

/** One property of an entry: its definition and its value as read from the file. */
export type PropertyView = FieldDef & ReadField

/** Something in the vault's .trash folder. */
export interface TrashItem {
  /** Vault-relative path inside .trash. */
  trashPath: string
  kind: 'entry' | 'section'
  /** Entry title or section name. */
  name: string
  /** Where it came from: an entry path, or a section id. */
  from: string
  /** Name of the section it came from (an entry) or its position (a section). */
  sectionName: string | null
  /** When it was deleted (ISO time), when the app recorded it. */
  deletedAt: string | null
  /** Entries inside, for a section. */
  entryCount: number
}

/** A pillar as a card: its title and the parts of its body. */
export interface PillarCard {
  path: string
  title: string
  feeling: string
  inPlay: string
  rulesOut: string
  /** How many decisions and ideas serve it. */
  decisions: number
  ideas: number
}

export interface SearchHit {
  path: string
  title: string
  section: string
  snippet: string
}

export interface RecentVault extends VaultSummary {
  exists: boolean
}

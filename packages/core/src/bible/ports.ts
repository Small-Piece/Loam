import type {
  IndexedEntry,
  RecentVault,
  SearchHit,
  StarterKit,
  VaultRole,
  VaultSummary,
} from './types.ts'

/** One entry as the index lists it. */
export interface IndexRow {
  path: string
  entryId: string
  section: string
  title: string
  titleKey: string
  order: number
  updated: string | null
  created: string | null
}

export interface FileStat {
  mtimeMs: number
  size: number
}

/**
 * File access for vaults. Paths are absolute; the service builds them from
 * the vault root and vault-relative paths with forward slashes.
 */
export interface VaultFiles {
  join(...parts: string[]): string
  exists(path: string): boolean
  stat(path: string): FileStat | null
  readText(path: string): string
  /** Writes through a temporary file and a rename, so a crash never leaves half a file. */
  writeTextAtomic(path: string, text: string): Promise<void>
  /** Writes bytes the same way. */
  writeBytesAtomic(path: string, bytes: Uint8Array): Promise<void>
  /** Creates a file only if it does not exist yet; returns false when it did. */
  createText(path: string, text: string): boolean
  mkdir(path: string): void
  /** Moves a file or folder; creates the target's parent folders. */
  move(from: string, to: string): Promise<void>
  remove(path: string): Promise<void>
  /** Deletes a folder and everything in it. */
  removeTree(path: string): Promise<void>
  /** Names (not paths) of the entries of a folder; empty when it does not exist. */
  list(path: string): Array<{ name: string; isDirectory: boolean }>
  /** Deletes temporary files an interrupted atomic write left in a folder. */
  removeStaleTemporaryFiles(path: string): void
  hash(text: string): string
}

/** Watches a vault folder; reports vault-relative paths that were added, changed or removed. */
export interface VaultWatcher {
  watch(root: string, onChange: (paths: string[]) => void): Promise<() => Promise<void>>
}

/** The rebuildable index and the list of known vaults. */
export interface BibleIndex {
  inTransaction<T>(work: () => T): T
  upsertVault(path: string, title: string, openedAt: string, role: VaultRole): VaultSummary
  getVault(id: number): VaultSummary | null
  /** The vaults of one role (bibles, or the journal), most recently opened first. */
  recentVaults(limit: number, role: VaultRole): Array<Omit<RecentVault, 'exists'>>
  setLastEntry(vaultId: number, path: string | null): void
  lastEntry(vaultId: number): string | null
  forgetVault(vaultId: number): void
  /** mtime and size of every indexed file, to find what changed since. */
  indexedFiles(vaultId: number): Map<string, { mtimeMs: number; size: number }>
  putEntry(vaultId: number, entry: IndexedEntry): void
  removeEntry(vaultId: number, path: string): void
  clear(vaultId: number): void
  listEntries(vaultId: number): IndexRow[]
  getEntry(
    vaultId: number,
    path: string,
  ): { path: string; entryId: string; section: string; title: string; titleKey: string } | null
  /** Entries whose body links to this lower-cased title. */
  linkingTo(vaultId: number, titleKey: string): Array<{ path: string; title: string }>
  search(vaultId: number, text: string, limit: number): SearchHit[]
  /** Every tag used in the vault, most used first. */
  vaultTags(vaultId: number): string[]
  /** Every field reference in the vault: which entry points at what, through which key. */
  allRefs(
    vaultId: number,
  ): Array<{ source: string; key: string; target: string; targetKey: string }>
  /** Every [[link]] in the vault, by source entry and lower-cased target title. */
  allLinks(vaultId: number): Array<{ source: string; targetKey: string }>
  /** Entries in any indexed vault that list one of these asset hashes. */
  entriesUsingAssets(
    hashes: readonly string[],
  ): Array<{ vaultId: number; vaultTitle: string; vaultPath: string; path: string; title: string }>
  kitSeen(vaultId: number): string | null
  setKitSeen(vaultId: number, fingerprint: string): void
  /** The section last chosen for entries created from missing links, by the link's section. */
  linkSections(vaultId: number): Record<string, string>
  setLinkSection(vaultId: number, sourceSection: string, targetSection: string): void
}

/** The Library, as far as the bible needs it: images to copy into a vault. */
export interface LibraryAssets {
  describe(ids: readonly number[]): Array<{
    id: number
    title: string
    imageHash: string
    imageMime: string
    thumbHash: string
  }>
  read(hash: string): Promise<Uint8Array>
}

export interface StarterKits {
  list(): StarterKit[]
}

export interface BibleClock {
  now(): Date
  /** A monotonic time in milliseconds, for measuring how long something took. */
  monotonicMs(): number
}

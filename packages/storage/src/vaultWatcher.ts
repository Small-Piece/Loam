import { statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { watch } from 'chokidar'
import type { VaultWatcher } from '@loam/core'
import { TEMP_FILE } from './vaultFiles.ts'

/** Changes are collected for this long and reported together. */
const BATCH_MS = 40
/**
 * chokidar drops a second "change" for the same file within 50 ms of the
 * first and never reports it later. So each reported file is looked at once
 * more after this long, and reported again if it changed in between.
 */
export const RECHECK_MS = 120

/** The vault-relative path with forward slashes, or null when the watcher should skip it. */
export function watchedPath(root: string, path: string, isFile: boolean | null): string | null {
  const rel = relative(root, path)
  if (rel === '') return null
  const parts = rel.split(sep)
  // Hidden folders and files (.git, .trash, temp files) and dependency folders.
  if (parts.some((part) => part.startsWith('.') || part === 'node_modules')) return null
  const name = parts[parts.length - 1] ?? ''
  if (TEMP_FILE.test(name)) return null
  if (isFile && !name.endsWith('.md') && !(parts.length === 1 && name === 'bible.json')) return null
  return parts.join('/')
}

/** Size and modification time, or 'gone'; enough to tell that a file changed. */
function fingerprint(file: string): string {
  try {
    const stat = statSync(file)
    return `${stat.size}:${stat.mtimeMs}`
  } catch {
    return 'gone'
  }
}

/** Watches a vault with chokidar: outside edits (git pull, another editor, an agent). */
export class ChokidarVaultWatcher implements VaultWatcher {
  private readonly batchMs: number

  /** batchMs: how long changes are collected before being reported together. */
  constructor(options: { batchMs?: number } = {}) {
    this.batchMs = options.batchMs ?? BATCH_MS
  }

  async watch(root: string, onChange: (paths: string[]) => void): Promise<() => Promise<void>> {
    let pending = new Set<string>()
    let timer: NodeJS.Timeout | null = null
    let closed = false
    const rechecks = new Set<NodeJS.Timeout>()
    const absolute = (rel: string) => join(root, ...rel.split('/'))

    const recheck = (seen: Map<string, string>) => {
      const timeout = setTimeout(() => {
        rechecks.delete(timeout)
        if (closed) return
        for (const [rel, before] of seen) {
          if (fingerprint(absolute(rel)) !== before) add(rel)
        }
      }, RECHECK_MS)
      rechecks.add(timeout)
    }

    const flush = () => {
      timer = null
      const paths = [...pending]
      pending = new Set()
      if (paths.length === 0 || closed) return
      recheck(new Map(paths.map((rel) => [rel, fingerprint(absolute(rel))])))
      onChange(paths)
    }

    const add = (rel: string) => {
      pending.add(rel)
      timer ??= setTimeout(flush, this.batchMs)
    }

    const watcher = watch(root, {
      ignoreInitial: true,
      // Sections are one level down; entries sit directly in them.
      depth: 1,
      // chokidar passes paths with forward slashes; relative() compares them with the root.
      ignored: (path, stats) =>
        relative(root, path) !== '' &&
        watchedPath(root, path, stats ? stats.isFile() : null) === null,
    })
    const report = (path: string) => {
      const rel = watchedPath(root, path, null)
      if (rel !== null) add(rel)
    }
    for (const event of ['add', 'change', 'unlink', 'addDir', 'unlinkDir'] as const) {
      watcher.on(event, report)
    }
    await new Promise<void>((resolve) => watcher.once('ready', () => resolve()))
    return async () => {
      closed = true
      if (timer) clearTimeout(timer)
      for (const timeout of rechecks) clearTimeout(timeout)
      await watcher.close()
    }
  }
}

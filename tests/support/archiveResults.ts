import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'

/** Playwright writes this into the folder of every failed test. */
const FAILURE_MARK = 'error-context.md'

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** A folder name that sorts by time: 2026-10-13T09-05-30. */
export function stamp(at: Date): string {
  return (
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}` +
    `T${pad(at.getHours())}-${pad(at.getMinutes())}-${pad(at.getSeconds())}`
  )
}

/** Moves a folder, copying when a rename is not possible (another drive, a locked handle). */
function move(from: string, to: string): void {
  try {
    renameSync(from, to)
  } catch {
    cpSync(from, to, { recursive: true })
    rmSync(from, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

/**
 * Before a run clears test-results/, moves the folders of failed tests from
 * the previous run into <archive>/<timestamp>/, and keeps only the newest
 * `keep` archives. Returns the archive folder used, or null when there was
 * nothing to keep.
 */
export function archiveFailures(options: {
  resultsDir: string
  archiveDir: string
  keep?: number
  now?: Date
}): string | null {
  const { resultsDir, archiveDir, keep = 10, now = new Date() } = options
  if (!existsSync(resultsDir)) return null
  const failed = readdirSync(resultsDir, { withFileTypes: true }).filter(
    (entry) => entry.isDirectory() && existsSync(join(resultsDir, entry.name, FAILURE_MARK)),
  )
  let target: string | null = null
  if (failed.length > 0) {
    mkdirSync(archiveDir, { recursive: true })
    target = join(archiveDir, stamp(now))
    for (let count = 2; existsSync(target); count++) {
      target = join(archiveDir, `${stamp(now)}-${count}`)
    }
    mkdirSync(target)
    for (const entry of failed) move(join(resultsDir, entry.name), join(target, entry.name))
  }
  if (existsSync(archiveDir)) {
    const archives = readdirSync(archiveDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
    for (const old of archives.slice(0, Math.max(0, archives.length - keep))) {
      rmSync(join(archiveDir, old), {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      })
    }
  }
  return target
}

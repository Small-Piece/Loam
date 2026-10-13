import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ChokidarVaultWatcher, watchedPath } from './vaultWatcher.ts'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'loam-watch-'))
  mkdirSync(join(root, 'ideas'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** Resolves with the next onChange call that includes this path, or rejects after `ms`. */
function nextReport(
  calls: Array<{ paths: string[]; resolve?: () => void }>,
  path: string,
  ms: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no report of ${path} within ${ms} ms`)), ms)
    calls.push({
      paths: [path],
      resolve: () => {
        clearTimeout(timer)
        resolve()
      },
    })
  })
}

describe('ChokidarVaultWatcher', () => {
  it('reports a second write that lands inside chokidar’s 50 ms change throttle', async () => {
    const file = join(root, 'ideas', 'rope.md')
    writeFileSync(file, 'v0')
    const waiting: Array<{ paths: string[]; resolve?: () => void }> = []
    // No batching: the first report comes right after chokidar's event, so the
    // second write below lands inside chokidar's 50 ms throttle for this file.
    const stop = await new ChokidarVaultWatcher({ batchMs: 0 }).watch(root, (paths) => {
      for (const wait of waiting.splice(0)) {
        if (paths.includes(wait.paths[0] ?? '')) wait.resolve?.()
        else waiting.push(wait)
      }
    })
    try {
      const first = nextReport(waiting, 'ideas/rope.md', 2000)
      writeFileSync(file, 'version one')
      await first
      // Right after the first report: inside the throttle window of chokidar's first event.
      const second = nextReport(waiting, 'ideas/rope.md', 1000)
      writeFileSync(file, 'version two, longer')
      await second
    } finally {
      await stop()
    }
  })

  it('skips hidden folders, temporary files and non-Markdown files', () => {
    expect(watchedPath(root, join(root, '.trash', 'x.md'), true)).toBeNull()
    expect(watchedPath(root, join(root, 'ideas', '.rope.md.0a1b2c3d.um-tmp'), true)).toBeNull()
    expect(watchedPath(root, join(root, 'ideas', 'map.png'), true)).toBeNull()
    expect(watchedPath(root, join(root, 'bible.json'), true)).toBe('bible.json')
    expect(watchedPath(root, join(root, 'ideas', 'rope.md'), true)).toBe('ideas/rope.md')
  })
})

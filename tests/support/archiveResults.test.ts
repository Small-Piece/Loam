import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { archiveFailures, stamp } from './archiveResults.ts'

let dir: string
const results = () => join(dir, 'test-results')
const archive = () => join(dir, 'test-results-archive')

function testFolder(name: string, failed: boolean) {
  mkdirSync(join(results(), name), { recursive: true })
  writeFileSync(join(results(), name, failed ? 'error-context.md' : 'trace.zip'), 'x')
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'loam-archive-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('archiving failed E2E results', () => {
  it('moves only failed tests out of test-results, into a timestamped folder', () => {
    testFolder('bible-links-failed', true)
    testFolder('canvas-passed', false)
    writeFileSync(join(results(), '.last-run.json'), '{}')
    const now = new Date(2026, 9, 13, 9, 5, 30)
    const target = archiveFailures({ resultsDir: results(), archiveDir: archive(), now })
    expect(target).toBe(join(archive(), '2026-10-13T09-05-30'))
    expect(readdirSync(target ?? '')).toEqual(['bible-links-failed'])
    expect(existsSync(join(target ?? '', 'bible-links-failed', 'error-context.md'))).toBe(true)
    expect(readdirSync(results()).sort()).toEqual(['.last-run.json', 'canvas-passed'])
    // A second run in the same second does not overwrite the first.
    testFolder('bible-links-failed', true)
    expect(archiveFailures({ resultsDir: results(), archiveDir: archive(), now })).toBe(
      join(archive(), '2026-10-13T09-05-30-2'),
    )
  })

  it('does nothing without failures or without test-results', () => {
    expect(archiveFailures({ resultsDir: results(), archiveDir: archive() })).toBeNull()
    testFolder('passed', false)
    expect(archiveFailures({ resultsDir: results(), archiveDir: archive() })).toBeNull()
    expect(existsSync(archive())).toBe(false)
  })

  it('keeps the newest ten archives', () => {
    for (let minute = 0; minute < 12; minute++) {
      testFolder(`failed-${minute}`, true)
      archiveFailures({
        resultsDir: results(),
        archiveDir: archive(),
        now: new Date(2026, 9, 13, 9, minute, 0),
      })
    }
    const kept = readdirSync(archive()).sort()
    expect(kept).toHaveLength(10)
    expect(kept[0]).toBe(stamp(new Date(2026, 9, 13, 9, 2, 0)))
    expect(kept.at(-1)).toBe(stamp(new Date(2026, 9, 13, 9, 11, 0)))
  })
})

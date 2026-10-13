import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { copySampleBible, SAMPLE_BIBLE } from './sample.ts'

const repo = fileURLToPath(new URL('../../..', import.meta.url))
const sample = join(repo, SAMPLE_BIBLE)

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'loam-sample-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function tree(root: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (current: string) => {
    for (const name of readdirSync(current)) {
      const path = join(current, name)
      const stat = lstatSync(path)
      if (stat.isDirectory()) walk(path)
      else
        out[relative(root, path)] =
          `${stat.mtimeMs}|${createHash('sha256').update(readFileSync(path)).digest('hex')}`
    }
  }
  walk(root)
  return out
}

const hashes = (files: Record<string, string>) =>
  Object.fromEntries(Object.entries(files).map(([path, value]) => [path, value.split('|')[1]]))

describe('copySampleBible', () => {
  it('copies the whole sample into <folder>/bible and leaves the bundled copy unchanged', () => {
    const before = tree(sample)
    const target = copySampleBible(sample, join(dir, 'My sample'))

    expect(target).toBe(join(dir, 'My sample', 'bible'))
    expect(hashes(tree(target))).toEqual(hashes(before))
    expect(tree(sample)).toEqual(before)
    expect(existsSync(join(target, '_assets', 'CREDITS.md'))).toBe(true)
  })

  it('uses an existing empty bible folder', () => {
    mkdirSync(join(dir, 'bible'))
    expect(copySampleBible(sample, dir)).toBe(join(dir, 'bible'))
    expect(existsSync(join(dir, 'bible', 'bible.json'))).toBe(true)
  })

  it('refuses a folder that already has a bible or other files in it', () => {
    mkdirSync(join(dir, 'bible'))
    writeFileSync(join(dir, 'bible', 'notes.md'), 'mine')
    expect(() => copySampleBible(sample, dir)).toThrow(/already exists and is not empty/)
    expect(readdirSync(join(dir, 'bible'))).toEqual(['notes.md'])
  })

  it('fails clearly when the sample is missing', () => {
    expect(() => copySampleBible(join(dir, 'nowhere'), dir)).toThrow(/sample bible is missing/)
  })
})

describe('the shipped sample', () => {
  const read = (path: string) => readFileSync(join(sample, path), 'utf8')

  it('is "The Lantern Coast", made with the atmospheric horror kit', () => {
    const config = JSON.parse(read('bible.json')) as { title: string; kit: string }
    expect(config).toMatchObject({ title: 'The Lantern Coast', kit: 'atmospheric-horror' })
  })

  it('has 3 pillars with every template heading answered', () => {
    const pillars = readdirSync(join(sample, 'pillars'))
    expect(pillars).toHaveLength(3)
    for (const name of pillars) {
      const text = read(join('pillars', name))
      for (const heading of [
        '## What players should feel',
        '## What this looks like in play',
        '## What this rules out',
      ]) {
        const after = text.split(heading)[1] ?? ''
        expect(after.trim().split('\n')[0]?.trim(), `${name}: ${heading}`).not.toBe('')
      }
    }
  })

  it('has 3 decisions and 4 ideas in different states, and links between entries', () => {
    const statuses = (section: string) =>
      readdirSync(join(sample, section)).map(
        (name) => /^status: (.+)$/m.exec(read(join(section, name)))?.[1],
      )
    expect(statuses('decisions').sort()).toEqual(['decided', 'reversed', 'revisited'])
    expect(statuses('ideas').sort()).toEqual(['dropped', 'parked', 'parked', 'promoted'])
    expect(read(join('world', 'the-drowned-stair.md'))).toContain('[[Tallow Wife]]')
  })
})

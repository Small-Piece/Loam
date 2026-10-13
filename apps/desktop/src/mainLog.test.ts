import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createMainLog, LOG_SIZE_LIMIT, redactPaths } from './mainLog.ts'

const data = 'C:\\Users\\Dev\\AppData\\Local\\Loam'
const install = 'C:\\Users\\Dev\\AppData\\Local\\Programs\\Loam'
const allowed = [data, install]
const blocked = [`${data}\\files`]

describe('redactPaths', () => {
  it('keeps paths inside the app folders', () => {
    const line = `backed up to ${data}\\backups\\loam-4-20261012T113318055Z.db`
    expect(redactPaths(line, allowed, blocked)).toBe(line)
    const stack = `at start (${install}\\resources\\app.asar\\dist\\main.cjs:80:3)`
    expect(redactPaths(stack, allowed, blocked)).toBe(stack)
  })

  it('hides user image paths, quoted with spaces or bare, and UNC paths', () => {
    expect(
      redactPaths(
        "ENOENT: no such file or directory, open 'D:\\Art refs\\Moodboard\\rim light.png'",
        allowed,
        blocked,
      ),
    ).toBe("ENOENT: no such file or directory, open '<path>'")
    expect(redactPaths('read D:/refs/castle.jpg failed', allowed, blocked)).toBe(
      'read <path> failed',
    )
    expect(redactPaths('at \\\\nas\\photos\\a.png', allowed, blocked)).toBe('at <path>')
  })

  it('hides stored images even though they live in the data folder', () => {
    expect(redactPaths(`open ${data}\\files\\ab\\abcdef.webp`, allowed, blocked)).toBe(
      'open <path>',
    )
  })

  it('does not treat a sibling folder with the same prefix as inside', () => {
    expect(redactPaths(`${data}Extra\\x.png`, allowed, blocked)).toBe('<path>')
  })
})

describe('createMainLog', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'loam-log-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const at = () => new Date(Date.UTC(2026, 9, 12, 11, 33, 18, 55))

  it('appends timestamped lines and creates the folder', () => {
    const logs = join(dir, 'logs')
    const log = createMainLog(logs, { allowedRoots: [dir], blockedRoots: [], now: at })
    log.info('[startup] launch')
    log.error('[startup] failed', new Error('SQLITE_BUSY: database is locked'))
    const text = readFileSync(join(logs, 'main.log'), 'utf8')
    expect(text).toContain(`2026-10-12T11:33:18.055Z info  [pid ${process.pid}] [startup] launch\n`)
    expect(text).toContain('error')
    expect(text).toContain('[startup] failed: Error: SQLITE_BUSY: database is locked')
  })

  it('rotates to one .1 file and stays under the limit', () => {
    const log = createMainLog(dir, { allowedRoots: [], blockedRoots: [], limit: 1000 })
    for (let index = 0; index < 100; index++) log.info(`line ${index} ${'x'.repeat(40)}`)
    expect(readdirSync(dir).sort()).toEqual(['main.log', 'main.log.1'])
    expect(statSync(join(dir, 'main.log')).size).toBeLessThanOrEqual(1000)
    expect(statSync(join(dir, 'main.log.1')).size).toBeLessThanOrEqual(1000)
    expect(readFileSync(join(dir, 'main.log'), 'utf8')).toContain('line 99 ')
  })

  it('defaults to a 1 MB limit, replacing an older rotated file', () => {
    writeFileSync(join(dir, 'main.log'), 'x'.repeat(LOG_SIZE_LIMIT - 10))
    writeFileSync(join(dir, 'main.log.1'), 'old')
    createMainLog(dir, { allowedRoots: [], blockedRoots: [] }).info('next')
    expect(statSync(join(dir, 'main.log.1')).size).toBe(LOG_SIZE_LIMIT - 10)
    expect(readFileSync(join(dir, 'main.log'), 'utf8')).toMatch(/next\n$/)
  })

  it('never throws when the log cannot be written', () => {
    const file = join(dir, 'not-a-folder')
    writeFileSync(file, '')
    const log = createMainLog(file, { allowedRoots: [], blockedRoots: [] })
    expect(() => log.info('ignored')).not.toThrow()
  })
})

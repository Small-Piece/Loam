import { createHash, randomBytes } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { mkdir, open, rename, rm, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { FileStat, VaultFiles } from '@loam/core'

const ID_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789'

/** A new entry id: 12 random characters from a 32-letter alphabet without look-alikes. */
export function newEntryId(): string {
  return Array.from(randomBytes(12), (byte) => ID_ALPHABET[byte % ID_ALPHABET.length]).join('')
}

/** Temporary files of an atomic write: ".<name>.<8 hex>.um-tmp", next to the target. */
export const TEMP_FILE = /^\..+\.[0-9a-f]{8}\.um-tmp$/

// Windows refuses to replace a file another process has open for a moment
// (an editor, a virus scanner, the file watcher reading it); try again briefly.
const BUSY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES'])
const BUSY_ATTEMPTS = 10
const BUSY_WAIT_MS = 25

function code(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code
}

async function whileBusy(work: () => Promise<void>): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await work()
      return
    } catch (error) {
      if (!BUSY_CODES.has(code(error) ?? '') || attempt >= BUSY_ATTEMPTS) throw error
      await new Promise((resolve) => setTimeout(resolve, BUSY_WAIT_MS * attempt))
    }
  }
}

/** Vault files on the local disk. */
export class NodeVaultFiles implements VaultFiles {
  join(...parts: string[]): string {
    return join(...parts)
  }

  exists(path: string): boolean {
    return existsSync(path)
  }

  stat(path: string): FileStat | null {
    try {
      const stat = statSync(path)
      return stat.isFile() ? { mtimeMs: stat.mtimeMs, size: stat.size } : null
    } catch {
      return null
    }
  }

  readText(path: string): string {
    return readFileSync(path, 'utf8')
  }

  /**
   * Writes the text to a temporary file next to the target, flushes it to
   * disk, then renames it over the target. A crash at any point leaves
   * either the old file or the new one, never a mix.
   */
  async writeTextAtomic(path: string, text: string): Promise<void> {
    await this.writeBytesAtomic(path, Buffer.from(text, 'utf8'))
  }

  async writeBytesAtomic(path: string, bytes: Uint8Array): Promise<void> {
    await mkdir(dirname(path), { recursive: true })
    const temp = join(dirname(path), `.${basename(path)}.${randomBytes(4).toString('hex')}.um-tmp`)
    try {
      const handle = await open(temp, 'w')
      try {
        await handle.writeFile(bytes)
        await handle.sync()
      } finally {
        await handle.close()
      }
      await whileBusy(() => rename(temp, path))
    } catch (error) {
      await unlink(temp).catch(() => undefined)
      throw error
    }
  }

  createText(path: string, text: string): boolean {
    mkdirSync(dirname(path), { recursive: true })
    try {
      writeFileSync(path, text, { encoding: 'utf8', flag: 'wx' })
      return true
    } catch (error) {
      if (code(error) === 'EEXIST') return false
      throw error
    }
  }

  mkdir(path: string): void {
    mkdirSync(path, { recursive: true })
  }

  async move(from: string, to: string): Promise<void> {
    await mkdir(dirname(to), { recursive: true })
    if (existsSync(to)) throw new Error(`Cannot move onto an existing file: ${to}`)
    await whileBusy(() => rename(from, to))
  }

  async remove(path: string): Promise<void> {
    await whileBusy(() => rm(path, { force: true }))
  }

  async removeTree(path: string): Promise<void> {
    await whileBusy(() => rm(path, { recursive: true, force: true }))
  }

  list(path: string): Array<{ name: string; isDirectory: boolean }> {
    try {
      return readdirSync(path, { withFileTypes: true }).map((entry) => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
      }))
    } catch (error) {
      if (code(error) === 'ENOENT' || code(error) === 'ENOTDIR') return []
      throw error
    }
  }

  removeStaleTemporaryFiles(path: string): void {
    for (const entry of this.list(path)) {
      if (entry.isDirectory || !TEMP_FILE.test(entry.name)) continue
      try {
        unlinkSync(join(path, entry.name))
      } catch {
        // Still open somewhere; the next open cleans it up.
      }
    }
  }

  hash(text: string): string {
    return createHash('sha256').update(text, 'utf8').digest('hex')
  }
}

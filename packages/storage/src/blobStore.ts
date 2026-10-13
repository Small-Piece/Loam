import { createHash, randomBytes } from 'node:crypto'
import { access, mkdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { BlobStore, Hasher } from '@loam/core'

const HASH = /^[0-9a-f]{64}$/

export function isContentHash(value: string): boolean {
  return HASH.test(value)
}

export const sha256Hasher: Hasher = {
  sha256: (bytes) => createHash('sha256').update(bytes).digest('hex'),
}

/**
 * Content-addressed file store. A blob lives at <root>/<first 2 hex>/<hash>;
 * the same bytes always land in the same file, so storing twice is a no-op.
 */
export class FileBlobStore implements BlobStore {
  private readonly root: string

  constructor(root: string) {
    this.root = root
  }

  pathOf(hash: string): string {
    if (!isContentHash(hash)) throw new Error(`Not a content hash: ${hash}`)
    return join(this.root, hash.slice(0, 2), hash)
  }

  async has(hash: string): Promise<boolean> {
    try {
      await access(this.pathOf(hash))
      return true
    } catch {
      return false
    }
  }

  async put(hash: string, bytes: Uint8Array): Promise<void> {
    const target = this.pathOf(hash)
    if (await this.has(hash)) return
    await mkdir(join(this.root, hash.slice(0, 2)), { recursive: true })
    // Write to a unique temp file, then rename, so a crash never leaves a partial blob.
    const temp = `${target}.${randomBytes(6).toString('hex')}.tmp`
    try {
      await writeFile(temp, bytes)
      await rename(temp, target)
    } catch (error) {
      await rm(temp, { force: true })
      if (await this.has(hash)) return
      throw error
    }
  }

  async delete(hash: string): Promise<boolean> {
    try {
      await unlink(this.pathOf(hash))
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }

  read(hash: string): Promise<Buffer> {
    return readFile(this.pathOf(hash))
  }
}

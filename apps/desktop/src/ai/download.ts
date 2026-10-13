import { createHash } from 'node:crypto'
import {
  createReadStream,
  createWriteStream,
  existsSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/** The file arrived but its SHA-256 is not the pinned one: it was deleted. */
export class ChecksumError extends Error {
  override name = 'ChecksumError'
}

/** The download was cancelled; the partial file stays for a resume. */
export class DownloadCancelledError extends Error {
  override name = 'DownloadCancelledError'
  constructor() {
    super('Download cancelled')
  }
}

export interface DownloadRequest {
  url: string
  /** Where the verified file ends up; "<dest>.part" holds it until then. */
  dest: string
  size: number
  sha256: string
  signal?: AbortSignal
  /** Bytes of this file on disk so far, as it grows. */
  onProgress?: (received: number) => void
  fetchImpl?: typeof fetch
}

export function partPath(dest: string): string {
  return `${dest}.part`
}

/** Bytes already downloaded for a file, finished or not. */
export function bytesOnDisk(dest: string): number {
  if (existsSync(dest)) return statSync(dest).size
  const part = partPath(dest)
  return existsSync(part) ? statSync(part).size : 0
}

async function sha256Of(file: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(file), hash)
  return hash.digest('hex')
}

/**
 * Downloads one file, resuming a partial download with an HTTP Range request
 * (or starting over when the server does not support it), then checks its
 * size and SHA-256 against the pinned values. A file that does not match is
 * deleted and rejected; a cancelled download keeps its partial file.
 */
export async function downloadFile(request: DownloadRequest): Promise<void> {
  const { url, dest, size, sha256, signal, onProgress } = request
  const fetchImpl = request.fetchImpl ?? fetch
  const part = partPath(dest)
  let start = existsSync(part) ? statSync(part).size : 0
  if (start > size) {
    unlinkSync(part)
    start = 0
  }
  if (start < size) {
    let response: Response
    try {
      response = await fetchImpl(url, {
        headers: start > 0 ? { range: `bytes=${start}-` } : {},
        redirect: 'follow',
        ...(signal ? { signal } : {}),
      })
    } catch (error) {
      if (signal?.aborted) throw new DownloadCancelledError()
      throw error
    }
    if (response.status !== 200 && response.status !== 206) {
      throw new Error(`The server answered ${response.status} for ${url}`)
    }
    if (!response.body) throw new Error(`No data from ${url}`)
    // 200 to a range request: the server sends the whole file again.
    const append = response.status === 206 && start > 0
    let received = append ? start : 0
    const count = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        received += chunk.length
        if (received > size) {
          done(new ChecksumError('The file is larger than expected'))
          return
        }
        onProgress?.(received)
        done(null, chunk)
      },
    })
    try {
      await pipeline(
        Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),
        count,
        createWriteStream(part, { flags: append ? 'a' : 'w' }),
        ...(signal ? [{ signal }] : []),
      )
    } catch (error) {
      if (signal?.aborted) throw new DownloadCancelledError()
      if (error instanceof ChecksumError) {
        unlinkSync(part)
        throw error
      }
      throw error
    }
  }
  const actual = statSync(part)
  if (actual.size !== size || (await sha256Of(part)) !== sha256) {
    unlinkSync(part)
    throw new ChecksumError('The downloaded file did not match its checksum and was deleted')
  }
  renameSync(part, dest)
}

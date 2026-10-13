import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ChecksumError, DownloadCancelledError, downloadFile, partPath } from './download.ts'

// A local server only: these tests never reach the network.
const SIZE = 3 * 1024 * 1024
const payload = Buffer.alloc(SIZE, 0)
for (let index = 0; index < SIZE; index++) payload[index] = (index * 31) % 251
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

let dir: string
let server: Server
let base: string
let requests: Array<{ range: string | undefined }>
let rangeSupport = true
let corrupt = false
let slow = false

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'loam-download-'))
  requests = []
  rangeSupport = true
  corrupt = false
  slow = false
  server = createServer((request, response) => {
    requests.push({ range: request.headers.range })
    const body = corrupt ? Buffer.from(payload).fill(7, 1000, 1010) : payload
    const match = /^bytes=(\d+)-$/.exec(request.headers.range ?? '')
    const start = rangeSupport && match ? Number(match[1]) : 0
    response.writeHead(start > 0 ? 206 : 200, { 'content-length': String(SIZE - start) })
    // Send in chunks, slowly when asked, so a cancel can land mid-way.
    let at = start
    const step = () => {
      if (at >= SIZE) {
        response.end()
        return
      }
      const next = Math.min(SIZE, at + 64 * 1024)
      response.write(body.subarray(at, next))
      at = next
      if (slow) setTimeout(step, 5)
      else setImmediate(step)
    }
    step()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})

afterEach(async () => {
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
  rmSync(dir, { recursive: true, force: true })
})

describe('model download', () => {
  it('downloads, verifies the SHA-256 and moves the file into place', async () => {
    const dest = join(dir, 'model.gguf')
    const progress: number[] = []
    await downloadFile({
      url: `${base}/model.gguf`,
      dest,
      size: SIZE,
      sha256: sha(payload),
      onProgress: (received) => progress.push(received),
    })
    expect(readFileSync(dest).equals(payload)).toBe(true)
    expect(existsSync(partPath(dest))).toBe(false)
    expect(progress.at(-1)).toBe(SIZE)
  })

  it('survives a cancel and resumes with a Range request', async () => {
    const dest = join(dir, 'model.gguf')
    slow = true
    const controller = new AbortController()
    const first = downloadFile({
      url: `${base}/model.gguf`,
      dest,
      size: SIZE,
      sha256: sha(payload),
      signal: controller.signal,
      onProgress: (received) => {
        if (received > SIZE / 3) controller.abort()
      },
    })
    await expect(first).rejects.toBeInstanceOf(DownloadCancelledError)
    const kept = statSync(partPath(dest)).size
    expect(kept).toBeGreaterThan(0)
    expect(kept).toBeLessThan(SIZE)
    slow = false
    await downloadFile({ url: `${base}/model.gguf`, dest, size: SIZE, sha256: sha(payload) })
    expect(requests.at(-1)?.range).toBe(`bytes=${kept}-`)
    expect(readFileSync(dest).equals(payload)).toBe(true)
  })

  it('starts over when the server ignores the Range header', async () => {
    const dest = join(dir, 'model.gguf')
    writeFileSync(partPath(dest), payload.subarray(0, 1000))
    rangeSupport = false
    await downloadFile({ url: `${base}/model.gguf`, dest, size: SIZE, sha256: sha(payload) })
    expect(readFileSync(dest).equals(payload)).toBe(true)
  })

  it('rejects and deletes a corrupted file', async () => {
    const dest = join(dir, 'model.gguf')
    corrupt = true
    await expect(
      downloadFile({ url: `${base}/model.gguf`, dest, size: SIZE, sha256: sha(payload) }),
    ).rejects.toBeInstanceOf(ChecksumError)
    expect(existsSync(dest)).toBe(false)
    expect(existsSync(partPath(dest))).toBe(false)
  })

  it('rejects a file larger than pinned', async () => {
    const dest = join(dir, 'model.gguf')
    await expect(
      downloadFile({ url: `${base}/model.gguf`, dest, size: SIZE - 10, sha256: sha(payload) }),
    ).rejects.toBeInstanceOf(ChecksumError)
    expect(existsSync(partPath(dest))).toBe(false)
  })
})

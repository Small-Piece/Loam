import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { LlamaServerProvider } from './llamaServer.ts'

// Runs only with a downloaded model (LOAM_E2E_MODELS_DIR or the old UM_E2E_MODELS_DIR, the app's models folder layout).
const modelsDir = process.env['LOAM_E2E_MODELS_DIR'] ?? process.env['UM_E2E_MODELS_DIR']

/** A small solid-colour PNG, built with zlib only. */
function png(width: number, height: number): Uint8Array {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const out = Buffer.alloc(body.length + 8)
    out.writeUInt32BE(data.length, 0)
    body.copy(out, 4)
    out.writeUInt32BE(crc32(body), body.length + 4)
    return out
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, 2, 0, 0, 0], 8)
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x60)])
  const pixels = Buffer.concat(Array.from({ length: height }, () => row))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

describe.skipIf(!modelsDir)('llama-server (real model)', () => {
  it('answers only requests with its per-launch API key, which is not on the command line', async () => {
    const dir = modelsDir ?? ''
    const provider = new LlamaServerProvider({
      serverPath: join(dir, 'runtime', 'llama-server.exe'),
      modelPath: join(dir, 'Qwen3VL-4B-Instruct-Q4_K_M.gguf'),
      projectorPath: join(dir, 'mmproj-Qwen3VL-4B-Instruct-Q8_0.gguf'),
      log: () => undefined,
    })
    try {
      const tags = await provider.tagImage({ bytes: png(128, 128), mime: 'image/png' })
      expect(tags.length).toBeGreaterThan(0)
      // Private fields, read here only to call the server the way another program would.
      const { port, apiKey } = provider as unknown as { port: number; apiKey: string }
      const url = `http://127.0.0.1:${port}/v1/models`
      expect((await fetch(url)).status).toBe(401)
      expect((await fetch(url, { headers: { authorization: 'Bearer wrong' } })).status).toBe(401)
      expect((await fetch(url, { headers: { authorization: `Bearer ${apiKey}` } })).status).toBe(
        200,
      )
      const commandLines = String(
        execFileSync('powershell.exe', [
          '-NoProfile',
          '-Command',
          '(Get-CimInstance Win32_Process -Filter "Name=\'llama-server.exe\'").CommandLine',
        ]),
      )
      expect(commandLines).toContain('--offline')
      expect(commandLines).not.toContain(apiKey)
    } finally {
      await provider.cancel()
    }
  }, 120_000)
})

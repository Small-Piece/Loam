import { readFile } from 'node:fs/promises'
import { protocol } from 'electron'
import { sniffImageMime } from '@loam/core'
import { ASSET_SCHEME } from '@loam/protocol/bridge'
import { isContentHash, type FileBlobStore } from '@loam/storage'

/** Must run before app ready: lets the UI load loam-asset:// URLs like regular images. */
export function registerAssetScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: ASSET_SCHEME, privileges: { standard: true, secure: true } },
  ])
}

function status(code: number): Response {
  return new Response(null, { status: code })
}

/**
 * Serves loam-asset://cas/<sha256> from the content-addressed store, and
 * loam-asset://vault/<path> from the open bible and loam-asset://journal/<path>
 * from the open journal. Only well-formed hashes are accepted for the store;
 * a vault path goes through vaultFile, which keeps it inside that vault.
 * Only bytes that are images are returned.
 */
export function serveAssets(
  blobs: FileBlobStore,
  vaultFile: (host: 'vault' | 'journal', relativePath: string) => string | null,
): void {
  protocol.handle(ASSET_SCHEME, async (request) => {
    if (request.method !== 'GET') return status(405)
    const url = new URL(request.url)
    let bytes: Buffer
    const host = url.hostname
    if (host === 'vault' || host === 'journal') {
      let relative: string
      try {
        relative = decodeURIComponent(url.pathname.replace(/^\//, ''))
      } catch {
        return status(404)
      }
      const file = vaultFile(host, relative)
      if (file === null) return status(404)
      try {
        bytes = await readFile(file)
      } catch {
        return status(404)
      }
    } else {
      const hash = url.pathname.replace(/^\//, '')
      if (url.hostname !== 'cas' || !isContentHash(hash)) return status(404)
      try {
        bytes = await blobs.read(hash)
      } catch {
        return status(404)
      }
    }
    const mime = sniffImageMime(bytes)
    if (mime === null) return status(415)
    return new Response(new Uint8Array(bytes), {
      headers: {
        'content-type': mime,
        // Vault files can change under the same name; stored blobs never do.
        'cache-control': host === 'cas' ? 'max-age=31536000, immutable' : 'no-cache',
        'x-content-type-options': 'nosniff',
      },
    })
  })
}

/** Images copied into a vault live here: <vault>/_assets/<sha256>.<ext>. */
export const ASSETS_DIR = '_assets'
/** Front-matter key listing the vault-relative asset paths an entry uses. */
export const REFERENCES_KEY = 'references'

const EXTENSIONS: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
}

export function extensionForMime(mime: string): string | null {
  return EXTENSIONS[mime] ?? null
}

/** An asset file name: the content hash and the image type's extension. */
export function assetFileName(hash: string, mime: string): string | null {
  const extension = extensionForMime(mime)
  return extension === null ? null : `${hash}.${extension}`
}

/** A vault-relative asset path the app wrote: _assets/<64 hex>.<ext>. */
export const ASSET_PATH = /^_assets\/([0-9a-f]{64})\.(png|jpg|webp|gif|avif|bmp)$/

/**
 * Resolves a link in an entry (relative to the entry's folder, or vault-root
 * relative with a leading "/") to a vault-relative path; null when it is
 * remote or leaves the vault.
 */
export function resolveVaultLink(entryPath: string, href: string): string | null {
  const clean = href.trim().split(/[?#]/)[0] ?? ''
  if (clean === '' || /^[a-z][a-z0-9+.-]*:/i.test(clean) || clean.startsWith('//')) return null
  let decoded: string
  try {
    decoded = decodeURIComponent(clean)
  } catch {
    return null
  }
  if (decoded.includes('\\') || decoded.includes('\0')) return null
  const base = decoded.startsWith('/') ? [] : entryPath.split('/').slice(0, -1)
  const parts = [...base]
  for (const part of decoded.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (parts.length === 0) return null
      parts.pop()
    } else {
      parts.push(part)
    }
  }
  return parts.length === 0 ? null : parts.join('/')
}

/** The Markdown link an entry uses for a vault asset: relative, so other Markdown tools show it too. */
export function assetLinkFrom(entryPath: string, assetPath: string): string {
  const depth = entryPath.split('/').length - 1
  return `${'../'.repeat(depth)}${assetPath}`
}

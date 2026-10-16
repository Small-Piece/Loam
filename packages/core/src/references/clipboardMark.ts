/**
 * Loam's private clipboard marker: written next to the image when references are
 * copied, so a paste back into Loam can reuse them instead of importing the
 * re-encoded clipboard bitmap as a new reference. Each reference is named by id
 * and image hash, so a marker from another Loam data folder (or a reference whose
 * id now holds another image) never matches.
 */
export interface ClipboardMark {
  refs: Array<{ id: number; imageHash: string }>
  /** Image hash of the reference other apps received, or null when none could be shared. */
  shared: string | null
}

const MARK_VERSION = 1
const HASH = /^[0-9a-f]{64}$/

export function encodeClipboardMark(mark: ClipboardMark): string {
  return JSON.stringify({ loam: MARK_VERSION, refs: mark.refs, shared: mark.shared })
}

function isRef(value: unknown): value is { id: number; imageHash: string } {
  if (typeof value !== 'object' || value === null) return false
  const { id, imageHash } = value as { id?: unknown; imageHash?: unknown }
  return (
    typeof id === 'number' &&
    Number.isInteger(id) &&
    id > 0 &&
    typeof imageHash === 'string' &&
    HASH.test(imageHash)
  )
}

/** The marker in this clipboard text, or null when it is missing, malformed or another version. */
export function parseClipboardMark(text: string | null): ClipboardMark | null {
  if (text === null) return null
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof data !== 'object' || data === null) return null
  const { loam, refs, shared } = data as { loam?: unknown; refs?: unknown; shared?: unknown }
  if (loam !== MARK_VERSION || !Array.isArray(refs) || refs.length === 0) return null
  if (!refs.every(isRef)) return null
  if (shared !== null && (typeof shared !== 'string' || !HASH.test(shared))) return null
  return { refs: refs.map(({ id, imageHash }) => ({ id, imageHash })), shared }
}

/** IPC channel used by the preload bridge. Only this one channel crosses into the main process. */
export const INVOKE_CHANNEL = 'protocol:invoke'

/** IPC channel for events the main process pushes to the UI (see events.ts). */
export const EVENT_CHANNEL = 'protocol:event'

/** What the preload script exposes to the UI as window.loam. */
export interface BridgeApi {
  invoke(channel: string, payload: unknown): Promise<unknown>
  /** Listens for pushed events; returns a function that stops listening. */
  subscribe(listener: (name: string, payload: unknown) => void): () => void
}

/**
 * Read-only URL scheme for stored images. The desktop host serves
 * ASSET_SCHEME://cas/<sha256> from the content-addressed file store.
 */
export const ASSET_SCHEME = 'loam-asset'

export function assetUrl(hash: string): string {
  return `${ASSET_SCHEME}://cas/${hash}`
}

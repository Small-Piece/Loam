import type { BridgeApi } from '@loam/protocol'

declare global {
  interface Window {
    /** Exposed by the desktop preload script; the UI's only door to the backend. */
    loam: BridgeApi
  }
}

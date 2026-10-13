import type { BridgeApi } from '../../packages/protocol/src/bridge.ts'

declare global {
  interface Window {
    loam: BridgeApi
  }
}

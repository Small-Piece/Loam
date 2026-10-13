import { contextBridge, ipcRenderer } from 'electron'
import { EVENT_CHANNEL, INVOKE_CHANNEL, type BridgeApi } from '@loam/protocol/bridge'

// Sandboxed preload: forwards raw messages only. Validation happens in the
// UI client before sending and in the main process on arrival.
const api: BridgeApi = {
  invoke: (channel, payload) => ipcRenderer.invoke(INVOKE_CHANNEL, channel, payload),
  subscribe: (listener) => {
    const forward = (_event: Electron.IpcRendererEvent, name: unknown, payload: unknown) => {
      if (typeof name === 'string') listener(name, payload)
    }
    ipcRenderer.on(EVENT_CHANNEL, forward)
    return () => {
      ipcRenderer.removeListener(EVENT_CHANNEL, forward)
    }
  },
}

contextBridge.exposeInMainWorld('loam', api)

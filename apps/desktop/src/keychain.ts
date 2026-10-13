import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** The subset of Electron's safeStorage the keychain needs (DPAPI on Windows). */
export interface Encryptor {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
}

/** Persists ciphertext only. Values are base64 of OS-encrypted bytes. */
export interface CipherStore {
  load(): Record<string, string>
  save(entries: Record<string, string>): void
}

export interface Keychain {
  set(name: string, secret: string): void
  get(name: string): string | null
  delete(name: string): boolean
}

/**
 * Stores secrets such as API keys encrypted by the OS (Electron safeStorage).
 * Plaintext never reaches the store, SQLite, logs or config files.
 */
export function createKeychain(encryptor: Encryptor, store: CipherStore): Keychain {
  function requireEncryption(): void {
    if (!encryptor.isEncryptionAvailable()) {
      throw new Error('OS encryption is unavailable; refusing to handle secrets')
    }
  }

  return {
    set(name, secret) {
      requireEncryption()
      const entries = store.load()
      entries[name] = encryptor.encryptString(secret).toString('base64')
      store.save(entries)
    },
    get(name) {
      requireEncryption()
      const encoded = store.load()[name]
      if (encoded === undefined) return null
      return encryptor.decryptString(Buffer.from(encoded, 'base64'))
    },
    delete(name) {
      const entries = store.load()
      if (!Object.hasOwn(entries, name)) return false
      delete entries[name]
      store.save(entries)
      return true
    },
  }
}

/** A CipherStore backed by one JSON file, replaced atomically on save. */
export function fileCipherStore(filePath: string): CipherStore {
  return {
    load() {
      if (!existsSync(filePath)) return {}
      return JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, string>
    },
    save(entries) {
      mkdirSync(dirname(filePath), { recursive: true })
      const temp = `${filePath}.tmp`
      writeFileSync(temp, JSON.stringify(entries), { mode: 0o600 })
      renameSync(temp, filePath)
    },
  }
}

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createKeychain, fileCipherStore, type Encryptor } from './keychain.ts'

// Stand-in for safeStorage: reversible, and visibly different from plaintext.
const fakeEncryptor: Encryptor = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(Buffer.from(plain, 'utf8').map((b) => b ^ 0x5a)),
  decryptString: (data) => Buffer.from(data.map((b) => b ^ 0x5a)).toString('utf8'),
}

const FAKE_SECRET = 'not-a-real-key-0000'

describe('keychain', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function tempStorePath(): string {
    const dir = mkdtempSync(join(tmpdir(), 'loam-keychain-'))
    dirs.push(dir)
    return join(dir, 'keychain.json')
  }

  it('stores, reads and deletes a secret without writing plaintext', () => {
    const path = tempStorePath()
    const keychain = createKeychain(fakeEncryptor, fileCipherStore(path))

    keychain.set('test-provider', FAKE_SECRET)
    expect(readFileSync(path, 'utf8')).not.toContain(FAKE_SECRET)
    expect(keychain.get('test-provider')).toBe(FAKE_SECRET)

    expect(keychain.delete('test-provider')).toBe(true)
    expect(keychain.get('test-provider')).toBeNull()
    expect(keychain.delete('test-provider')).toBe(false)
  })

  it('persists across instances', () => {
    const path = tempStorePath()
    createKeychain(fakeEncryptor, fileCipherStore(path)).set('a', FAKE_SECRET)
    expect(createKeychain(fakeEncryptor, fileCipherStore(path)).get('a')).toBe(FAKE_SECRET)
  })

  it('refuses to handle secrets when OS encryption is unavailable', () => {
    const unavailable: Encryptor = { ...fakeEncryptor, isEncryptionAvailable: () => false }
    const keychain = createKeychain(unavailable, fileCipherStore(tempStorePath()))
    expect(() => keychain.set('a', FAKE_SECRET)).toThrow(/unavailable/)
    expect(() => keychain.get('a')).toThrow(/unavailable/)
  })
})

import { describe, expect, it } from 'vitest'
import {
  ReferenceService,
  type BibleService,
  type ReferenceRepository,
  type SuggestionService,
} from '@loam/core'
import type { AiController } from './ai/controller.ts'
import { createHandlers } from './handlers.ts'
import { browserDataDir, databasePath, filesDir } from './paths.ts'

// The ping test needs no storage; any repository call would be a bug.
const unusedRepository = new Proxy({} as ReferenceRepository, {
  get: () => () => {
    throw new Error('repository should not be used')
  },
})

describe('desktop handlers', () => {
  const clock = { now: () => new Date('2026-10-12T01:02:03.000Z') }
  const references = new ReferenceService({
    repository: unusedRepository,
    blobs: { put: () => Promise.resolve(), delete: () => Promise.resolve(false) },
    hasher: { sha256: () => '' },
    clock,
  })
  const unused = <T extends object>(name: string) =>
    new Proxy({} as T, {
      get: () => () => {
        throw new Error(`${name} should not be used`)
      },
    })
  const rest = {
    suggestions: unused<SuggestionService>('suggestions'),
    ai: unused<AiController>('ai'),
    about: () => ({
      name: 'Loam',
      version: '0.1.0',
      license: 'MIT',
      repositoryUrl: 'https://github.com/Small-Piece/loam',
      websiteUrl: 'https://small-piece.github.io/loam/',
      dataFolder: 'C:\\Users\\x\\AppData\\Local\\Loam',
      migration: null,
    }),
    notices: () => '# Third-party notices',
    copySample: () => {
      throw new Error('copySample should not be used')
    },
  }

  it('replies to app:ping with the echoed message and the clock time', async () => {
    const handlers = createHandlers({
      clock,
      references,
      bible: unused<BibleService>('bible'),
      journal: unused<BibleService>('journal'),
      suggestedJournalFolder: 'unused',
      pickFolder: async () => null,
      openExternal: async () => false,
      ...rest,
    })
    expect(await handlers['app:ping']({ message: 'hello' })).toEqual({
      reply: 'pong: hello',
      receivedAt: '2026-10-12T01:02:03.000Z',
    })
  })

  it('answers app:about from the host', async () => {
    const handlers = createHandlers({
      clock,
      references,
      bible: unused<BibleService>('bible'),
      journal: unused<BibleService>('journal'),
      suggestedJournalFolder: 'unused',
      pickFolder: async () => null,
      openExternal: async () => false,
      ...rest,
    })
    expect(await handlers['app:about']({})).toMatchObject({ name: 'Loam', migration: null })
    expect(await handlers['app:notices']({})).toEqual({ text: '# Third-party notices' })
  })

  it('sends a vault message to the service that has that vault open', async () => {
    // Only the methods this message uses; the rest is never called.
    const fake = (name: string, open: number) =>
      ({
        owns: (vaultId: number) => vaultId === open,
        view: (vaultId: number) => ({ name, vaultId }),
      }) as unknown as BibleService
    const handlers = createHandlers({
      clock,
      references,
      bible: fake('bible', 1),
      journal: fake('journal', 7),
      suggestedJournalFolder: 'unused',
      pickFolder: async () => null,
      openExternal: async () => false,
      ...rest,
    })
    expect(await handlers['bible:view']({ vaultId: 7 })).toEqual({ name: 'journal', vaultId: 7 })
    expect(await handlers['bible:view']({ vaultId: 1 })).toEqual({ name: 'bible', vaultId: 1 })
  })
})

describe('paths', () => {
  it('places the database under %LOCALAPPDATA%/Loam', () => {
    expect(databasePath({ LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' })).toMatch(
      /AppData[\\/]Local[\\/]Loam[\\/]loam\.db$/,
    )
  })

  it('places the file store next to the database', () => {
    expect(filesDir({ LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' })).toMatch(
      /AppData[\\/]Local[\\/]Loam[\\/]files$/,
    )
  })

  it('keeps the Chromium profile next to the database', () => {
    expect(browserDataDir({ LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' })).toMatch(
      /AppData[\\/]Local[\\/]Loam[\\/]browser$/,
    )
  })

  it('fails loudly when LOCALAPPDATA is missing', () => {
    expect(() => databasePath({})).toThrow(/LOCALAPPDATA/)
  })
})

import { describe, expect, it } from 'vitest'
import {
  ReferenceService,
  type BibleService,
  type ReferenceRepository,
  type SuggestionService,
} from '@loam/core'
import type { AiController } from './ai/controller.ts'
import type { ClipboardPort } from './clipboardPort.ts'
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
      version: '0.1.2',
      license: 'MIT',
      repositoryUrl: 'https://github.com/Small-Piece/Loam',
      websiteUrl: 'https://small-piece.github.io/Loam/',
      dataFolder: 'C:\\Users\\x\\AppData\\Local\\Loam',
      migration: null,
    }),
    notices: () => '# Third-party notices',
    copySample: () => {
      throw new Error('copySample should not be used')
    },
    clipboard: unused<ClipboardPort>('clipboard'),
    readBlob: () => Promise.reject(new Error('readBlob should not be used')),
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

describe('copy and paste handlers', () => {
  const clock = { now: () => new Date('2026-10-16T00:00:00.000Z') }
  const unused = <T extends object>(name: string) =>
    new Proxy({} as T, {
      get: () => () => {
        throw new Error(`${name} should not be used`)
      },
    })

  /** A clipboard that records writes and returns a chosen marker. */
  function fakeClipboard(onClipboard: { mark: string | null; hasImage: boolean }) {
    const writes: Array<{ image: { bytes: Uint8Array; mime: string } | null; mark: string }> = []
    const port: ClipboardPort = {
      writeCopy: async (image, mark) => {
        writes.push({ image, mark })
      },
      readMark: async () => onClipboard,
    }
    return { port, writes }
  }

  function handlersWith(references: ReferenceService, clipboard: ClipboardPort) {
    return createHandlers({
      clock,
      references,
      bible: unused<BibleService>('bible'),
      journal: unused<BibleService>('journal'),
      suggestedJournalFolder: 'unused',
      about: unused<() => never>('about'),
      notices: () => '',
      pickFolder: async () => null,
      copySample: () => '',
      openExternal: async () => false,
      suggestions: unused<SuggestionService>('suggestions'),
      ai: unused<AiController>('ai'),
      clipboard,
      readBlob: async (hash) => new TextEncoder().encode(`bytes of ${hash}`),
    })
  }

  it('writes the shared image and the marker in one write; nothing when nothing is copied', async () => {
    const { port, writes } = fakeClipboard({ mark: null, hasImage: false })
    const plans = [
      { ids: [4, 2], shared: { id: 4, imageHash: 'h4', imageMime: 'image/png' }, mark: 'M' },
      { ids: [], shared: null, mark: 'empty' },
    ]
    const references = {
      prepareCopy: (ids: number[], shareable: (mime: string) => boolean) => {
        expect(ids).toEqual([4, 2])
        expect([shareable('image/png'), shareable('image/jpeg'), shareable('image/gif')]).toEqual([
          true,
          true,
          false,
        ])
        return plans.shift()
      },
    } as unknown as ReferenceService
    const handlers = handlersWith(references, port)
    expect(await handlers['refs:copyImages']({ ids: [4, 2] })).toEqual({ ids: [4, 2], sharedId: 4 })
    expect(writes).toHaveLength(1)
    expect(writes[0]?.mark).toBe('M')
    expect(writes[0]?.image?.mime).toBe('image/png')
    expect(new TextDecoder().decode(writes[0]?.image?.bytes)).toBe('bytes of h4')
    expect(await handlers['refs:copyImages']({ ids: [4, 2] })).toEqual({ ids: [], sharedId: null })
    expect(writes).toHaveLength(1)
  })

  it('a paste hands what is on the clipboard to the service', async () => {
    const { port } = fakeClipboard({ mark: 'M', hasImage: true })
    const references = {
      pasteCopied: (mark: string | null, hasImage: boolean, boardId: number | null) => ({
        ids: mark === 'M' && hasImage && boardId === 3 ? [9] : [],
        itemIds: [],
      }),
    } as unknown as ReferenceService
    const handlers = handlersWith(references, port)
    expect(await handlers['refs:pasteCopied']({ boardId: 3, at: null })).toEqual({
      ids: [9],
      itemIds: [],
    })
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

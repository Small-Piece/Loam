import { describe, expect, it } from 'vitest'
import {
  checkEvent,
  createClient,
  dispatch,
  messages,
  type BridgeApi,
  type Handlers,
} from './index.ts'

/** Fills every channel not under test with a handler that fails the test if called. */
function withHandlers(overrides: Partial<Handlers>): Handlers {
  const stubs = Object.fromEntries(
    Object.keys(messages).map((channel) => [
      channel,
      () => {
        throw new Error(`unexpected call to ${channel}`)
      },
    ]),
  ) as unknown as Handlers
  return { ...stubs, ...overrides }
}

const handlers = withHandlers({
  'app:ping': (request) => ({
    reply: `pong: ${request.message}`,
    receivedAt: '2026-10-12T00:00:00.000Z',
  }),
})

/** A bridge that calls the server directly, standing in for preload + IPC. */
const loopback: BridgeApi = {
  invoke: (channel, payload) => dispatch(handlers, channel, payload),
  subscribe: () => () => undefined,
}

describe('protocol server', () => {
  it('answers a valid app:ping', async () => {
    const result = await dispatch(handlers, 'app:ping', { message: 'hi' })
    expect(result).toEqual({
      ok: true,
      data: { reply: 'pong: hi', receivedAt: '2026-10-12T00:00:00.000Z' },
    })
  })

  it('rejects a malformed payload with INVALID_REQUEST', async () => {
    const result = await dispatch(handlers, 'app:ping', { msg: 42 })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('INVALID_REQUEST')
    expect(result.error.issues?.length).toBeGreaterThan(0)
  })

  it('rejects an unknown channel with UNKNOWN_CHANNEL', async () => {
    const result = await dispatch(handlers, 'app:delete-everything', {})
    expect(result).toMatchObject({ ok: false, error: { code: 'UNKNOWN_CHANNEL' } })
  })

  it('does not treat inherited object keys as channels', async () => {
    const result = await dispatch(handlers, 'toString', {})
    expect(result).toMatchObject({ ok: false, error: { code: 'UNKNOWN_CHANNEL' } })
  })

  it('rejects a handler response that breaks the schema with INVALID_RESPONSE', async () => {
    const broken = withHandlers({ 'app:ping': () => ({ reply: 1 }) as unknown as never })
    const result = await dispatch(broken, 'app:ping', { message: 'hi' })
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_RESPONSE' } })
  })

  it('reports a throwing handler as HANDLER_FAILED', async () => {
    const throwing = withHandlers({
      'app:ping': () => {
        throw new Error('boom')
      },
    })
    const result = await dispatch(throwing, 'app:ping', { message: 'hi' })
    expect(result).toMatchObject({ ok: false, error: { code: 'HANDLER_FAILED' } })
  })
})

describe('protocol client', () => {
  it('round-trips app:ping', async () => {
    const result = await createClient(loopback).invoke('app:ping', { message: 'hi' })
    expect(result).toEqual({
      ok: true,
      data: { reply: 'pong: hi', receivedAt: '2026-10-12T00:00:00.000Z' },
    })
  })

  it('rejects an invalid request before sending it', async () => {
    let sent = false
    const spy: BridgeApi = {
      invoke: (channel, payload) => {
        sent = true
        return loopback.invoke(channel, payload)
      },
      subscribe: loopback.subscribe,
    }
    const result = await createClient(spy).invoke('app:ping', { message: '' })
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } })
    expect(sent).toBe(false)
  })

  it('rejects a reply that is not a protocol envelope', async () => {
    const garbage: BridgeApi = {
      invoke: () => Promise.resolve('not an envelope'),
      subscribe: loopback.subscribe,
    }
    const result = await createClient(garbage).invoke('app:ping', { message: 'hi' })
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_RESPONSE' } })
  })
})

describe('reference messages', () => {
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const upload = {
    fileName: 'a.png',
    bytes: png,
    width: 10,
    height: 10,
    thumbnail: { bytes: png, width: 10, height: 10 },
  }
  const importer = withHandlers({
    'refs:import': (request) => ({
      results: request.items.map((item, index) => ({
        fileName: item.fileName,
        status: 'created' as const,
        id: index + 1,
      })),
    }),
  })

  it('accepts image bytes as Uint8Array', async () => {
    const result = await dispatch(importer, 'refs:import', {
      items: [upload],
      boardId: null,
      at: null,
    })
    expect(result).toEqual({
      ok: true,
      data: { results: [{ fileName: 'a.png', status: 'created', id: 1 }] },
    })
  })

  it('rejects bytes sent as anything other than Uint8Array', async () => {
    const asText = { ...upload, bytes: 'iVBORw0KGgo=' }
    const result = await dispatch(importer, 'refs:import', {
      items: [asText],
      boardId: null,
      at: null,
    })
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } })
  })

  it('rejects an empty import and unknown fields', async () => {
    expect(
      await dispatch(importer, 'refs:import', { items: [], boardId: null, at: null }),
    ).toMatchObject({
      ok: false,
      error: { code: 'INVALID_REQUEST' },
    })
    expect(
      await dispatch(importer, 'refs:import', {
        items: [upload],
        boardId: null,
        at: null,
        path: 'C:/x',
      }),
    ).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } })
  })

  it('rejects an update with a negative or fractional id', async () => {
    const updater = withHandlers({ 'refs:update': () => ({ detail: null }) })
    for (const id of [-1, 1.5, 0]) {
      expect(await dispatch(updater, 'refs:update', { id, note: 'x' })).toMatchObject({
        ok: false,
        error: { code: 'INVALID_REQUEST' },
      })
    }
  })
})

describe('protocol events', () => {
  it('delivers valid events of the subscribed name and drops the rest', () => {
    let push: (name: string, payload: unknown) => void = () => undefined
    let stopped = false
    const bridge: BridgeApi = {
      invoke: () => Promise.resolve(null),
      subscribe: (listener) => {
        push = listener
        return () => {
          stopped = true
        }
      },
    }
    const seen: unknown[] = []
    const stop = createClient(bridge).on('bible:changed', (payload) => seen.push(payload))
    push('bible:changed', { vaultId: 1, paths: ['world/a.md'] })
    push('bible:changed', { vaultId: 'one', paths: [] })
    push('other:event', { vaultId: 1, paths: [] })
    expect(seen).toEqual([{ vaultId: 1, paths: ['world/a.md'] }])
    stop()
    expect(stopped).toBe(true)
    expect(checkEvent('bible:changed', { vaultId: 0, paths: [] })).toBeNull()
  })
})

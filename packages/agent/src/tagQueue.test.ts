import { afterEach, describe, expect, it } from 'vitest'
import { FakeAgentProvider } from './fake.ts'
import { TagQueue, type QueueStatus, type SuggestionStore } from './tagQueue.ts'
import type { AgentProvider, TagSuggestion } from './provider.ts'

interface Ref {
  refId: number
  imageHash: string
  imageMime: string
  tags: string[]
}

function memoryStore(refs: Ref[], rejected: Record<number, string[]> = {}) {
  const saved = new Map<number, { suggestions: TagSuggestion[]; outcome: string }>()
  const store: SuggestionStore = {
    next: () =>
      [...refs].sort((a, b) => b.refId - a.refId).find((ref) => !saved.has(ref.refId)) ?? null,
    counts: () => ({ done: saved.size, total: refs.length }),
    skipTags: (refId) => [
      ...(refs.find((ref) => ref.refId === refId)?.tags ?? []),
      ...(rejected[refId] ?? []),
    ],
    knownTags: () => ['Landscape', 'warm color'],
    save: (refId, suggestions, outcome) => {
      saved.set(refId, { suggestions: [...suggestions], outcome })
    },
  }
  return { store, saved }
}

const png = (marker: number) => ({
  refId: marker,
  imageHash: `h${marker}`,
  imageMime: 'image/png',
  tags: [] as string[],
})
const until = async (check: () => boolean, ms = 3000) => {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

let queue: TagQueue | null = null
afterEach(async () => {
  await queue?.dispose()
  queue = null
})

function makeQueue(
  store: SuggestionStore,
  provider: AgentProvider,
  apps: () => string[] = () => [],
  lines: string[] = [],
) {
  let made = 0
  const statuses: QueueStatus[] = []
  queue = new TagQueue({
    store,
    readImage: async (hash) => Uint8Array.from(hash, (char) => char.charCodeAt(0)),
    provider: () => {
      made++
      return provider
    },
    runningApps: async () => apps(),
    log: (line) => lines.push(line),
    onChange: (status) => statuses.push(status),
    pollMs: 50,
    restMs: 0,
  })
  return { queue, statuses, made: () => made }
}

describe('tag suggestion queue', () => {
  it('never creates a provider while off', async () => {
    const { store } = memoryStore([png(1)])
    const { made, queue: q } = makeQueue(store, new FakeAgentProvider())
    q.setPauseApps(['UnrealEditor.exe'])
    q.wake()
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(made()).toBe(0)
    expect(q.status().state).toBe('off')
  })

  it('suggests newest first, prefers known tags, skips tags the image has, then goes idle', async () => {
    const refs = [png(1), png(2), { ...png(3), imageMime: 'image/webp' }]
    refs[1]!.tags = ['ruins']
    const { store, saved } = memoryStore(refs, { 2: ['stone'] })
    const lines: string[] = []
    const { queue: q } = makeQueue(store, new FakeAgentProvider(), () => [], lines)
    q.setEnabled(true)
    await until(() => saved.size === 3)
    expect([...saved.keys()]).toEqual([3, 2, 1])
    expect(saved.get(3)?.outcome).toBe('unsupported')
    const second = saved.get(2)?.suggestions.map((item) => item.tag) ?? []
    expect(second).not.toContain('ruins')
    expect(second).not.toContain('stone')
    const all = [...saved.values()].flatMap((entry) => entry.suggestions.map((item) => item.tag))
    // "Warm colours" and "landscape" become the existing tags.
    expect(
      all
        .filter((tag) => /warm|landscape/i.test(tag))
        .every((tag) => ['Landscape', 'warm color'].includes(tag)),
    ).toBe(true)
    await until(() => q.status().state === 'idle')
    expect(q.status()).toMatchObject({ done: 3, total: 3 })
    expect(lines).toContain('[ai] queue started')
    expect(lines.join('\n')).not.toMatch(/landscape|ruins|stone|warm/i)
  })

  it('a manual pause stops the image in progress within 2 seconds and saves nothing', async () => {
    const { store, saved } = memoryStore([png(1), png(2)])
    const provider = new FakeAgentProvider(10_000)
    const { queue: q } = makeQueue(store, provider)
    q.setEnabled(true)
    await until(() => provider.status().state === 'busy')
    const start = Date.now()
    q.setPaused(true)
    await until(() => provider.status().state !== 'busy')
    expect(Date.now() - start).toBeLessThan(2000)
    expect(saved.size).toBe(0)
    expect(q.status().state).toBe('paused')
  })

  it('pauses while a listed app runs, frees the model, and resumes after it closes', async () => {
    let apps: string[] = []
    const refs = [png(1), png(2), png(3)]
    const { store, saved } = memoryStore(refs)
    const provider = new FakeAgentProvider(200)
    const { queue: q } = makeQueue(store, provider, () => apps)
    q.setPauseApps(['UnrealEditor.exe'])
    q.setEnabled(true)
    await until(() => provider.status().state === 'busy')
    apps = ['explorer.exe', 'unrealeditor.exe']
    await until(() => q.status().state === 'blocked')
    expect(q.status().blockedBy).toBe('UnrealEditor.exe')
    await until(() => provider.status().state === 'idle')
    const doneWhileBlocked = saved.size
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(saved.size).toBe(doneWhileBlocked)
    apps = ['explorer.exe']
    await until(() => saved.size === 3)
    expect(q.status().state).toBe('idle')
    // Loaded again after the pause.
    expect(provider.loads).toBeGreaterThanOrEqual(2)
  })

  it('stops with an error after repeated failures', async () => {
    const failing: AgentProvider = {
      tagImage: async () => {
        throw new Error('model crashed')
      },
      summarize: async () => '',
      status: () => ({ state: 'error', detail: null }),
      cancel: async () => undefined,
    }
    const { store, saved } = memoryStore([png(1), png(2), png(3), png(4)])
    const { queue: q } = makeQueue(store, failing)
    q.setEnabled(true)
    await until(() => q.status().state === 'error')
    expect(saved.size).toBe(3)
    expect([...saved.values()].every((entry) => entry.outcome === 'failed')).toBe(true)
  })
})

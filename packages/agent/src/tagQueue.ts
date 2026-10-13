import {
  CancelledError,
  UnsupportedImageError,
  type AgentProvider,
  type TagSuggestion,
} from './provider.ts'
import { preferKnownTags } from './tags.ts'

/** What the queue needs from the Library. */
export interface SuggestionStore {
  /** The newest reference not looked at yet, or null. */
  next(): { refId: number; imageHash: string; imageMime: string } | null
  counts(): { done: number; total: number }
  /** Tags that reference has, plus the suggestions the user rejected for it. */
  skipTags(refId: number): string[]
  /** Tags in use in the Library and the open vaults, preferred when they mean the same. */
  knownTags(): string[]
  save(
    refId: number,
    suggestions: readonly TagSuggestion[],
    outcome: 'suggested' | 'unsupported' | 'failed',
  ): void
}

export type QueueState = 'off' | 'running' | 'idle' | 'paused' | 'blocked' | 'error'

export interface QueueStatus {
  state: QueueState
  done: number
  total: number
  /** The running app that paused the queue, as listed by the user. */
  blockedBy: string | null
  /** A short reason for "error"; never image contents or tags. */
  error: string | null
}

export interface TagQueueDeps {
  store: SuggestionStore
  readImage: (hash: string) => Promise<Uint8Array>
  /** Created on first use only, so a queue that never runs never loads a model. */
  provider: () => AgentProvider
  /** Names of running executables (any case). */
  runningApps: () => Promise<string[]>
  /** One line per event; never image contents, tags or user text. */
  log: (line: string) => void
  onChange: (status: QueueStatus) => void
  /** How often to look for listed apps; the queue pauses within one poll plus cancel time. */
  pollMs?: number
  /** A pause between images, so the queue stays in the background. */
  restMs?: number
}

const MAX_FAILURES_IN_A_ROW = 3

/**
 * Suggests tags for Library images without suggestions yet, newest first,
 * one at a time. It stops for a manual pause and while a listed app runs
 * (cancelling the current image and freeing the model), and goes idle when
 * every image has been looked at, until wake() says there is more.
 */
export class TagQueue {
  private enabled = false
  private paused = false
  /** As the user wrote them, with a lower-case key to compare. */
  private pauseApps: Array<{ name: string; key: string }> = []
  private blockedBy: string | null = null
  private error: string | null = null
  private running = false
  private current: AbortController | null = null
  private poll: ReturnType<typeof setInterval> | null = null
  private wakeUp: (() => void) | null = null
  private failures = 0
  private readonly pollMs: number
  private readonly restMs: number

  private readonly deps: TagQueueDeps

  constructor(deps: TagQueueDeps) {
    this.deps = deps
    this.pollMs = deps.pollMs ?? 2000
    this.restMs = deps.restMs ?? 300
  }

  status(): QueueStatus {
    const { done, total } = this.enabled ? this.deps.store.counts() : { done: 0, total: 0 }
    let state: QueueState
    if (!this.enabled) state = 'off'
    else if (this.error !== null) state = 'error'
    else if (this.paused) state = 'paused'
    else if (this.blockedBy !== null) state = 'blocked'
    else if (done >= total) state = 'idle'
    else state = 'running'
    return { state, done, total, blockedBy: this.blockedBy, error: this.error }
  }

  private changed(): void {
    this.deps.onChange(this.status())
  }

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return
    this.enabled = enabled
    this.error = null
    this.failures = 0
    if (enabled) {
      this.deps.log('[ai] queue started')
      this.poll = setInterval(() => void this.checkApps(), this.pollMs)
      void this.checkApps().then(() => this.loop())
    } else {
      this.deps.log('[ai] queue stopped')
      if (this.poll) clearInterval(this.poll)
      this.poll = null
      this.blockedBy = null
      void this.interrupt()
    }
    this.changed()
  }

  setPaused(paused: boolean): void {
    if (paused === this.paused) return
    this.paused = paused
    this.deps.log(paused ? '[ai] queue paused by the user' : '[ai] queue resumed by the user')
    if (paused) void this.interrupt()
    else this.kick()
    this.changed()
  }

  setPauseApps(apps: readonly string[]): void {
    this.pauseApps = apps
      .map((app) => app.trim())
      .filter((app) => app !== '')
      .map((name) => ({ name, key: name.toLowerCase() }))
    void this.checkApps()
  }

  /** New images arrived (an import): look again. */
  wake(): void {
    this.kick()
    this.changed()
  }

  /** Stops for good (app quit). */
  async dispose(): Promise<void> {
    this.enabled = false
    if (this.poll) clearInterval(this.poll)
    await this.interrupt()
  }

  private kick(): void {
    this.wakeUp?.()
    void this.loop()
  }

  /** Cancels the image in progress and frees the model. */
  private async interrupt(): Promise<void> {
    this.current?.abort()
    this.wakeUp?.()
    if (this.providerMade) await this.deps.provider().cancel()
  }

  private providerMade = false

  private provider(): AgentProvider {
    this.providerMade = true
    return this.deps.provider()
  }

  private async checkApps(): Promise<void> {
    if (!this.enabled || this.pauseApps.length === 0) {
      if (this.blockedBy !== null) {
        this.blockedBy = null
        this.changed()
        this.kick()
      }
      return
    }
    let running: string[]
    try {
      running = (await this.deps.runningApps()).map((app) => app.toLowerCase())
    } catch {
      return
    }
    const listed = this.pauseApps.find((app) => running.includes(app.key))?.name ?? null
    if (listed === this.blockedBy) return
    this.blockedBy = listed
    if (listed !== null) {
      this.deps.log('[ai] queue paused while a listed app runs')
      await this.interrupt()
    } else {
      this.deps.log('[ai] queue resumed: no listed app runs')
      this.kick()
    }
    this.changed()
  }

  private canWork(): boolean {
    return this.enabled && !this.paused && this.blockedBy === null && this.error === null
  }

  private async loop(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      while (this.canWork()) {
        const item = this.deps.store.next()
        if (!item) {
          // Every image has been looked at: wait for wake().
          await new Promise<void>((resolve) => {
            this.wakeUp = resolve
          })
          this.wakeUp = null
          continue
        }
        await this.suggest(item)
        this.changed()
        if (this.canWork() && this.restMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, this.restMs))
        }
      }
    } finally {
      this.running = false
    }
  }

  private async suggest(item: { refId: number; imageHash: string; imageMime: string }) {
    const { store } = this.deps
    const controller = new AbortController()
    this.current = controller
    try {
      const bytes = await this.deps.readImage(item.imageHash)
      const raw = await this.provider().tagImage(
        { bytes, mime: item.imageMime },
        { knownTags: store.knownTags(), signal: controller.signal },
      )
      if (controller.signal.aborted) return
      store.save(
        item.refId,
        preferKnownTags(raw, store.knownTags(), store.skipTags(item.refId)),
        'suggested',
      )
      this.failures = 0
    } catch (error) {
      if (error instanceof CancelledError || controller.signal.aborted) return
      if (error instanceof UnsupportedImageError) {
        store.save(item.refId, [], 'unsupported')
        return
      }
      this.failures++
      this.deps.log(`[ai] suggestion failed: ${error instanceof Error ? error.name : 'error'}`)
      store.save(item.refId, [], 'failed')
      if (this.failures >= MAX_FAILURES_IN_A_ROW) {
        this.error = 'The local model failed several times in a row'
        this.deps.log('[ai] queue stopped after repeated failures')
        await this.interrupt()
      }
    } finally {
      if (this.current === controller) this.current = null
    }
  }
}

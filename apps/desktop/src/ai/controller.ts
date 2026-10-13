import { LlamaServerProvider, TagQueue, totalBytes, type AgentProvider } from '@loam/agent'
import type { AiStatusData } from '@loam/protocol'
import type { SqliteSuggestionStore } from '@loam/storage'
import type { ModelManager } from './models.ts'

export const DEFAULT_PAUSE_APPS = ['UnrealEditor.exe']

/** A request the AI cannot serve right now (off, no model, paused). */
export class AiUnavailableError extends Error {
  override name = 'AiUnavailableError'
}

export interface AiControllerDeps {
  settings: { get<T>(key: string, fallback: T): T; set(key: string, value: unknown): void }
  models: ModelManager
  store: SqliteSuggestionStore
  /** Tags in use in the Library and the open bible and journal. */
  knownTags: () => string[]
  readImage: (hash: string) => Promise<Uint8Array>
  runningApps: () => Promise<string[]>
  /** The main log; lines never hold image contents, tags or journal text. */
  log: (line: string) => void
  emit: (status: AiStatusData) => void
  clock: { now(): Date }
  /** Tests: use this provider instead of the local model; the model then counts as installed. */
  fakeProvider?: AgentProvider | null
}

/**
 * The local AI helpers in the main process: the master switch (off by
 * default), the model download, the tag suggestion queue and recaps. While
 * off, nothing here touches the network or loads a model.
 */
export class AiController {
  private readonly deps: AiControllerDeps
  private readonly queue: TagQueue
  private provider: AgentProvider | null = null
  private recap: AbortController | null = null

  constructor(deps: AiControllerDeps) {
    this.deps = deps
    const { store, clock } = deps
    this.queue = new TagQueue({
      store: {
        next: () => store.next(),
        counts: () => store.counts(),
        skipTags: (refId) => store.skipTags(refId),
        knownTags: () => deps.knownTags(),
        save: (refId, suggestions, outcome) =>
          store.save(refId, suggestions, outcome, clock.now().toISOString()),
      },
      readImage: deps.readImage,
      provider: () => this.getProvider(),
      runningApps: deps.runningApps,
      log: deps.log,
      onChange: () => this.changed(),
    })
    this.queue.setPauseApps(this.pauseApps())
    this.queue.setPaused(this.paused())
    this.applyQueue()
  }

  private enabled(): boolean {
    return this.deps.settings.get('ai.enabled', false)
  }

  private paused(): boolean {
    return this.deps.settings.get('ai.paused', false)
  }

  private pauseApps(): string[] {
    return this.deps.settings.get<string[]>('ai.pauseApps', DEFAULT_PAUSE_APPS)
  }

  private installed(): boolean {
    return this.deps.fakeProvider ? true : this.deps.models.installed()
  }

  private getProvider(): AgentProvider {
    if (this.provider) return this.provider
    if (this.deps.fakeProvider) {
      this.provider = this.deps.fakeProvider
    } else {
      const { server, model, projector } = this.deps.models.paths()
      this.provider = new LlamaServerProvider({
        serverPath: server,
        modelPath: model,
        projectorPath: projector,
        log: this.deps.log,
      })
    }
    return this.provider
  }

  /** Frees the model (if one was ever made) and forgets it. */
  private async dropProvider(): Promise<void> {
    this.recap?.abort()
    const provider = this.provider
    this.provider = null
    await provider?.cancel()
  }

  private applyQueue(): void {
    const on = this.enabled() && this.installed()
    this.queue.setEnabled(on)
    if (!on) void this.dropProvider()
  }

  private changed(): void {
    this.deps.emit(this.status())
  }

  status(): AiStatusData {
    const { models } = this.deps
    const spec = models.model
    const queue = this.queue.status()
    return {
      enabled: this.enabled(),
      model: {
        name: spec.name,
        license: spec.license,
        runtimeLicense: spec.runtimeLicense,
        totalBytes: totalBytes(spec),
        installed: this.installed(),
        files: spec.files.map(({ name, url, size }) => ({ name, url, size })),
        download: models.downloadStatus(),
      },
      pauseApps: this.pauseApps(),
      paused: this.paused(),
      queue,
    }
  }

  setEnabled(enabled: boolean): AiStatusData {
    this.deps.settings.set('ai.enabled', enabled)
    this.deps.log(enabled ? '[ai] helpers turned on' : '[ai] helpers turned off')
    this.applyQueue()
    this.changed()
    return this.status()
  }

  setPauseApps(apps: readonly string[]): AiStatusData {
    const clean = [...new Set(apps.map((app) => app.trim()).filter((app) => app !== ''))]
    this.deps.settings.set('ai.pauseApps', clean)
    this.queue.setPauseApps(clean)
    this.changed()
    return this.status()
  }

  setPaused(paused: boolean): AiStatusData {
    this.deps.settings.set('ai.paused', paused)
    this.queue.setPaused(paused)
    if (paused) this.recap?.abort()
    this.changed()
    return this.status()
  }

  /** Starts or resumes the download; progress arrives as ai:status events. */
  download(): AiStatusData {
    if (!this.deps.models.installed()) {
      void this.deps.models
        .download(() => this.changed())
        .then(() => {
          this.applyQueue()
          this.changed()
        })
    }
    return this.status()
  }

  cancelDownload(): AiStatusData {
    this.deps.models.cancel()
    return this.status()
  }

  async deleteModel(): Promise<AiStatusData> {
    this.queue.setEnabled(false)
    await this.dropProvider()
    this.deps.models.remove()
    this.applyQueue()
    this.changed()
    return this.status()
  }

  /** New images in the Library. */
  wake(): void {
    if (this.enabled()) this.queue.wake()
  }

  /** A recap of the user's own notes, when AI is on, installed and not paused. */
  async summarize(texts: readonly string[], instructions: string): Promise<string> {
    const queue = this.queue.status()
    if (!this.enabled()) throw new AiUnavailableError('Turn on Local AI helpers in Settings first')
    if (!this.installed()) throw new AiUnavailableError('Download the model in Settings first')
    if (this.paused()) throw new AiUnavailableError('AI is paused')
    if (queue.blockedBy !== null) {
      throw new AiUnavailableError(`AI is paused while ${queue.blockedBy} runs`)
    }
    this.recap?.abort()
    const controller = new AbortController()
    this.recap = controller
    this.deps.log('[ai] recap started')
    try {
      const text = await this.getProvider().summarize(texts, instructions, {
        signal: controller.signal,
      })
      this.deps.log('[ai] recap finished')
      return text
    } catch (error) {
      this.deps.log(`[ai] recap failed: ${error instanceof Error ? error.name : 'error'}`)
      throw error
    } finally {
      if (this.recap === controller) this.recap = null
    }
  }

  async dispose(): Promise<void> {
    await this.queue.dispose()
    await this.dropProvider()
  }
}

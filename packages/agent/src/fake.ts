import {
  CancelledError,
  UnsupportedImageError,
  type AgentProvider,
  type ImageInput,
  type ProviderStatus,
  type TagSuggestion,
} from './provider.ts'

/** Formats a local vision model can read (WebP and AVIF are not among them). */
export const READABLE_IMAGES: readonly string[] = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/bmp',
]

const FAKE_TAGS = [
  'landscape',
  'Warm colours',
  'ruins',
  'sky',
  'stone',
  'anime style',
  'tower',
  'forest',
]

/** Waits, unless the signal fires first. */
function wait(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new CancelledError())
      return
    }
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(new CancelledError())
      },
      { once: true },
    )
  })
}

/**
 * A provider for tests and for running the app without a model: the same
 * image always gets the same tags; summaries quote the first line of each
 * text. It honours cancel() and abort signals at once.
 */
export class FakeAgentProvider implements AgentProvider {
  /** How many times work started from cold (stands in for model loads). */
  loads = 0
  calls = { tag: 0, summarize: 0 }
  private loaded = false
  private busy = 0
  private readonly cancelAll = new Set<AbortController>()

  private readonly delayMs: number

  constructor(delayMs = 0) {
    this.delayMs = delayMs
  }

  private async work<T>(signal: AbortSignal | undefined, run: () => T): Promise<T> {
    const own = new AbortController()
    this.cancelAll.add(own)
    const onAbort = () => own.abort()
    signal?.addEventListener('abort', onAbort, { once: true })
    this.busy++
    try {
      if (!this.loaded) {
        this.loaded = true
        this.loads++
      }
      await wait(this.delayMs, own.signal)
      return run()
    } finally {
      this.busy--
      this.cancelAll.delete(own)
      signal?.removeEventListener('abort', onAbort)
    }
  }

  tagImage(image: ImageInput, options: { signal?: AbortSignal } = {}): Promise<TagSuggestion[]> {
    this.calls.tag++
    if (!READABLE_IMAGES.includes(image.mime)) {
      return Promise.reject(new UnsupportedImageError(`Cannot read ${image.mime}`))
    }
    return this.work(options.signal, () => {
      let seed = image.bytes.length
      for (let index = 0; index < image.bytes.length; index += 997) seed += image.bytes[index] ?? 0
      return [0, 1, 2, 3].map((step) => ({
        tag: FAKE_TAGS[(seed + step * 3) % FAKE_TAGS.length] ?? 'image',
        confidence: 0.9 - step * 0.1,
      }))
    })
  }

  summarize(
    texts: readonly string[],
    instructions: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<string> {
    this.calls.summarize++
    return this.work(options.signal, () => {
      const lines = texts.map(
        (text) =>
          text.split('\n').find((line) => line.trim() !== '' && !line.startsWith('#')) ?? '',
      )
      return `Recap (${instructions.length > 0 ? 'draft' : 'notes'}):\n\n${lines
        .filter((line) => line !== '')
        .map((line) => `- ${line.trim()}`)
        .join('\n')}\n`
    })
  }

  status(): ProviderStatus {
    return { state: this.busy > 0 ? 'busy' : this.loaded ? 'ready' : 'idle', detail: null }
  }

  async cancel(): Promise<void> {
    for (const controller of this.cancelAll) controller.abort()
    this.loaded = false
  }
}

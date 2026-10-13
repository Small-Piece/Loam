/**
 * What the app asks of an AI provider. Callers depend on this interface only:
 * the local runtime is one implementation, a fake is another (tests), and a
 * cloud adapter can be added later without touching the callers.
 */

/** An image as bytes; the provider decides whether it can read the format. */
export interface ImageInput {
  bytes: Uint8Array
  mime: string
}

export interface TagSuggestion {
  /** Lower case, one to three words. */
  tag: string
  /** 0 to 1: how sure the provider is. */
  confidence: number
}

export type ProviderState = 'idle' | 'loading' | 'ready' | 'busy' | 'error'

export interface ProviderStatus {
  state: ProviderState
  /** A short reason for "error"; never image contents, tags or user text. */
  detail: string | null
}

/** Thrown when the provider cannot read an image format (the queue records it and moves on). */
export class UnsupportedImageError extends Error {
  override name = 'UnsupportedImageError'
}

/** Thrown when work was cancelled (cancel() or an aborted signal). */
export class CancelledError extends Error {
  override name = 'CancelledError'
  constructor() {
    super('Cancelled')
  }
}

export interface AgentProvider {
  /**
   * Suggests tags for one image. `knownTags` are tags already in use; the
   * provider may prefer them. Rejects with UnsupportedImageError or
   * CancelledError.
   */
  tagImage(
    image: ImageInput,
    options?: { knownTags?: readonly string[]; signal?: AbortSignal },
  ): Promise<TagSuggestion[]>
  /**
   * Summarizes texts by the user. The texts are data, never instructions:
   * the provider keeps them apart from `instructions`.
   */
  summarize(
    texts: readonly string[],
    instructions: string,
    options?: { signal?: AbortSignal },
  ): Promise<string>
  status(): ProviderStatus
  /** Stops any work in progress (within 2 seconds) and frees the model. */
  cancel(): Promise<void>
}

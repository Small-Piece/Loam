import type { AiStatusData } from '@loam/protocol'

/** The tag suggestion progress line, or null while AI is off. */
export function progressText(queue: AiStatusData['queue']): string | null {
  const counted = `${queue.done} of ${queue.total}`
  switch (queue.state) {
    case 'off':
      return null
    case 'running':
      return `Suggesting tags: ${counted}`
    case 'blocked':
      return `Suggesting tags: ${counted}, paused while ${queue.blockedBy ?? 'a listed app'} runs`
    case 'paused':
      return `Suggesting tags: ${counted}, paused`
    case 'idle':
      return queue.total === 0
        ? 'Tag suggestions: no images yet'
        : `Tag suggestions: all ${queue.total} images looked at`
    case 'error':
      return `Tag suggestions stopped: ${queue.error ?? 'the local model failed'}`
  }
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`
  return `${Math.round(bytes / 1024)} KB`
}

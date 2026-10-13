import type { AiStatusData } from '@loam/protocol'
import { call } from '../api.ts'
import { progressText } from './progress.ts'
import { useAiStatus } from './useAiStatus.ts'

/** "Suggesting tags: 120 of 400" with Pause/Resume; nothing while AI is off. */
export function AiProgressLine({
  status,
  onStatus,
}: {
  status: AiStatusData | null
  onStatus: (status: AiStatusData) => void
}) {
  if (!status) return null
  const text = progressText(status.queue)
  if (text === null) return null
  return (
    <div className="ai-progress" data-testid="ai-progress">
      <span className="ai-progress-text" role="status">
        {text}
      </span>
      {status.queue.state !== 'error' && (
        <button
          type="button"
          className="btn ghost ai-progress-button"
          onClick={() =>
            void call('ai:setPaused', { paused: !status.paused })
              .then(onStatus)
              .catch(() => undefined)
          }
        >
          {status.paused ? 'Resume' : 'Pause'}
        </button>
      )}
    </div>
  )
}

/** The progress line with its own status subscription, for the Library sidebar. */
export function AiProgress() {
  const [status, setStatus] = useAiStatus()
  return <AiProgressLine status={status} onStatus={setStatus} />
}

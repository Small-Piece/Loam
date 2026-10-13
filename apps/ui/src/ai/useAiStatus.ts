import { useEffect, useState } from 'react'
import type { AiStatusData } from '@loam/protocol'
import { call, onEvent } from '../api.ts'

/** The local AI helpers' status, kept up to date by ai:status events. */
export function useAiStatus(): [AiStatusData | null, (status: AiStatusData) => void] {
  const [status, setStatus] = useState<AiStatusData | null>(null)
  useEffect(() => {
    let live = true
    call('ai:status', {})
      .then((next) => {
        if (live) setStatus(next)
      })
      .catch(() => undefined)
    const stop = onEvent('ai:status', (next) => {
      if (live) setStatus(next)
    })
    return () => {
      live = false
      stop()
    }
  }, [])
  return [status, setStatus]
}

/** True when AI work can be asked for now (on, model present, not paused). */
export function aiReady(status: AiStatusData | null): boolean {
  return (
    status !== null &&
    status.enabled &&
    status.model.installed &&
    !status.paused &&
    status.queue.blockedBy === null
  )
}

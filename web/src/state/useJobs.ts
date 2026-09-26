import { useEffect, useState } from 'react'
import { api, urls } from '../api/client'
import type { JobListItem } from '../api/types'

/** Window event fired when a job's current summary version changes; detail is the job id. */
export const SUMMARY_CHANGED = 'transcriber:summary-changed'

export type Connection = 'connecting' | 'open' | 'lost'

const byNewest = (a: JobListItem, b: JobListItem) =>
  Date.parse(b.created_at) - Date.parse(a.created_at)

/** Live list of recordings over /api/events, reconnecting with backoff. */
export function useJobs() {
  const [jobs, setJobs] = useState<JobListItem[] | null>(null)
  const [connection, setConnection] = useState<Connection>('connecting')

  useEffect(() => {
    let source: EventSource | null = null
    let retry = 0
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    let lostTimer: ReturnType<typeof setTimeout> | undefined
    let disposed = false

    const connect = () => {
      source = new EventSource(urls.allEvents)
      source.addEventListener('snapshot', (e) => {
        retry = 0
        clearTimeout(lostTimer)
        lostTimer = undefined
        setConnection('open')
        setJobs((JSON.parse(e.data).jobs as JobListItem[]).sort(byNewest))
      })
      source.addEventListener('job_updated', (e) => {
        const item = JSON.parse(e.data) as JobListItem
        setJobs((prev) =>
          [...(prev ?? []).filter((j) => j.id !== item.id), item].sort(byNewest),
        )
      })
      source.addEventListener('job_deleted', (e) => {
        const { id } = JSON.parse(e.data) as { id: string }
        setJobs((prev) => prev?.filter((j) => j.id !== id) ?? prev)
      })
      // An open recording re-reads itself: its own stream is closed once the job is final.
      source.addEventListener('summary_changed', (e) => {
        const { id } = JSON.parse(e.data) as { id: string }
        window.dispatchEvent(new CustomEvent(SUMMARY_CHANGED, { detail: id }))
      })
      source.onerror = () => {
        source?.close()
        if (disposed) return
        // EventSource hides the status code: ask the API whether the session has expired
        // (a 401 there sends the user to the sign-in screen).
        api.me().catch(() => {})
        // A quick server restart shouldn't flash the "no connection" banner.
        lostTimer ??= setTimeout(() => setConnection('lost'), 1500)
        retryTimer = setTimeout(connect, Math.min(1000 * 2 ** retry++, 8000))
      }
    }

    connect()
    return () => {
      disposed = true
      source?.close()
      clearTimeout(retryTimer)
      clearTimeout(lostTimer)
    }
  }, [])

  return { jobs, connection }
}

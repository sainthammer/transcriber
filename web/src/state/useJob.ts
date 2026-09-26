import { useCallback, useEffect, useState } from 'react'
import { api, ApiError, urls } from '../api/client'
import type { JobDetail, Phrase } from '../api/types'
import { withViewTransition } from '../lib/hooks'
import { SUMMARY_CHANGED } from './useJobs'

export const isFinal = (status: JobDetail['status']) => status === 'done' || status === 'error'

interface State {
  id: string
  job: JobDetail | null
  missing: boolean // 404 or deleted while open
}

/**
 * One recording: a snapshot plus live events over SSE while it is processed.
 * The stream is closed as soon as the job is final — otherwise EventSource reconnects forever.
 */
export function useJob(id: string) {
  const [state, setState] = useState<State>({ id, job: null, missing: false })
  const [epoch, setEpoch] = useState(0)
  const reload = useCallback(() => setEpoch((n) => n + 1), [])
  /** A fresh snapshot from another request (e.g. restoring a summary version). */
  const replace = useCallback(
    (job: JobDetail) => setState((s) => (s.id === job.id ? { ...s, job, missing: false } : s)),
    [],
  )

  // Reset synchronously when switching recordings so stale data never flashes.
  if (state.id !== id) setState({ id, job: null, missing: false })

  useEffect(() => {
    let source: EventSource | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    let disposed = false

    const set = (job: JobDetail) => !disposed && setState({ id, job, missing: false })
    const patch = (fn: (job: JobDetail) => JobDetail) =>
      !disposed && setState((s) => (s.job ? { ...s, job: fn(s.job) } : s))
    const gone = () => !disposed && setState({ id, job: null, missing: true })

    const refresh = async () => {
      try {
        set(await api.job(id))
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) gone()
      }
    }

    // After a dropped connection: check the job exists and is still in progress first,
    // so a deleted job doesn't cause an endless reconnect loop.
    const retry = () => {
      timer = setTimeout(async () => {
        try {
          const job = await api.job(id)
          set(job)
          if (!isFinal(job.status) && !disposed) connect()
        } catch (e) {
          if (e instanceof ApiError && e.status === 404) gone()
          else if (!disposed) retry()
        }
      }, 2000)
    }

    const connect = () => {
      const es = new EventSource(urls.jobEvents(id))
      source = es
      es.addEventListener('snapshot', (e) => {
        const job = JSON.parse(e.data) as JobDetail
        set(job)
        if (isFinal(job.status)) es.close()
      })
      es.addEventListener('queue', (e) => {
        const { queue_position } = JSON.parse(e.data)
        patch((j) => ({ ...j, queue_position }))
      })
      // Stage changes are rare: re-read the job for exact stage statuses and timestamps.
      es.addEventListener('stage', () => void refresh())
      es.addEventListener('progress', (e) => {
        const p = JSON.parse(e.data)
        patch((j) => ({
          ...j,
          status: 'running',
          stage: 'transcribing',
          queue_position: null,
          progress: { processed_sec: p.processed_sec, total_sec: p.total_sec, phrases: p.phrases },
          progress_pct: p.total_sec
            ? Math.round(90 * Math.min(p.processed_sec / p.total_sec, 1))
            : j.progress_pct,
        }))
      })
      es.addEventListener('phrase', (e) => {
        const phrase = JSON.parse(e.data) as Phrase
        patch((j) => ({ ...j, transcript: [...j.transcript, phrase] }))
      })
      es.addEventListener('done', (e) => {
        es.close()
        const job = JSON.parse(e.data) as JobDetail
        withViewTransition(() => set(job))
      })
      es.addEventListener('error', (e) => {
        es.close()
        if (disposed) return
        if (e instanceof MessageEvent && e.data) {
          // Server-sent `event: error`: the job failed or was deleted.
          const { message } = JSON.parse(e.data) as { message: string }
          if (message === 'Запись удалена') gone()
          else void refresh()
        } else {
          retry() // connection dropped
        }
      })
    }

    // A version was made current elsewhere (another tab, or a regeneration seen via /api/events).
    const onSummaryChanged = (e: Event) => {
      if ((e as CustomEvent<string>).detail === id) void refresh()
    }
    window.addEventListener(SUMMARY_CHANGED, onSummaryChanged)

    connect()
    return () => {
      disposed = true
      source?.close()
      clearTimeout(timer)
      window.removeEventListener(SUMMARY_CHANGED, onSummaryChanged)
    }
  }, [id, epoch])

  const current = state.id === id ? state : { job: null, missing: false }
  return { job: current.job, missing: current.missing, reload, replace }
}

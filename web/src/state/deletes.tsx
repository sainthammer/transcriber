import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { api } from '../api/client'
import { prefs } from '../lib/prefs'
import { truncate } from '../lib/text'
import { DeletesContext as Ctx } from './deletesContext'
import { useToast } from './toastContext'

const UNDO_MS = 5000

/**
 * Deleting is optimistic: the recording disappears at once, the DELETE request goes out
 * only after the undo window. If the page closes earlier, pending deletes are flushed.
 */
export function DeletesProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set())
  const toast = useToast()
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())

  const drop = (id: string) => {
    timers.current.delete(id)
    setPending((prev) => {
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }

  const commit = useCallback(async (id: string) => {
    try {
      await api.deleteJob(id)
      prefs.forget(id)
    } catch (e) {
      const status = (e as { status?: number }).status
      if (status !== 404) {
        toast('Не удалось удалить запись — нет связи с сервером')
      }
    }
    drop(id)
  }, [toast])

  const remove = useCallback(
    (id: string, name: string) => {
      setPending((prev) => new Set(prev).add(id))
      timers.current.set(
        id,
        setTimeout(() => void commit(id), UNDO_MS),
      )
      toast(`«${truncate(name, 40)}» удалена`, {
        duration: UNDO_MS,
        action: {
          label: 'Отменить',
          onClick: () => {
            clearTimeout(timers.current.get(id))
            drop(id)
          },
        },
      })
    },
    [commit, toast],
  )

  useEffect(() => {
    const flush = () => {
      for (const [id, timer] of timers.current) {
        clearTimeout(timer)
        void fetch(`/api/jobs/${encodeURIComponent(id)}`, { method: 'DELETE', keepalive: true })
      }
      timers.current.clear()
    }
    window.addEventListener('pagehide', flush)
    return () => window.removeEventListener('pagehide', flush)
  }, [])

  return (
    <Ctx.Provider value={{ pending, remove }}>
      {children}
    </Ctx.Provider>
  )
}

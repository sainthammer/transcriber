import { useCallback, useEffect, useState } from 'react'
import type { ApiError } from '../api/client'

interface State<T> {
  key: string
  data: T | null
  error: ApiError | null
}

/**
 * Load once per `key`; `setData` applies a server response after a change without refetching.
 * Data from the previous key is never shown for the new one.
 */
export function useResource<T>(key: string, load: () => Promise<T>) {
  const [state, setState] = useState<State<T>>({ key, data: null, error: null })
  const [epoch, setEpoch] = useState(0)

  if (state.key !== key) setState({ key, data: null, error: null })

  useEffect(() => {
    let cancelled = false
    load().then(
      (data) => !cancelled && setState({ key, data, error: null }),
      (error: ApiError) => !cancelled && setState((s) => ({ key, data: s.key === key ? s.data : null, error })),
    )
    return () => {
      cancelled = true
    }
    // `load` is a new closure every render; the key says when the request changes.
  }, [key, epoch])

  const reload = useCallback(() => setEpoch((n) => n + 1), [])
  const setData = useCallback(
    (update: T | ((prev: T) => T)) =>
      setState((s) => ({
        ...s,
        data:
          typeof update === 'function'
            ? s.data === null
              ? s.data
              : (update as (prev: T) => T)(s.data)
            : update,
      })),
    [],
  )

  const current = state.key === key ? state : { data: null, error: null }
  return { data: current.data, error: current.error, reload, setData }
}

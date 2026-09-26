import { useCallback, useEffect, useState } from 'react'
import { api } from '../api/client'
import type { Config } from '../api/types'

/** Provider availability; re-checked when the window regains focus (e.g. Ollama was started). */
export function useConfig() {
  const [config, setConfig] = useState<Config | null>(null)

  const load = useCallback(async () => {
    try {
      setConfig(await api.config())
    } catch {
      // connection state is reported by the jobs stream
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    api.config().then(
      (c) => !cancelled && setConfig(c),
      () => {},
    )
    const onFocus = () => void load()
    window.addEventListener('focus', onFocus)
    return () => {
      cancelled = true
      window.removeEventListener('focus', onFocus)
    }
  }, [load])

  return { config, reloadConfig: load }
}

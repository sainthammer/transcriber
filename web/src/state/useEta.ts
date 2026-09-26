import { useEffect, useRef, useState } from 'react'

/**
 * Seconds left for recognition, from the average speed since the first real progress.
 * The shown value changes at most once per 5 s, so it doesn't jitter.
 */
export function useEta(processed: number, total: number | null, active: boolean): number | null {
  const samples = useRef<{ t: number; p: number } | null>(null)
  const shownAt = useRef(0)
  const [eta, setEta] = useState<number | null>(null)

  useEffect(() => {
    if (!active || !total || processed <= 0) {
      samples.current = null
      return
    }
    const now = performance.now()
    if (!samples.current) {
      samples.current = { t: now, p: processed }
      return
    }
    const dt = (now - samples.current.t) / 1000
    const dp = processed - samples.current.p
    if (dt < 4 || dp <= 0) return
    if (now - shownAt.current < 5000) return
    shownAt.current = now
    setEta(Math.max(0, (total - processed) / (dp / dt)))
  }, [processed, total, active])

  return active ? eta : null
}

import { flushSync } from 'react-dom'
import { useEffect, useState, useSyncExternalStore } from 'react'

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mql = matchMedia(query)
      mql.addEventListener('change', cb)
      return () => mql.removeEventListener('change', cb)
    },
    () => matchMedia(query).matches,
  )
}

export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches

/** Wrap a state update in a View Transition when the browser supports it. */
export function withViewTransition(update: () => void) {
  if (!document.startViewTransition || reducedMotion() || document.hidden) {
    update()
    return
  }
  document.startViewTransition(() => flushSync(update))
}

/** Re-renders every `ms` while `active` — for elapsed-time labels. */
export function useTicker(active: boolean, ms = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const id = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(id)
  }, [active, ms])
  return now
}

/** True when focus is in a place where keys mean typing or native control. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

export function isInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return (
    isEditableTarget(target) ||
    !!target.closest('button, a[href], [role="menuitem"], [role="tab"], [role="dialog"]')
  )
}

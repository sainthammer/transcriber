import { useEffect, useSyncExternalStore } from 'react'

// A handful of routes on the History API, no router library:
//   /                        — recordings (or first run)
//   /jobs/:id                — a recording, optional ?t=<seconds> to open at a moment
//   /admin                   — administration: section list on phones, users on wider screens
//   /admin/users[/:id]       — accounts and one account's recordings (metadata only)
//   /admin/usage             — token and audio usage, ?days=7|30|90
//   /admin/settings          — models and keys
//   /admin/types[/new|/:id]  — meeting types and their prompts
//   /admin/base-prompt       — rules shared by every type (not under /types: "new" and any
//                              other word there may be a type id)

export type AdminRoute =
  | { name: 'admin' }
  | { name: 'admin-users' }
  | { name: 'admin-user'; id: number }
  | { name: 'admin-usage' }
  | { name: 'admin-settings' }
  | { name: 'admin-types' }
  | { name: 'admin-type'; id: string }
  | { name: 'admin-type-new' }
  | { name: 'admin-base-prompt' }

export type Route = { name: 'home' } | { name: 'job'; id: string } | AdminRoute

const listeners = new Set<() => void>()

function parse(): Route {
  const path = location.pathname.replace(/\/+$/, '') || '/'
  let m = path.match(/^\/jobs\/([^/]+)$/)
  if (m) return { name: 'job', id: decodeURIComponent(m[1]) }
  if (!path.startsWith('/admin')) return { name: 'home' }
  if (path === '/admin/users') return { name: 'admin-users' }
  if ((m = path.match(/^\/admin\/users\/(\d+)$/))) return { name: 'admin-user', id: Number(m[1]) }
  if (path === '/admin/usage') return { name: 'admin-usage' }
  if (path === '/admin/settings') return { name: 'admin-settings' }
  if (path === '/admin/types') return { name: 'admin-types' }
  if (path === '/admin/types/new') return { name: 'admin-type-new' }
  if ((m = path.match(/^\/admin\/types\/([^/]+)$/)))
    return { name: 'admin-type', id: decodeURIComponent(m[1]) }
  if (path === '/admin/base-prompt') return { name: 'admin-base-prompt' }
  return { name: 'admin' }
}

let current = parse()
let currentUrl = location.pathname + location.search

function update() {
  const next = parse()
  currentUrl = location.pathname + location.search
  if (JSON.stringify(next) !== JSON.stringify(current)) current = next
  listeners.forEach((l) => l())
}

// --- Leaving a page with unsaved changes ---

type Blocker = (proceed: () => void) => void
let blocker: Blocker | null = null

window.addEventListener('popstate', () => {
  if (blocker) {
    // The URL has already changed: put it back and ask; go forward only if confirmed.
    const target = location.pathname + location.search
    history.pushState(null, '', currentUrl)
    blocker(() => {
      blocker = null
      navigate(target, { replace: true })
    })
    return
  }
  update()
})

/**
 * While `dirty`, in-app navigation calls `onBlock` with a function that completes it,
 * and closing the tab asks the browser's own question.
 */
export function useNavigationBlocker(dirty: boolean, onBlock: Blocker) {
  useEffect(() => {
    if (!dirty) return
    blocker = onBlock
    const beforeUnload = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', beforeUnload)
    return () => {
      if (blocker === onBlock) blocker = null
      window.removeEventListener('beforeunload', beforeUnload)
    }
  }, [dirty, onBlock])
}

export function navigate(path: string, { replace = false, force = false } = {}) {
  if (path === location.pathname + location.search) return
  if (blocker && !force) {
    const b = blocker
    b(() => {
      if (blocker === b) blocker = null
      navigate(path, { replace, force: true })
    })
    return
  }
  history[replace ? 'replaceState' : 'pushState'](null, '', path)
  update()
}

export const jobPath = (id: string) => `/jobs/${encodeURIComponent(id)}`
export const userPath = (id: number) => `/admin/users/${id}`
export const typePath = (id: string) => `/admin/types/${encodeURIComponent(id)}`

export function useRoute(): Route {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => current,
  )
}

/** Moment requested by the URL (?t=), read once when a recording opens. */
export function initialTime(): number | null {
  const t = Number(new URLSearchParams(location.search).get('t'))
  return Number.isFinite(t) && t > 0 ? t : null
}

/** Keep ?t= in sync with the last timestamp the user jumped to, without a history entry. */
export function setTimeParam(t: number | null) {
  setParam('t', t === null ? null : String(Math.floor(t)))
}

export function getParam(name: string): string | null {
  return new URLSearchParams(location.search).get(name)
}

/** Replace one query parameter without adding a history entry. */
export function setParam(name: string, value: string | null) {
  const params = new URLSearchParams(location.search)
  if (value === null) params.delete(name)
  else params.set(name, value)
  const query = params.toString()
  history.replaceState(history.state, '', location.pathname + (query ? `?${query}` : ''))
  currentUrl = location.pathname + location.search
}

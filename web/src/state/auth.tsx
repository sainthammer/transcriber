import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { api, ApiError, onUnauthorized } from '../api/client'
import type { User } from '../api/types'
import { Login } from '../components/Login'
import { Offline } from '../components/Offline'
import { AuthContext } from './authContext'

type State =
  | { status: 'checking' }
  | { status: 'offline' }
  | { status: 'signed-out'; expired: boolean }
  | { status: 'signed-in'; user: User }

/**
 * Asks /api/auth/me once, then shows either the sign-in screen or the app.
 * Any 401 from the API later (session expired, logged out in another tab) brings the
 * sign-in screen back without losing the current URL, so the user returns to the same place.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>({ status: 'checking' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    api.me().then(
      (user) => !cancelled && setState({ status: 'signed-in', user }),
      (e: ApiError) => {
        if (cancelled) return
        if (e.status === 401) setState({ status: 'signed-out', expired: false })
        else setState({ status: 'offline' })
      },
    )
    return () => {
      cancelled = true
    }
  }, [attempt])

  // Offline: keep trying quietly, the page connects by itself when the server is back.
  useEffect(() => {
    if (state.status !== 'offline') return
    const id = setTimeout(() => setAttempt((n) => n + 1), 3000)
    return () => clearTimeout(id)
  }, [state, attempt])

  useEffect(
    () =>
      onUnauthorized(() =>
        setState((s) => (s.status === 'signed-in' ? { status: 'signed-out', expired: true } : s)),
      ),
    [],
  )

  const setUser = useCallback((user: User) => setState({ status: 'signed-in', user }), [])
  const logout = useCallback(async () => {
    try {
      await api.logout()
    } catch {
      // the session is gone either way from this tab's point of view
    }
    setState({ status: 'signed-out', expired: false })
  }, [])

  const auth = useMemo(
    () =>
      state.status === 'signed-in'
        ? { user: state.user, isAdmin: state.user.role === 'admin', setUser, logout }
        : null,
    [state, setUser, logout],
  )

  if (state.status === 'checking') return <div style={{ minHeight: '100dvh' }} />
  if (state.status === 'offline') return <Offline />
  if (state.status === 'signed-out') {
    return <Login expired={state.expired} onSignedIn={setUser} />
  }
  return (
    // key: a different account gets a fresh app — no lists or caches from the previous one.
    <AuthContext.Provider value={auth} key={state.user.id}>
      {children}
    </AuthContext.Provider>
  )
}

import { createContext, useContext } from 'react'
import type { User } from '../api/types'

export interface Auth {
  user: User
  isAdmin: boolean
  /** Replace the signed-in user's data (e.g. after renaming yourself in the admin). */
  setUser: (user: User) => void
  logout: () => Promise<void>
}

export const AuthContext = createContext<Auth | null>(null)

/** The signed-in user. Only used below the sign-in gate, so it is always there. */
export function useAuth(): Auth {
  const auth = useContext(AuthContext)
  if (!auth) throw new Error('useAuth outside of AuthGate')
  return auth
}

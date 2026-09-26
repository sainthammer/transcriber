import { createContext, useContext } from 'react'

interface Deletes {
  /** Recordings hidden while the undo window is open. */
  pending: ReadonlySet<string>
  remove: (id: string, name: string) => void
}

export const DeletesContext = createContext<Deletes>({ pending: new Set(), remove: () => {} })
export const useDeletes = () => useContext(DeletesContext)

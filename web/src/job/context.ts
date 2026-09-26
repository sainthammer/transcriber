import { createContext, useContext } from 'react'
import type { Phrase } from '../api/types'

export interface JobContextValue {
  transcript: Phrase[]
  /** Show hours in timestamps so a column of them lines up. */
  long: boolean
  /** Jump to a moment from the summary: nearest phrase at or before t, 2 s of lead-in, play. */
  jump: (t: number) => void
}

export const JobContext = createContext<JobContextValue>({
  transcript: [],
  long: false,
  jump: () => {},
})

export const useJobContext = () => useContext(JobContext)

import type { Provider, SummaryTypeChoice } from '../api/types'

export interface NewJobPrefs {
  provider: Provider
  summary: boolean
  summaryType: SummaryTypeChoice
}

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // private mode or full storage — preferences are a convenience
  }
}

export const prefs = {
  newJob: () => read<Partial<NewJobPrefs>>('prefs:new-job'),
  saveNewJob: (p: NewJobPrefs) => write('prefs:new-job', p),
  rate: () => read<number>('prefs:rate') ?? 1,
  saveRate: (r: number) => write('prefs:rate', r),
  position: (jobId: string) => read<number>(`position:${jobId}`),
  savePosition: (jobId: string, t: number) => write(`position:${jobId}`, Math.floor(t)),
  forget: (jobId: string) => {
    try {
      localStorage.removeItem(`position:${jobId}`)
    } catch {
      // ignore
    }
  },
}

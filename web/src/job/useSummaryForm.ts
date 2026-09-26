import { useState } from 'react'
import { api, ApiError } from '../api/client'
import type { Config, Provider, SummaryTypeChoice } from '../api/types'
import { usableProvider, usableType } from '../lib/providers'

export interface SummaryFormInit {
  provider: Provider
  summaryType: SummaryTypeChoice
  instructions?: string
}

/**
 * State and submission of a summary request: first one, a retry or a new version.
 * Provider and type fall back to what is usable now (a type may have been switched off).
 */
export function useSummaryForm(
  jobId: string,
  config: Config | null,
  init: SummaryFormInit,
  onRequested: (instructions: string) => void,
) {
  const [provider, setProvider] = useState<Provider>(init.provider)
  const [wantedType, setSummaryType] = useState<SummaryTypeChoice>(init.summaryType)
  const [instructions, setInstructions] = useState(init.instructions ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [instructionsError, setInstructionsError] = useState<string | null>(null)

  const effective = config ? usableProvider(config, provider) : null
  const summaryType = usableType(config, wantedType)

  /** Back to the given values — when a dialog opens again. */
  const reset = (next: SummaryFormInit) => {
    setProvider(next.provider)
    setSummaryType(next.summaryType)
    setInstructions(next.instructions ?? '')
    setBusy(false)
    setError(null)
    setInstructionsError(null)
  }

  const submit = async () => {
    if (!effective || busy) return
    setBusy(true)
    setError(null)
    setInstructionsError(null)
    const wishes = instructions.trim()
    try {
      await api.requestSummary(jobId, effective, summaryType, wishes || null)
      // Stays busy: the form is replaced by the processing state (or closed) right after.
      onRequested(wishes)
    } catch (e) {
      const err = e as ApiError
      if (err.status === 422 && err.fields.instructions) setInstructionsError(err.fields.instructions)
      else setError(err.message)
      setBusy(false)
    }
  }

  return {
    provider: effective,
    setProvider,
    summaryType,
    setSummaryType,
    instructions,
    setInstructions,
    busy,
    error,
    instructionsError,
    submit,
    reset,
  }
}

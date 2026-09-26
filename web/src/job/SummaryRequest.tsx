import type { FormEvent } from 'react'
import type { Config, JobDetail } from '../api/types'
import { prefs } from '../lib/prefs'
import { useAuth } from '../state/authContext'
import { SummaryOptions } from '../components/SummaryOptions'
import { Button } from '../components/ui/Button'
import { InstructionsField } from './InstructionsField'
import { useSummaryForm } from './useSummaryForm'
import styles from './JobMain.module.css'

interface Props {
  job: JobDetail
  config: Config | null
  kind: 'retry' | 'make'
  /** Wishes from the failed attempt, if this tab sent it. */
  instructions?: string
  onRequested: (instructions: string) => void
}

/** «Summary не получилось» with a retry, or «Summary не делали» with a first request. */
export function SummaryRequest({ job, config, kind, instructions, onRequested }: Props) {
  const saved = prefs.newJob()
  const form = useSummaryForm(
    job.id,
    config,
    {
      provider: kind === 'retry' ? job.options.provider : (saved?.provider ?? 'auto'),
      summaryType: job.options.summary_type ?? saved?.summaryType ?? 'auto',
      instructions,
    },
    onRequested,
  )
  const { isAdmin } = useAuth()

  const submit = (e: FormEvent) => {
    e.preventDefault()
    void form.submit()
  }

  return (
    <form className={styles.panel} aria-labelledby="summary-request-h" onSubmit={submit} noValidate>
      <h2 id="summary-request-h" className={styles.panelTitle}>
        {kind === 'retry' ? 'Summary не получилось' : 'Summary не делали'}
      </h2>
      <p className={styles.panelText}>
        {kind === 'retry'
          ? job.summary_error
          : 'Расшифровка готова. Итог соберёт главное: решения, задачи, ключевые цифры и ход обсуждения.'}
      </p>

      {config && form.provider ? (
        <div className={styles.panelOptions}>
          <SummaryOptions
            config={config}
            provider={form.provider}
            onProvider={form.setProvider}
            summaryType={form.summaryType}
            onSummaryType={form.setSummaryType}
          />
          {kind === 'retry' && (
            <InstructionsField
              value={form.instructions}
              onChange={form.setInstructions}
              error={form.instructionsError}
            />
          )}
        </div>
      ) : (
        config && (
          <p className={styles.panelText}>
            {isAdmin
              ? 'Нет доступной модели — добавьте ключ DeepSeek или проверьте Ollama в разделе «Модели и ключи».'
              : 'Нет доступной модели — сообщите администратору.'}
          </p>
        )
      )}

      {form.error && (
        <p className={styles.panelError} role="alert">
          {form.error}
        </p>
      )}

      <div className={styles.panelActions}>
        <Button type="submit" variant="primary" loading={form.busy} disabled={!form.provider}>
          {kind === 'retry' ? 'Повторить' : 'Сделать итог'}
        </Button>
      </div>
    </form>
  )
}

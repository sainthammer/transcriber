import { useState } from 'react'
import { api } from '../api/client'
import type {
  Config,
  JobDetail,
  Provider,
  SummaryTypeChoice,
} from '../api/types'
import { prefs } from '../lib/prefs'
import { usableProvider, usableType } from '../lib/providers'
import { useAuth } from '../state/authContext'
import { SummaryOptions } from '../components/SummaryOptions'
import { Button } from '../components/ui/Button'
import styles from './JobMain.module.css'

interface Props {
  job: JobDetail
  config: Config | null
  kind: 'retry' | 'make'
  onRequested: () => void
}

/** «Summary не получилось» with a retry, or «Summary не делали» with a first request. */
export function SummaryRequest({ job, config, kind, onRequested }: Props) {
  const saved = prefs.newJob()
  const [provider, setProvider] = useState<Provider>(
    kind === 'retry' ? job.options.provider : (saved?.provider ?? 'auto')
  )
  const [wantedType, setSummaryType] = useState<SummaryTypeChoice>(
    job.options.summary_type ?? saved?.summaryType ?? 'auto'
  )
  const summaryType = usableType(config, wantedType)
  const { isAdmin } = useAuth()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const effective = config ? usableProvider(config, provider) : null

  const submit = async () => {
    if (!effective) return
    setBusy(true)
    setError(null)
    try {
      await api.requestSummary(job.id, effective, summaryType)
      onRequested()
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  return (
    <section className={styles.panel} aria-labelledby="summary-request-h">
      <h2 id="summary-request-h" className={styles.panelTitle}>
        {kind === 'retry' ? 'Summary не получилось' : 'Summary не делали'}
      </h2>
      <p className={styles.panelText}>
        {kind === 'retry'
          ? job.summary_error
          : 'Расшифровка готова. Итог соберёт главное: решения, задачи, ключевые цифры и ход обсуждения.'}
      </p>

      {config && effective ? (
        <div className={styles.panelOptions}>
          <SummaryOptions
            config={config}
            provider={effective}
            onProvider={setProvider}
            summaryType={summaryType}
            onSummaryType={setSummaryType}
          />
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

      {error && (
        <p className={styles.panelError} role="alert">
          {error}
        </p>
      )}

      <div className={styles.panelActions}>
        <Button
          variant="primary"
          onClick={submit}
          loading={busy}
          disabled={!effective}
        >
          {kind === 'retry' ? 'Повторить' : 'Сделать итог'}
        </Button>
      </div>
    </section>
  )
}

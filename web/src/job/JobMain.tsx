import { useEffect, useRef, useState } from 'react'
import type { Ref } from 'react'
import { AlertCircle, Info } from 'lucide-react'
import type { Config, JobDetail } from '../api/types'
import { dateTime, duration, jobTitle } from '../lib/format'
import { providerName } from '../lib/providers'
import { Button } from '../components/ui/Button'
import { Processing } from './Processing'
import { RegenerateDialog } from './RegenerateDialog'
import { SummaryBody } from './Summary'
import { RegenerationError, SummaryBar } from './SummaryBar'
import { SummaryRequest } from './SummaryRequest'
import type { SummaryFormInit } from './useSummaryForm'
import styles from './JobMain.module.css'

interface Props {
  job: JobDetail
  config: Config | null
  articleRef: Ref<HTMLElement>
  onTitleVisible: (visible: boolean) => void
  onRequested: () => void
  /** A new snapshot after restoring an earlier summary version. */
  onRestored: (job: JobDetail) => void
  onDelete: () => void
  onPick: () => void
}

export function JobMain({
  job,
  config,
  articleRef,
  onTitleVisible,
  onRequested,
  onRestored,
  onDelete,
  onPick,
}: Props) {
  const titleRef = useRef<HTMLHeadingElement>(null)
  const summary = job.summary
  const processing = job.status === 'queued' || job.status === 'running'
  // A ready summary stays on screen while a new version is made; only the first one shows the steps.
  const regenerating = processing && !!summary
  const current = job.summary_versions?.find((v) => v.current)

  // Wishes sent from this tab: offered again when the attempt fails.
  const [lastInstructions, setLastInstructions] = useState('')
  const [dialog, setDialog] = useState<SummaryFormInit | null>(null)
  const [dismissedError, setDismissedError] = useState<string | null>(null)
  const regenError =
    summary && !processing && job.summary_error && job.summary_error !== dismissedError
      ? job.summary_error
      : null

  const requested = (instructions: string) => {
    setLastInstructions(instructions)
    setDismissedError(null)
    onRequested()
  }

  // The compact title in the toolbar appears once the large one scrolls away.
  useEffect(() => {
    const el = titleRef.current
    if (!el) return
    const observer = new IntersectionObserver(
      ([entry]) => onTitleVisible(entry.isIntersecting),
      { rootMargin: '-120px 0px 0px 0px' },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [onTitleVisible])

  const typeInfo = summary && config?.summary_types.find((t) => t.id === summary.meeting_type)
  const typeLabel = typeInfo?.label
  const provider = summary ? (current?.provider ?? job.provider_used) : null
  const meta = [dateTime(job.created_at), duration(job.duration_sec), typeLabel, providerName(provider)].filter(
    Boolean,
  )

  // «Пересобрать» starts from what made the current version; a retry — from the failed request.
  const openRegenerate = () =>
    summary &&
    setDialog({
      provider: provider && provider !== 'unknown' ? provider : job.options.provider,
      summaryType: summary.meeting_type,
    })
  const openRetry = () =>
    setDialog({
      provider: job.options.provider,
      summaryType: job.options.summary_type ?? summary?.meeting_type ?? 'auto',
      instructions: lastInstructions,
    })

  return (
    <article ref={articleRef} className={styles.article}>
      <header className={styles.intro}>
        <h1 ref={titleRef} className={styles.title}>
          {summary?.title ?? jobTitle(job)}
        </h1>
        <p className={`${styles.meta} tabular`}>{meta.join(' · ')}</p>
        {summary && provider === 'ollama' && (
          <p className={styles.localNote} data-copy-skip>
            <Info size={14} strokeWidth={1.75} aria-hidden />
            Сделано локально — модель может путать стороны и детали. Сверяйтесь с расшифровкой.
          </p>
        )}
      </header>

      {summary && (job.status === 'done' || regenerating) ? (
        <>
          <SummaryBar
            job={job}
            config={config}
            regenerating={regenerating}
            onRegenerate={openRegenerate}
            onRestored={onRestored}
          />
          {regenError && (
            <RegenerationError
              message={regenError}
              onRetry={openRetry}
              onDismiss={() => setDismissedError(regenError)}
            />
          )}
          {/* Keyed by version: switching versions replays the entrance. */}
          <div
            key={current?.id}
            className={styles.summary}
            data-stale={regenerating || undefined}
            aria-busy={regenerating || undefined}
          >
            <SummaryBody summary={summary} sections={typeInfo?.sections} />
          </div>
          <RegenerateDialog
            jobId={job.id}
            config={config}
            init={dialog}
            onClose={() => setDialog(null)}
            onRequested={requested}
          />
        </>
      ) : processing ? (
        <Processing job={job} onCancel={onDelete} />
      ) : job.status === 'error' ? (
        <JobError job={job} onDelete={onDelete} onPick={onPick} />
      ) : (
        <SummaryRequest
          job={job}
          config={config}
          kind={job.summary_error ? 'retry' : 'make'}
          instructions={lastInstructions}
          onRequested={requested}
        />
      )}
    </article>
  )
}

function JobError({ job, onDelete, onPick }: { job: JobDetail; onDelete: () => void; onPick: () => void }) {
  const noSpeech = job.error === 'В записи не найдено речи'
  const interrupted = job.error?.startsWith('Обработка прервана')
  const title = noSpeech ? 'В записи не найдено речи' : interrupted ? 'Обработка прервана' : 'Не удалось распознать запись'
  const text = noSpeech
    ? 'Проверьте, что в файле есть голос и звук не выключен. Если это видео — возможно, у него нет звуковой дорожки.'
    : interrupted
      ? 'Сервер перезапустили во время обработки. Загрузите файл ещё раз — начнём сначала.'
      : job.error

  return (
    <section className={styles.panel} aria-labelledby="error-h">
      <span className={styles.panelIcon} aria-hidden>
        <AlertCircle size={24} strokeWidth={1.75} />
      </span>
      <h2 id="error-h" className={styles.panelTitle}>
        {title}
      </h2>
      <p className={styles.panelText}>{text}</p>
      <div className={styles.panelActions}>
        <Button variant="primary" onClick={onPick}>
          Выбрать файл
        </Button>
        <Button variant="danger" onClick={onDelete}>
          Удалить запись
        </Button>
      </div>
    </section>
  )
}

import { useEffect, useRef } from 'react'
import type { Ref } from 'react'
import { AlertCircle, Info } from 'lucide-react'
import type { Config, JobDetail } from '../api/types'
import { dateTime, duration, jobTitle } from '../lib/format'
import { Button } from '../components/ui/Button'
import { Processing } from './Processing'
import { SummaryBody } from './Summary'
import { SummaryRequest } from './SummaryRequest'
import styles from './JobMain.module.css'

interface Props {
  job: JobDetail
  config: Config | null
  articleRef: Ref<HTMLElement>
  onTitleVisible: (visible: boolean) => void
  onRequested: () => void
  onDelete: () => void
  onPick: () => void
}

export function JobMain({ job, config, articleRef, onTitleVisible, onRequested, onDelete, onPick }: Props) {
  const titleRef = useRef<HTMLHeadingElement>(null)
  const summary = job.summary
  const processing = job.status === 'queued' || job.status === 'running'

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
  const provider = summary && job.provider_used
  const meta = [
    dateTime(job.created_at),
    duration(job.duration_sec),
    typeLabel,
    provider === 'deepseek' ? 'DeepSeek' : provider === 'ollama' ? 'Локальная модель' : null,
  ].filter(Boolean)

  return (
    <article ref={articleRef} className={styles.article}>
      <header className={styles.intro}>
        <h1 ref={titleRef} className={styles.title}>
          {summary?.title ?? jobTitle(job)}
        </h1>
        <p className={`${styles.meta} tabular`}>{meta.join(' · ')}</p>
        {summary && job.provider_used === 'ollama' && (
          <p className={styles.localNote} data-copy-skip>
            <Info size={14} strokeWidth={1.75} aria-hidden />
            Сделано локально — модель может путать стороны и детали. Сверяйтесь с расшифровкой.
          </p>
        )}
      </header>

      {processing ? (
        <Processing job={job} onCancel={onDelete} />
      ) : job.status === 'error' ? (
        <JobError job={job} onDelete={onDelete} onPick={onPick} />
      ) : summary ? (
        <div className={styles.summary}>
          <SummaryBody summary={summary} sections={typeInfo?.sections} />
        </div>
      ) : (
        <SummaryRequest
          job={job}
          config={config}
          kind={job.summary_error ? 'retry' : 'make'}
          onRequested={onRequested}
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

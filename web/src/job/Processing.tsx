import type { ReactNode } from 'react'
import { Check, Minus, X } from 'lucide-react'
import type { JobDetail, StageInfo, StageName } from '../api/types'
import { clock, duration, plural } from '../lib/format'
import { useTicker } from '../lib/hooks'
import { useEta } from '../state/useEta'
import { Button } from '../components/ui/Button'
import { ProgressRing } from '../components/ui/ProgressRing'
import styles from './JobMain.module.css'

const PROVIDER_PLAN = {
  deepseek: 'Через DeepSeek',
  ollama: 'Локальной моделью',
  auto: 'Модель выберем по размеру расшифровки',
} as const

function elapsed(stage: StageInfo, now: number): string {
  const from = stage.started_at ? Date.parse(stage.started_at) : null
  const to = stage.finished_at ? Date.parse(stage.finished_at) : now
  if (!from) return ''
  return clock(Math.max(0, (to - from) / 1000))
}

function etaText(seconds: number): string {
  if (seconds < 50) return 'меньше минуты'
  const minutes = Math.round(seconds / 60)
  return `около ${minutes} мин`
}

const phraseCount = (n: number) =>
  `${n} ${plural(n, ['фраза', 'фразы', 'фраз'])}`

interface Props {
  job: JobDetail
  onCancel?: () => void
}

/** Queue position and the three steps with live progress. */
export function Processing({ job, onCancel }: Props) {
  const running = job.status === 'running'
  const now = useTicker(running)
  const transcribing = running && job.stage === 'transcribing'
  const processed = job.progress.processed_sec
  const total = job.progress.total_sec ?? job.duration_sec
  const loadingModel = transcribing && processed === 0
  const eta = useEta(processed, total, transcribing && !loadingModel)
  const summaryOnly = job.stages.transcribing.status === 'done'

  const steps: {
    name: StageName
    title: string
    detail: ReactNode
    progress?: number | null
  }[] = [
    {
      name: 'transcribing',
      title: 'Распознавание речи',
      detail: loadingModel
        ? 'Загружаем модель распознавания…'
        : transcribing && total
          ? `${clock(processed)} из ${clock(total)}${eta != null ? ` · осталось ${etaText(eta)}` : ''}`
          : job.stages.transcribing.status === 'done'
            ? `${phraseCount(job.progress.phrases || job.transcript.length)} · ${elapsed(job.stages.transcribing, now)}`
            : null,
      progress: transcribing
        ? loadingModel
          ? null
          : total
            ? processed / total
            : null
        : undefined,
    },
    {
      name: 'summarizing',
      title: 'Итог',
      detail:
        job.stages.summarizing.status === 'skipped'
          ? 'Выключено'
          : job.stages.summarizing.status === 'running'
            ? `${job.provider_used === 'ollama' ? 'Локальная модель' : 'DeepSeek'} · идёт ${elapsed(job.stages.summarizing, now)}`
            : PROVIDER_PLAN[job.options.provider],
    },
  ]

  return (
    <section className={styles.processing} aria-labelledby="processing-h">
      <h2 id="processing-h" className="visually-hidden">
        Обработка
      </h2>

      <p className={styles.processingStatus} role="status">
        {job.status === 'queued'
          ? job.queue_position && job.queue_position > 1
            ? `В очереди: ${job.queue_position}-я. Записи обрабатываются по одной.`
            : 'Следующая в очереди — начнём, как только закончится текущая запись.'
          : summaryOnly
            ? 'Готовим итог по готовой расшифровке.'
            : `Обрабатываем запись${job.duration_sec ? ` на ${duration(job.duration_sec)}` : ''}. Можно закрыть страницу — работа продолжится.`}
      </p>

      <ol className={styles.steps}>
        {steps.map((step) => {
          const status = job.stages[step.name].status
          return (
            <li key={step.name} className={styles.step} data-status={status}>
              <span className={styles.stepIcon} aria-hidden>
                {status === 'done' && <Check size={14} strokeWidth={2.5} />}
                {status === 'skipped' && <Minus size={14} strokeWidth={2.5} />}
                {status === 'error' && <X size={14} strokeWidth={2.5} />}
                {status === 'running' && (
                  <ProgressRing value={null} size={22} />
                )}
              </span>
              <div className={styles.stepBody}>
                <p className={styles.stepTitle}>
                  {step.title}
                  <span className="visually-hidden">
                    {' '}
                    —{' '}
                    {
                      {
                        pending: 'ожидает',
                        running: 'идёт',
                        done: 'готово',
                        skipped: 'пропущено',
                        error: 'ошибка',
                      }[status]
                    }
                  </span>
                </p>
                {step.detail && (
                  <p className={`${styles.stepDetail} tabular`}>
                    {step.detail}
                  </p>
                )}
                {step.progress !== undefined && (
                  <div
                    className={styles.stepBar}
                    data-indeterminate={step.progress === null || undefined}
                  >
                    <div
                      className={styles.stepBarFill}
                      style={{ transform: `scaleX(${step.progress ?? 0.3})` }}
                    />
                  </div>
                )}
              </div>
            </li>
          )
        })}
      </ol>

      {onCancel && !summaryOnly && (
        <div className={styles.panelActions}>
          <Button variant="secondary" onClick={onCancel}>
            Отменить обработку
          </Button>
        </div>
      )}
    </section>
  )
}

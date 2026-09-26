import { useState } from 'react'
import * as Dropdown from '@radix-ui/react-dropdown-menu'
import * as Tooltip from '@radix-ui/react-tooltip'
import { AlertCircle, Check, ChevronDown, RefreshCw, X } from 'lucide-react'
import { api, ApiError } from '../api/client'
import type { Config, JobDetail, SummaryVersion } from '../api/types'
import { clock, dateTime, dayLabel, timeOfDay } from '../lib/format'
import { useTicker } from '../lib/hooks'
import { providerName } from '../lib/providers'
import { useToast } from '../state/toastContext'
import { Button, IconButton } from '../components/ui/Button'
import { ProgressRing } from '../components/ui/ProgressRing'
import styles from './SummaryBar.module.css'

/** «14:05» today, «Вчера, 14:05» or «12 сентября, 14:05» otherwise. */
const when = (iso: string) => (dayLabel(iso) === 'Сегодня' ? timeOfDay(iso) : dateTime(iso))

interface Props {
  job: JobDetail
  config: Config | null
  regenerating: boolean
  onRegenerate: () => void
  onRestored: (job: JobDetail) => void
}

/**
 * The line above a ready summary: which version is shown (with a switch back to an earlier one)
 * and «Пересобрать». While a new version is being made the same line shows its progress,
 * so the summary below doesn't move.
 */
export function SummaryBar({ job, config, regenerating, onRegenerate, onRestored }: Props) {
  const versions = job.summary_versions ?? []
  return (
    <div className={styles.bar} data-copy-skip>
      {regenerating ? (
        <RegenerationStatus job={job} />
      ) : (
        <>
          {versions.length > 1 ? (
            <VersionSwitch job={job} config={config} versions={versions} onRestored={onRestored} />
          ) : (
            <span />
          )}
          <Button
            variant="plain"
            className={styles.action}
            icon={<RefreshCw size={16} strokeWidth={2} />}
            onClick={onRegenerate}
          >
            Пересобрать
          </Button>
        </>
      )}
    </div>
  )
}

function RegenerationStatus({ job }: { job: JobDetail }) {
  const running = job.status === 'running'
  const now = useTicker(running)
  const started = job.stages.summarizing.started_at
  const elapsed = running && started ? clock(Math.max(0, (now - Date.parse(started)) / 1000)) : null
  const text =
    job.status === 'queued'
      ? job.queue_position && job.queue_position > 1
        ? `Новая версия в очереди: ${job.queue_position}-я`
        : 'Новая версия — следующая в очереди'
      : 'Готовим новую версию'

  return (
    <p className={styles.status} role="status">
      <ProgressRing value={null} size={18} queued={job.status === 'queued'} />
      <span>
        {text}
        {elapsed && <span className={`${styles.elapsed} tabular`}> · {elapsed}</span>}
      </span>
    </p>
  )
}

interface SwitchProps {
  job: JobDetail
  config: Config | null
  versions: SummaryVersion[]
  onRestored: (job: JobDetail) => void
}

function VersionSwitch({ job, config, versions, onRestored }: SwitchProps) {
  const toast = useToast()
  const [pending, setPending] = useState<number | null>(null)
  const total = versions.length
  // Newest first: the last in the list is version 1.
  const number = (i: number) => total - i
  const currentIndex = Math.max(0, versions.findIndex((v) => v.current))
  const current = versions[currentIndex]
  const typeLabel = (id: string) => config?.summary_types.find((t) => t.id === id)?.label

  const restore = async (value: string) => {
    const id = Number(value)
    if (id === current.id || pending !== null) return
    setPending(id)
    try {
      onRestored(await api.restoreSummaryVersion(job.id, id))
    } catch (e) {
      const err = e as ApiError
      toast(
        err.status === 409
          ? 'Сейчас идёт обработка — вернуться к версии можно после неё'
          : err.message,
      )
    } finally {
      setPending(null)
    }
  }

  const trigger = (
    <button type="button" className={styles.trigger} aria-busy={pending !== null || undefined}>
      <span className="tabular">
        Версия {number(currentIndex)} из {total}
        <span className={styles.triggerMeta}> · {when(current.created_at)}</span>
      </span>
      {pending !== null ? (
        <span className={styles.spinner} aria-hidden />
      ) : (
        <ChevronDown size={16} strokeWidth={2} aria-hidden />
      )}
    </button>
  )

  return (
    <Dropdown.Root>
      {current.instructions ? (
        <Tooltip.Root>
          <Tooltip.Trigger asChild>
            <Dropdown.Trigger asChild>{trigger}</Dropdown.Trigger>
          </Tooltip.Trigger>
          <Tooltip.Portal>
            <Tooltip.Content className={styles.tooltip} side="bottom" align="start" sideOffset={6} collisionPadding={12}>
              <span className={styles.tooltipLabel}>Пожелание</span>
              {current.instructions}
            </Tooltip.Content>
          </Tooltip.Portal>
        </Tooltip.Root>
      ) : (
        <Dropdown.Trigger asChild>{trigger}</Dropdown.Trigger>
      )}
      <Dropdown.Portal>
        <Dropdown.Content className={styles.menu} align="start" sideOffset={6} collisionPadding={12}>
          <Dropdown.Label className={styles.menuLabel}>Версии итога</Dropdown.Label>
          <Dropdown.RadioGroup value={String(current.id)} onValueChange={(v) => void restore(v)}>
            {versions.map((v, i) => (
              <Dropdown.RadioItem key={v.id} value={String(v.id)} className={styles.item}>
                <span className={styles.check}>
                  <Dropdown.ItemIndicator>
                    <Check size={16} strokeWidth={2.25} aria-hidden />
                  </Dropdown.ItemIndicator>
                </span>
                <span className={styles.itemBody}>
                  <span className={styles.itemTitle}>
                    <span>Версия {number(i)}</span>
                    <span className={`${styles.itemTime} tabular`}>{when(v.created_at)}</span>
                  </span>
                  <span className={styles.itemMeta}>
                    {[providerName(v.provider), typeLabel(v.summary_type)].filter(Boolean).join(' · ')}
                  </span>
                  {v.instructions && <span className={styles.itemWish}>«{v.instructions}»</span>}
                </span>
              </Dropdown.RadioItem>
            ))}
          </Dropdown.RadioGroup>
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  )
}

interface ErrorProps {
  message: string
  onRetry: () => void
  onDismiss: () => void
}

const sentence = (s: string) => (/[.!?…]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`)

/** A new version failed; the previous one stays on screen. */
export function RegenerationError({ message, onRetry, onDismiss }: ErrorProps) {
  return (
    <div className={styles.error} role="alert" data-copy-skip>
      <AlertCircle className={styles.errorIcon} size={18} strokeWidth={1.75} aria-hidden />
      <div className={styles.errorBody}>
        <p className={styles.errorTitle}>Новая версия не получилась</p>
        <p className={styles.errorText}>{sentence(message)} Показана прежняя версия.</p>
        <Button variant="plain" className={styles.retry} onClick={onRetry}>
          Повторить
        </Button>
      </div>
      <IconButton label="Скрыть" className={styles.dismiss} onClick={onDismiss}>
        <X size={18} strokeWidth={1.75} />
      </IconButton>
    </div>
  )
}

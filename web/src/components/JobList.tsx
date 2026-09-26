import type { MouseEvent } from 'react'
import type { JobListItem } from '../api/types'
import { dayLabel, duration, jobTitle, timeOfDay } from '../lib/format'
import { jobPath, navigate } from '../lib/router'
import { ProgressRing } from './ui/ProgressRing'
import styles from './JobList.module.css'

function meta(job: JobListItem): { text: string; error?: boolean } {
  switch (job.status) {
    case 'queued':
      return {
        text:
          job.queue_position && job.queue_position > 1
            ? `В очереди · ${job.queue_position}-я`
            : 'В очереди',
      }
    case 'running':
      if (job.stage === 'summarizing') return { text: 'Готовим итог' }
      return {
        text:
          job.progress_pct > 0
            ? `Распознаём · ${job.progress_pct}%`
            : 'Готовимся к распознаванию',
      }
    case 'error':
      return { text: 'Не удалось обработать', error: true }
    default:
      return {
        text: [timeOfDay(job.created_at), duration(job.duration_sec)]
          .filter(Boolean)
          .join(' · '),
      }
  }
}

interface Props {
  jobs: JobListItem[]
  activeId: string | null
  onOpen?: () => void
}

export function JobList({ jobs, activeId, onOpen }: Props) {
  const groups: { label: string; jobs: JobListItem[] }[] = []
  for (const job of jobs) {
    const label = dayLabel(job.created_at)
    const last = groups[groups.length - 1]
    if (last?.label === label) last.jobs.push(job)
    else groups.push({ label, jobs: [job] })
  }

  const open = (e: MouseEvent<HTMLAnchorElement>, id: string) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
    e.preventDefault()
    navigate(jobPath(id))
    onOpen?.()
  }

  return (
    <div className={styles.list}>
      {groups.map((g) => (
        <section key={g.label} className={styles.group} aria-label={g.label}>
          <h3 className={styles.groupTitle}>{g.label}</h3>
          <ul>
            {g.jobs.map((job) => {
              const m = meta(job)
              const active = job.id === activeId
              return (
                <li key={job.id}>
                  <a
                    href={jobPath(job.id)}
                    className={styles.item}
                    aria-current={active ? 'page' : undefined}
                    onClick={(e) => open(e, job.id)}
                  >
                    <span className={styles.text}>
                      <span className={styles.title}>{jobTitle(job)}</span>
                      <span
                        className={`${styles.meta} tabular`}
                        data-error={m.error || undefined}
                      >
                        {m.text}
                      </span>
                    </span>
                    {job.status === 'queued' && (
                      <ProgressRing value={null} queued />
                    )}
                    {job.status === 'running' && (
                      <ProgressRing
                        value={job.progress_pct > 0 ? job.progress_pct : null}
                      />
                    )}
                  </a>
                </li>
              )
            })}
          </ul>
        </section>
      ))}
    </div>
  )
}

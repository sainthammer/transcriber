import { useEffect, useState } from 'react'
import {
  Check,
  ChevronLeft,
  Copy,
  Download,
  Ellipsis,
  PanelLeft,
  Trash2,
} from 'lucide-react'
import { urls } from '../api/client'
import type { JobDetail } from '../api/types'
import { IconButton } from '../components/ui/Button'
import { Menu, MenuItem, MenuSeparator } from '../components/ui/Menu'
import styles from './JobScreen.module.css'

interface Props {
  job: JobDetail | null
  title: string
  showTitle: boolean
  layout: 'wide' | 'medium' | 'narrow'
  onBack: () => void
  onOpenSidebar: () => void
  onCopy: () => Promise<void>
  onDelete: () => void
}

export function JobHeader({
  job,
  title,
  showTitle,
  layout,
  onBack,
  onOpenSidebar,
  onCopy,
  onDelete,
}: Props) {
  const [copied, setCopied] = useState<'ok' | 'error' | null>(null)

  useEffect(() => {
    if (!copied) return
    const id = setTimeout(() => setCopied(null), 2000)
    return () => clearTimeout(id)
  }, [copied])

  const copy = async () => {
    try {
      await onCopy()
      setCopied('ok')
    } catch {
      setCopied('error')
    }
  }

  const done = job?.status === 'done'
  const hasSummary = !!job?.summary
  const hasTranscript = done && (job?.transcript.length ?? 0) > 0
  const processing = job?.status === 'queued' || job?.status === 'running'

  return (
    <header className={styles.header}>
      <div className={styles.headerStart}>
        {layout === 'narrow' && (
          <button type="button" className={styles.back} onClick={onBack}>
            <ChevronLeft size={24} strokeWidth={2} aria-hidden />
            <span>Записи</span>
          </button>
        )}
        {layout === 'medium' && (
          <IconButton label="Показать записи" onClick={onOpenSidebar}>
            <PanelLeft size={20} strokeWidth={1.75} />
          </IconButton>
        )}
      </div>

      <p
        className={styles.headerTitle}
        data-visible={showTitle || undefined}
        aria-hidden={!showTitle}
      >
        {title}
      </p>

      <div className={styles.headerEnd}>
        {hasSummary && (
          <IconButton
            label={
              copied === 'ok'
                ? 'Скопировано'
                : copied === 'error'
                  ? 'Не удалось скопировать'
                  : 'Скопировать итог'
            }
            onClick={copy}
            data-copied={copied === 'ok' || undefined}
          >
            {copied === 'ok' ? (
              <Check size={20} strokeWidth={2} />
            ) : (
              <Copy size={20} strokeWidth={1.75} />
            )}
          </IconButton>
        )}
        {job && (hasSummary || hasTranscript) && (
          <Menu
            trigger={
              <IconButton label="Скачать">
                <Download size={20} strokeWidth={1.75} />
              </IconButton>
            }
          >
            {hasSummary && (
              <>
                <MenuItem
                  href={urls.download(job.id, 'summary.docx')}
                  download
                  hint=".docx"
                >
                  Полный итог — Word
                </MenuItem>
                <MenuItem
                  href={urls.download(job.id, 'digest.docx')}
                  download
                  hint=".docx"
                >
                  Выжимка — Word
                </MenuItem>
                <MenuItem
                  href={urls.download(job.id, 'summary.md')}
                  download
                  hint=".md"
                >
                  Итог — Markdown
                </MenuItem>
                <MenuItem
                  href={urls.download(job.id, 'summary.json')}
                  download
                  hint=".json"
                >
                  Итог — JSON
                </MenuItem>
              </>
            )}
            {hasSummary && hasTranscript && <MenuSeparator />}
            {hasTranscript && (
              <MenuItem
                href={urls.download(job.id, 'transcript.txt')}
                download
                hint=".txt"
              >
                Расшифровка — текст
              </MenuItem>
            )}
          </Menu>
        )}
        {job && (
          <Menu
            trigger={
              <IconButton label="Ещё">
                <Ellipsis size={20} strokeWidth={1.75} />
              </IconButton>
            }
          >
            <MenuItem
              danger
              icon={<Trash2 size={16} strokeWidth={1.75} />}
              onSelect={onDelete}
            >
              {processing ? 'Отменить и удалить' : 'Удалить запись'}
            </MenuItem>
          </Menu>
        )}
      </div>
      <span className="visually-hidden" role="status">
        {copied === 'ok'
          ? 'Итог скопирован'
          : copied === 'error'
            ? 'Не удалось скопировать'
            : ''}
      </span>
    </header>
  )
}

import { useEffect, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { FileAudio, X } from 'lucide-react'
import { uploadJob } from '../api/client'
import type { Upload } from '../api/client'
import type { Config, Provider, SummaryTypeChoice } from '../api/types'
import { duration as fmtDuration, fileSize } from '../lib/format'
import { prefs } from '../lib/prefs'
import { Button, IconButton } from './ui/Button'
import { usableProvider, usableType } from '../lib/providers'
import { SummaryOptions } from './SummaryOptions'
import forms from './forms.module.css'
import styles from './NewJobDialog.module.css'

interface Props {
  file: File | null
  config: Config | null
  onClose: () => void
  onPickAnother: () => void
  onCreated: (id: string) => void
}

/** Duration from the browser's own decoder — only for formats it can read. */
function useFileDuration(file: File | null): number | null {
  const [value, setValue] = useState<{ file: File; seconds: number } | null>(null)
  useEffect(() => {
    if (!file) return
    const url = URL.createObjectURL(file)
    const media = document.createElement(file.type.startsWith('video/') ? 'video' : 'audio')
    media.preload = 'metadata'
    media.onloadedmetadata = () => {
      if (Number.isFinite(media.duration)) setValue({ file, seconds: media.duration })
      URL.revokeObjectURL(url)
    }
    media.onerror = () => URL.revokeObjectURL(url)
    media.src = url
    return () => {
      media.removeAttribute('src')
      URL.revokeObjectURL(url)
    }
  }, [file])
  return value && value.file === file ? value.seconds : null
}

export function NewJobDialog({ file, config, onClose, onPickAnother, onCreated }: Props) {
  const [saved] = useState(prefs.newJob)
  const [summary, setSummary] = useState(saved?.summary ?? true)
  const [provider, setProvider] = useState<Provider>(saved?.provider ?? 'auto')
  const [wantedType, setSummaryType] = useState<SummaryTypeChoice>(saved?.summaryType ?? 'auto')
  const summaryType = usableType(config, wantedType)
  const [progress, setProgress] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const upload = useRef<Upload | null>(null)
  const startRef = useRef<HTMLButtonElement>(null)
  const seconds = useFileDuration(file)

  const effectiveProvider = config ? usableProvider(config, provider) : null
  const summaryPossible = effectiveProvider !== null
  const summaryOn = summary && summaryPossible
  const uploading = progress !== null

  const [lastFile, setLastFile] = useState(file)
  if (file !== lastFile) {
    setLastFile(file)
    setError(null)
  }

  const start = async () => {
    if (!file || !config) return
    // Checked here too: the server rejects by Content-Length before reading the body, and
    // browsers often report that as a dropped connection rather than the 413.
    if (file.size > config.max_upload_bytes) {
      setError(`Файл больше ${Math.floor(config.max_upload_bytes / 1024 ** 3)} ГБ`)
      return
    }
    const options = {
      provider: effectiveProvider ?? 'auto',
      summary: summaryOn,
      summaryType,
    }
    prefs.saveNewJob({ ...options, summary })
    setError(null)
    setProgress(0)
    upload.current = uploadJob(file, options, setProgress)
    try {
      const { id } = await upload.current.promise
      onCreated(id)
    } catch (e) {
      const err = e as { status?: number; message: string }
      if (err.status !== -1) setError(err.message)
    } finally {
      upload.current = null
      setProgress(null)
    }
  }

  const close = () => {
    upload.current?.abort()
    onClose()
  }

  return (
    <Dialog.Root open={!!file} onOpenChange={(open) => !open && close()}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content
          className={styles.content}
          aria-describedby={undefined}
          onOpenAutoFocus={(e) => {
            // The default action gets focus, like a default button in a macOS sheet.
            e.preventDefault()
            startRef.current?.focus()
          }}
        >
          <header className={styles.header}>
            <Dialog.Title className={styles.title}>Новая запись</Dialog.Title>
            <Dialog.Close asChild>
              <IconButton label="Закрыть">
                <X size={20} strokeWidth={1.75} />
              </IconButton>
            </Dialog.Close>
          </header>

          {file && (
            <div className={styles.file}>
              <span className={styles.fileIcon} aria-hidden>
                <FileAudio size={22} strokeWidth={1.5} />
              </span>
              <span className={styles.fileText}>
                <span className={styles.fileName}>{file.name}</span>
                <span className={`${styles.fileMeta} tabular`}>
                  {fileSize(file.size)}
                  {seconds ? ` · ${fmtDuration(seconds)}` : ''}
                </span>
              </span>
              <Button variant="plain" onClick={onPickAnother} disabled={uploading}>
                Другой файл
              </Button>
            </div>
          )}

          <div className={styles.body}>
            <label className={forms.switchRow}>
              <span className={forms.switchText}>
                <span className={forms.switchTitle}>Итог</span>
                <span className={forms.hint}>
                  {summaryPossible || !config
                    ? 'Кратко, решения, задачи, цифры и ход обсуждения'
                    : 'Нет доступной модели — нужен ключ DeepSeek или работающая Ollama'}
                </span>
              </span>
              <input
                type="checkbox"
                role="switch"
                className={forms.switch}
                checked={summaryOn}
                onChange={(e) => setSummary(e.target.checked)}
                disabled={uploading || !summaryPossible}
              />
            </label>

            {summaryOn && config && effectiveProvider && (
              <div className={styles.summaryOptions}>
                <SummaryOptions
                  config={config}
                  provider={effectiveProvider}
                  onProvider={setProvider}
                  summaryType={summaryType}
                  onSummaryType={setSummaryType}
                />
              </div>
            )}
          </div>

          {error && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}

          <footer className={styles.footer}>
            {uploading ? (
              <div className={styles.upload} role="status">
                <div className={styles.uploadLabel}>
                  <span>{progress < 1 ? 'Загружаем файл' : 'Проверяем файл'}</span>
                  <span className="tabular">{Math.round(progress * 100)}%</span>
                </div>
                <div className={styles.bar}>
                  <div className={styles.barFill} style={{ transform: `scaleX(${progress})` }} />
                </div>
              </div>
            ) : (
              <Button variant="secondary" onClick={close}>
                Отмена
              </Button>
            )}
            {uploading ? (
              <Button variant="secondary" onClick={() => upload.current?.abort()}>
                Остановить
              </Button>
            ) : (
              <Button ref={startRef} variant="primary" onClick={start} disabled={!file || !config}>
                Расшифровать
              </Button>
            )}
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

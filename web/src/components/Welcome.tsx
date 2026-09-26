import { Upload } from 'lucide-react'
import type { Config } from '../api/types'
import { providerReason } from '../lib/providers'
import { useAuth } from '../state/authContext'
import { Button } from './ui/Button'
import styles from './Welcome.module.css'

interface Props {
  config: Config | null
  onPick: () => void
  /** first: nothing uploaded yet, the whole window is the drop zone. */
  variant: 'first' | 'home'
}

export function Welcome({ config, onPick, variant }: Props) {
  const first = variant === 'first'
  const { isAdmin } = useAuth()
  return (
    <div className={styles.wrap} data-variant={variant}>
      <div className={styles.zone}>
        <div className={styles.hero}>
          <span className={styles.glyph} aria-hidden>
            <Upload size={28} strokeWidth={1.5} />
          </span>
          <h1 className={styles.title}>
            {first ? 'Расшифровка встреч' : 'Новая запись'}
          </h1>
          <p className={styles.lead}>
            Перетащите аудио или видео в окно — распознаем речь, расставим знаки
            препинания и подведём итог: решения, задачи, ключевые цифры.
          </p>
          <Button variant="primary" size="large" onClick={onPick}>
            Выбрать файл
          </Button>
          <p className={styles.formats}>MP3, M4A, WAV, OGG, MP4 и другие</p>
        </div>

        <section className={styles.status} aria-labelledby="where-heading">
          <h2 id="where-heading" className={styles.statusTitle}>
            Где обрабатывается
          </h2>
          <ul className={styles.rows}>
            <li className={styles.row}>
              <span className={styles.dot} data-ok="" aria-hidden />
              <span>
                <span className={styles.rowTitle}>Распознавание речи</span>
                <span className={styles.rowText}>Локально через Whisper</span>
              </span>
            </li>
            <ProviderRow
              title="Итог локально"
              okText={config ? `Локальный ИИ — готов` : '…'}
              reason={
                config
                  ? providerReason('ollama', config.providers.ollama, isAdmin)
                  : null
              }
              loading={!config}
            />
            <ProviderRow
              title="Итог через DeepSeek"
              okText={config ? `DeepSeek — готов` : '…'}
              reason={
                config
                  ? providerReason(
                      'deepseek',
                      config.providers.deepseek,
                      isAdmin
                    )
                  : null
              }
              loading={!config}
            />
          </ul>
          <p className={styles.privacy}>
            Аудио и расшифровка остаются в закрытом контуре. Если итог делает
            DeepSeek, текст расшифровки отправляется на серверы DeepSeek.
          </p>
        </section>
      </div>
    </div>
  )
}

function ProviderRow(props: {
  title: string
  okText: string
  reason: string | null
  loading: boolean
}) {
  const ok = !props.loading && !props.reason
  return (
    <li className={styles.row}>
      <span className={styles.dot} data-ok={ok ? '' : undefined} aria-hidden />
      <span>
        <span className={styles.rowTitle}>{props.title}</span>
        <span className={styles.rowText}>{props.reason ?? props.okText}</span>
      </span>
    </li>
  )
}

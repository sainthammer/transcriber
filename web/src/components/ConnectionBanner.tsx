import { WifiOff } from 'lucide-react'
import styles from './ConnectionBanner.module.css'

export function ConnectionBanner({ lost }: { lost: boolean }) {
  return (
    <div className={styles.region} role="status" aria-live="polite">
      {lost && (
        <div className={styles.banner}>
          <WifiOff size={16} strokeWidth={1.75} aria-hidden />
          <span>Нет связи с сервером — переподключаемся.</span>
        </div>
      )}
    </div>
  )
}

import { useEffect } from 'react'
import styles from './Toast.module.css'

interface Props {
  message: string | null
  action?: { label: string; onClick: () => void }
  duration: number
  onClose: () => void
}

export function Toast({ message, action, duration, onClose }: Props) {
  useEffect(() => {
    if (!message) return
    const id = setTimeout(onClose, duration)
    return () => clearTimeout(id)
  }, [message, duration, onClose])

  return (
    <div className={styles.region} role="status" aria-live="polite">
      {message && (
        <div className={styles.toast}>
          <span className={styles.message}>{message}</span>
          {action && (
            <button type="button" className={styles.action} onClick={action.onClick}>
              {action.label}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

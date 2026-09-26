import styles from './ProgressRing.module.css'

interface Props {
  /** 0–100; null draws an indeterminate spinning arc (queued or loading models). */
  value: number | null
  size?: number
  queued?: boolean
}

export function ProgressRing({ value, size = 20, queued }: Props) {
  const stroke = 2.25
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const offset = value == null ? c * 0.72 : c * (1 - Math.max(0.03, value / 100))
  return (
    <svg
      className={styles.ring}
      data-indeterminate={value == null && !queued ? '' : undefined}
      data-queued={queued ? '' : undefined}
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      aria-hidden
    >
      <circle className={styles.track} cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} />
      {!queued && (
        <circle
          className={styles.value}
          cx={size / 2}
          cy={size / 2}
          r={r}
          strokeWidth={stroke}
          strokeDasharray={c}
          strokeDashoffset={offset}
        />
      )}
    </svg>
  )
}

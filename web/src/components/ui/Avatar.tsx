import styles from './Avatar.module.css'

/** Initials from "Анна Королёва" → "АК", from an email → first letter. */
export function initials(name: string, email: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase()
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return email.slice(0, 1).toUpperCase()
}

interface Props {
  name: string
  email: string
  size?: 'small' | 'large'
  muted?: boolean
}

export function Avatar({ name, email, size = 'small', muted }: Props) {
  return (
    <span className={styles.avatar} data-size={size} data-muted={muted || undefined} aria-hidden>
      {initials(name, email)}
    </span>
  )
}

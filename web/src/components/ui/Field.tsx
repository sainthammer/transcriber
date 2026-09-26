import { cloneElement, isValidElement, useId } from 'react'
import type { ReactElement, ReactNode } from 'react'
import styles from '../forms.module.css'

interface Props {
  label: ReactNode
  hint?: ReactNode
  error?: string | null
  /** Extra content on the label line, e.g. where a value comes from. */
  aside?: ReactNode
  className?: string
  /** The control; gets id, aria-describedby and aria-invalid. */
  children: ReactElement<Record<string, unknown>>
}

/** Label, control, hint and error wired together for assistive tech. */
export function Field({ label, hint, error, aside, className, children }: Props) {
  const id = useId()
  const hintId = hint ? `${id}-hint` : undefined
  const errorId = error ? `${id}-error` : undefined
  const describedBy = [errorId, hintId].filter(Boolean).join(' ') || undefined
  const control = isValidElement(children)
    ? cloneElement(children, {
        id: (children.props.id as string | undefined) ?? id,
        'aria-describedby': describedBy,
        'aria-invalid': error ? true : undefined,
      })
    : children
  const controlId = (children.props.id as string | undefined) ?? id

  return (
    <div className={[styles.field, className].filter(Boolean).join(' ')}>
      <div className={styles.labelRow}>
        <label className={styles.label} htmlFor={controlId}>
          {label}
        </label>
        {aside}
      </div>
      {control}
      {error && (
        <p className={styles.error} id={errorId}>
          {error}
        </p>
      )}
      {hint && (
        <p className={styles.hint} id={hintId}>
          {hint}
        </p>
      )}
    </div>
  )
}

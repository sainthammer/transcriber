import { useId } from 'react'
import styles from '../forms.module.css'

interface Option<T extends string> {
  value: T
  label: string
  disabled?: boolean
}

interface Props<T extends string> {
  /** Visible legend; pass `hideLegend` when a heading nearby already names it. */
  legend: string
  hideLegend?: boolean
  options: Option<T>[]
  value: T
  onChange: (value: T) => void
  disabled?: boolean
  className?: string
}

/** Segmented control built from native radios: arrow keys and forms work as usual. */
export function Segmented<T extends string>({
  legend,
  hideLegend,
  options,
  value,
  onChange,
  disabled,
  className,
}: Props<T>) {
  const name = useId()
  return (
    <fieldset className={[styles.field, className].filter(Boolean).join(' ')} disabled={disabled}>
      <legend className={hideLegend ? 'visually-hidden' : styles.label}>{legend}</legend>
      <div className={styles.segmented}>
        {options.map((o) => {
          const off = disabled || o.disabled
          return (
            <label key={o.value} className={styles.segment} data-disabled={off || undefined}>
              <input
                type="radio"
                className="visually-hidden"
                name={name}
                value={o.value}
                checked={value === o.value}
                disabled={o.disabled}
                onChange={() => onChange(o.value)}
              />
              <span>{o.label}</span>
            </label>
          )
        })}
      </div>
    </fieldset>
  )
}

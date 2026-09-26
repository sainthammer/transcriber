import { INSTRUCTIONS_MAX } from '../api/types'
import { Field } from '../components/ui/Field'
import forms from '../components/forms.module.css'
import styles from './InstructionsField.module.css'

interface Props {
  value: string
  onChange: (value: string) => void
  error?: string | null
}

/** Optional wishes for the model when a summary is made again. */
export function InstructionsField({ value, onChange, error }: Props) {
  const left = INSTRUCTIONS_MAX - value.length
  return (
    <Field
      label="Что поправить"
      error={error}
      hint="Необязательно. Например: «подробнее про сроки», «Анна — заказчик, Олег — подрядчик»."
      aside={
        value.length > 0 && (
          <span
            className={`${styles.counter} tabular`}
            data-low={left <= 100 || undefined}
            aria-live={left <= 100 ? 'polite' : undefined}
          >
            {value.length} / {INSTRUCTIONS_MAX}
          </span>
        )
      }
    >
      <textarea
        className={`${forms.textarea} ${styles.textarea}`}
        rows={3}
        maxLength={INSTRUCTIONS_MAX}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </Field>
  )
}

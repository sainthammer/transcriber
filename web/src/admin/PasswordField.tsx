import { forwardRef, useState } from 'react'
import { Check, Copy, Dices } from 'lucide-react'
import { MIN_PASSWORD } from '../components/ChangePasswordDialog'
import { IconButton } from '../components/ui/Button'
import { Field } from '../components/ui/Field'
import { PasswordInput } from '../components/ui/PasswordInput'
import { generatePassword } from './password'
import styles from './PasswordField.module.css'

interface Props {
  label: string
  value: string
  onChange: (value: string) => void
  error?: string | null
}

/** A password the admin sets for someone else: generate, see it, copy it to pass on. */
export const PasswordField = forwardRef<HTMLInputElement, Props>(function PasswordField(
  { label, value, onChange, error },
  ref,
) {
  const [revealed, setRevealed] = useState(false)
  const [copied, setCopied] = useState(false)

  const generate = () => {
    onChange(generatePassword())
    setRevealed(true)
    setCopied(false)
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setRevealed(true)
    }
  }

  return (
    <Field
      label={label}
      error={error}
      hint={
        <span className={styles.hint}>
          <span>Не короче {MIN_PASSWORD} символов. Передайте пароль пользователю — сменить его он сможет сам.</span>
          {value && (
            <button type="button" className={styles.copy} onClick={copy} aria-live="polite">
              {copied ? <Check size={14} strokeWidth={2} aria-hidden /> : <Copy size={14} strokeWidth={1.75} aria-hidden />}
              {copied ? 'Скопирован' : 'Скопировать'}
            </button>
          )}
        </span>
      }
    >
      <PasswordInput
        ref={ref}
        autoComplete="new-password"
        className={revealed ? styles.mono : undefined}
        value={value}
        onChange={(e) => {
          onChange(e.target.value)
          setCopied(false)
        }}
        revealed={revealed}
        onRevealedChange={setRevealed}
        extra={
          <IconButton label="Сгенерировать пароль" onClick={generate}>
            <Dices size={18} strokeWidth={1.75} />
          </IconButton>
        }
      />
    </Field>
  )
})

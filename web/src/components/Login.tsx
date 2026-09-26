import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { AlertCircle, Clock } from 'lucide-react'
import { api, ApiError } from '../api/client'
import type { User } from '../api/types'
import { AppMark } from './AppMark'
import { Button } from './ui/Button'
import { Field } from './ui/Field'
import { PasswordInput } from './ui/PasswordInput'
import forms from './forms.module.css'
import styles from './Login.module.css'

interface Props {
  /** The session ended while the app was open. */
  expired: boolean
  onSignedIn: (user: User) => void
}

export function Login({ expired, onSignedIn }: Props) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ status: number; message: string } | null>(null)
  const [missing, setMissing] = useState<{ email?: boolean; password?: boolean }>({})
  const emailRef = useRef<HTMLInputElement>(null)
  const passwordRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    document.title = 'Вход — Расшифровки'
  }, [])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const empty = { email: !email.trim(), password: !password }
    setMissing(empty)
    if (empty.email) return emailRef.current?.focus()
    if (empty.password) return passwordRef.current?.focus()
    setBusy(true)
    setError(null)
    try {
      onSignedIn(await api.login(email.trim(), password))
    } catch (err) {
      const e = err as ApiError
      setError({ status: e.status, message: loginError(e) })
      setBusy(false)
      if (e.status === 401) {
        requestAnimationFrame(() => passwordRef.current?.select())
      }
    }
  }

  const limited = error?.status === 429

  return (
    <main className={styles.screen}>
      <form className={styles.form} onSubmit={submit} noValidate aria-describedby="login-lead">
        <div className={styles.mark}>
          <AppMark />
        </div>
        <h1 className={styles.title}>Расшифровки встреч</h1>
        <p className={styles.lead} id="login-lead">
          {expired ? 'Сессия закончилась — войдите снова, чтобы продолжить.' : 'Войдите, чтобы открыть свои записи.'}
        </p>

        <div className={styles.fields}>
          <Field label="Email" error={missing.email ? 'Введите email' : null}>
            <input
              ref={emailRef}
              className={forms.input}
              type="email"
              inputMode="email"
              autoComplete="username"
              autoCapitalize="off"
              spellCheck={false}
              autoFocus
              value={email}
              onChange={(e) => {
                setEmail(e.target.value)
                setMissing((m) => ({ ...m, email: false }))
              }}
            />
          </Field>
          <Field label="Пароль" error={missing.password ? 'Введите пароль' : null}>
            <PasswordInput
              ref={passwordRef}
              autoComplete="current-password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value)
                setMissing((m) => ({ ...m, password: false }))
              }}
            />
          </Field>
        </div>

        <div className={styles.alertSlot} aria-live="polite">
          {error && (
            <p className={forms.alert} role="alert">
              {limited ? (
                <Clock size={16} strokeWidth={1.75} aria-hidden />
              ) : (
                <AlertCircle size={16} strokeWidth={1.75} aria-hidden />
              )}
              <span>{error.message}</span>
            </p>
          )}
        </div>

        <Button type="submit" variant="primary" size="large" loading={busy} className={styles.submit}>
          Войти
        </Button>

        <p className={styles.footnote}>
          Учётные записи создаёт администратор. Если забыли пароль — попросите его задать новый.
        </p>
      </form>
    </main>
  )
}

const FALLBACK: Record<number, string> = {
  401: 'Неверный email или пароль',
  403: 'Учётная запись отключена — обратитесь к администратору',
  429: 'Слишком много попыток входа. Подождите немного и попробуйте снова.',
}

/** The server's wording when it sends one, otherwise a plain explanation by status. */
function loginError(e: ApiError): string {
  const generic = e.message.startsWith('Сервер ответил ошибкой')
  return (generic && FALLBACK[e.status]) || e.message
}

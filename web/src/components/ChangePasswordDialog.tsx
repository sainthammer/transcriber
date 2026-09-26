import { useRef, useState } from 'react'
import { AlertCircle } from 'lucide-react'
import { api } from '../api/client'
import type { ApiError } from '../api/client'
import { useAuth } from '../state/authContext'
import { useToast } from '../state/toastContext'
import { Button } from './ui/Button'
import { Field } from './ui/Field'
import { PasswordInput } from './ui/PasswordInput'
import { Sheet } from './ui/Sheet'
import forms from './forms.module.css'

export const MIN_PASSWORD = 8

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
}

type Errors = Partial<Record<'current' | 'next' | 'repeat' | 'form', string>>

export function ChangePasswordDialog({ open, onOpenChange }: Props) {
  const { user } = useAuth()
  const toast = useToast()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [repeat, setRepeat] = useState('')
  const [errors, setErrors] = useState<Errors>({})
  const [busy, setBusy] = useState(false)
  const currentRef = useRef<HTMLInputElement>(null)
  const nextRef = useRef<HTMLInputElement>(null)
  const repeatRef = useRef<HTMLInputElement>(null)

  const reset = () => {
    setCurrent('')
    setNext('')
    setRepeat('')
    setErrors({})
    setBusy(false)
  }

  const change = (o: boolean) => {
    if (busy) return
    if (!o) reset()
    onOpenChange(o)
  }

  const validate = (): Errors => {
    const e: Errors = {}
    if (!current) e.current = 'Введите текущий пароль'
    if (next.length < MIN_PASSWORD) e.next = `Не короче ${MIN_PASSWORD} символов`
    else if (next === current) e.next = 'Новый пароль совпадает с текущим'
    if (!e.next && repeat !== next) e.repeat = 'Пароли не совпадают'
    return e
  }

  const submit = async () => {
    const e = validate()
    setErrors(e)
    if (e.current) return currentRef.current?.focus()
    if (e.next) return nextRef.current?.focus()
    if (e.repeat) return repeatRef.current?.focus()
    setBusy(true)
    try {
      await api.changePassword(current, next)
      reset()
      onOpenChange(false)
      toast('Пароль изменён')
    } catch (err) {
      const error = err as ApiError
      setBusy(false)
      if (error.status === 400) {
        setErrors({ current: error.message || 'Текущий пароль указан неверно' })
        requestAnimationFrame(() => currentRef.current?.select())
      } else if (error.status === 422) {
        setErrors({ next: error.fields.new_password ?? error.message })
        nextRef.current?.focus()
      } else {
        setErrors({ form: error.message })
      }
    }
  }

  return (
    <Sheet
      open={open}
      onOpenChange={change}
      title="Смена пароля"
      description="На других устройствах придётся войти заново."
      width="narrow"
      onSubmit={submit}
      footer={
        <>
          <Button variant="secondary" onClick={() => change(false)} disabled={busy}>
            Отмена
          </Button>
          <Button type="submit" variant="primary" loading={busy}>
            Сменить
          </Button>
        </>
      }
    >
      {/* For password managers: which account this password belongs to. */}
      <input type="text" autoComplete="username" value={user.email} readOnly hidden />
      <Field label="Текущий пароль" error={errors.current}>
        <PasswordInput
          ref={currentRef}
          autoComplete="current-password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
        />
      </Field>
      <Field label="Новый пароль" error={errors.next} hint={errors.next ? undefined : `Не короче ${MIN_PASSWORD} символов`}>
        <PasswordInput
          ref={nextRef}
          autoComplete="new-password"
          minLength={MIN_PASSWORD}
          value={next}
          onChange={(e) => setNext(e.target.value)}
        />
      </Field>
      <Field label="Повторите новый пароль" error={errors.repeat}>
        <PasswordInput
          ref={repeatRef}
          autoComplete="new-password"
          value={repeat}
          onChange={(e) => setRepeat(e.target.value)}
        />
      </Field>
      {errors.form && (
        <p className={forms.alert} role="alert">
          <AlertCircle size={16} strokeWidth={1.75} aria-hidden />
          <span>{errors.form}</span>
        </p>
      )}
    </Sheet>
  )
}

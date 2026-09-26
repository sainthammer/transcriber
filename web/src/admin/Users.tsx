import { useMemo, useRef, useState } from 'react'
import { AlertCircle, ChevronRight, Plus, Search } from 'lucide-react'
import { admin } from '../api/client'
import type { ApiError } from '../api/client'
import type { AdminUser, Role } from '../api/types'
import { Avatar } from '../components/ui/Avatar'
import { Button } from '../components/ui/Button'
import { Field } from '../components/ui/Field'
import { Link } from '../components/ui/Link'
import { Segmented } from '../components/ui/Segmented'
import { Sheet } from '../components/ui/Sheet'
import { MIN_PASSWORD } from '../components/ChangePasswordDialog'
import { useMediaQuery } from '../lib/hooks'
import { plural } from '../lib/format'
import { userPath } from '../lib/router'
import { useToast } from '../state/toastContext'
import { ADMIN_HINT, audio, compact, lastSeen, ROLE_LABEL } from './format'
import { LoadError, Loading, Page } from './Page'
import { PasswordField } from './PasswordField'
import { useResource } from './useResource'
import forms from '../components/forms.module.css'
import ui from './admin.module.css'

const byName = (a: AdminUser, b: AdminUser) =>
  Number(b.is_active) - Number(a.is_active) || (a.name || a.email).localeCompare(b.name || b.email, 'ru')

export function Users() {
  const { data, error, reload, setData } = useResource('users', admin.users)
  const [creating, setCreating] = useState(false)
  const [query, setQuery] = useState('')
  const table = useMediaQuery('(min-width: 768px)')

  const users = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (data ?? [])
      .filter((u) => !q || u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q))
      .sort(byName)
  }, [data, query])

  const active = data?.filter((u) => u.is_active).length ?? 0
  const inactive = (data?.length ?? 0) - active
  const subtitle =
    data &&
    [
      `${active} ${plural(active, ['активный', 'активных', 'активных'])}`,
      inactive > 0 && `${inactive} ${plural(inactive, ['отключён', 'отключены', 'отключены'])}`,
    ]
      .filter(Boolean)
      .join(' · ')

  return (
    <Page
      title="Пользователи"
      subtitle={subtitle}
      actions={
        <Button variant="primary" icon={<Plus size={18} strokeWidth={2} />} onClick={() => setCreating(true)}>
          Новый пользователь
        </Button>
      }
    >
      {error && !data ? (
        <LoadError error={error} onRetry={reload} />
      ) : !data ? (
        <Loading />
      ) : (
        <>
          {data.length > 6 && (
            <div className={ui.search}>
              <Search size={16} strokeWidth={1.75} aria-hidden />
              <input
                className={forms.input}
                type="search"
                placeholder="Имя или email"
                aria-label="Поиск пользователей"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
          )}
          {users.length === 0 ? (
            <p className={ui.empty}>{query ? 'Никого не нашли' : 'Пользователей пока нет'}</p>
          ) : table ? (
            <UsersTable users={users} />
          ) : (
            <UsersList users={users} />
          )}
        </>
      )}

      <NewUserDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={(user) => setData((prev) => [...prev, user])}
      />
    </Page>
  )
}

function Status({ user }: { user: AdminUser }) {
  return (
    <>
      {user.role === 'admin' && (
        <span className={ui.badge} data-tone="accent">
          Админ
        </span>
      )}
      {!user.is_active && <span className={ui.badge}>Отключён</span>}
    </>
  )
}

function UsersTable({ users }: { users: AdminUser[] }) {
  return (
    <div className={ui.tableWrap}>
      <table className={ui.table}>
        <thead>
          <tr>
            <th scope="col">Пользователь</th>
            <th scope="col">Последний вход</th>
            <th scope="col" className={ui.num}>
              Записи
            </th>
            <th scope="col" className={ui.num}>
              Аудио
            </th>
            <th scope="col" className={ui.num}>
              Токены
            </th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id} data-link="" data-inactive={!u.is_active || undefined}>
              <td>
                <span className={ui.person}>
                  <Avatar name={u.name} email={u.email} muted={!u.is_active} />
                  <span className={ui.personText}>
                    <span className={ui.personName}>
                      <Link href={userPath(u.id)} className={ui.rowLink}>
                        {u.name || u.email}
                      </Link>
                      <Status user={u} />
                    </span>
                    {u.name && <span className={ui.personEmail}>{u.email}</span>}
                  </span>
                </span>
              </td>
              <td className={ui.muted}>{lastSeen(u.last_login_at)}</td>
              <td className={ui.num}>{u.jobs_count || '—'}</td>
              <td className={ui.num}>{audio(u.audio_sec)}</td>
              <td className={ui.num}>{u.tokens_total ? compact(u.tokens_total) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function UsersList({ users }: { users: AdminUser[] }) {
  return (
    <ul className={ui.group}>
      {users.map((u) => (
        <li key={u.id}>
          <Link href={userPath(u.id)} className={ui.linkRow}>
            <Avatar name={u.name} email={u.email} muted={!u.is_active} />
            <span className={ui.linkText}>
              <span className={ui.linkTitle}>
                <span>{u.name || u.email}</span>
                <Status user={u} />
              </span>
              <span className={`${ui.linkMeta} tabular`}>
                {[
                  u.name ? u.email : null,
                  `${u.jobs_count} ${plural(u.jobs_count, ['запись', 'записи', 'записей'])}`,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </span>
            <ChevronRight size={18} strokeWidth={2} className={ui.chevron} aria-hidden />
          </Link>
        </li>
      ))}
    </ul>
  )
}

// --- Create ---

type Errors = Partial<Record<'email' | 'name' | 'password' | 'form', string>>

function NewUserDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (user: AdminUser) => void
}) {
  const toast = useToast()
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState<Role>('user')
  const [errors, setErrors] = useState<Errors>({})
  const [busy, setBusy] = useState(false)
  const emailRef = useRef<HTMLInputElement>(null)
  const nameRef = useRef<HTMLInputElement>(null)
  const passwordRef = useRef<HTMLInputElement>(null)

  const reset = () => {
    setEmail('')
    setName('')
    setPassword('')
    setRole('user')
    setErrors({})
  }

  const change = (o: boolean) => {
    if (busy) return
    if (!o) reset()
    onOpenChange(o)
  }

  const submit = async () => {
    const e: Errors = {}
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) e.email = 'Введите email, например anna@example.com'
    if (!name.trim()) e.name = 'Как к человеку обращаться в интерфейсе'
    if (password.length < MIN_PASSWORD) e.password = `Не короче ${MIN_PASSWORD} символов`
    setErrors(e)
    if (e.email) return emailRef.current?.focus()
    if (e.name) return nameRef.current?.focus()
    if (e.password) return passwordRef.current?.focus()

    setBusy(true)
    try {
      const user = await admin.createUser({ email: email.trim(), name: name.trim(), password, role })
      onCreated(user)
      setBusy(false)
      reset()
      onOpenChange(false)
      toast(`${user.name || user.email} — учётная запись создана`)
    } catch (err) {
      const error = err as ApiError
      setBusy(false)
      if (error.status === 409) {
        setErrors({ email: error.message || 'Этот email уже занят' })
        emailRef.current?.select()
      } else if (error.status === 422 && Object.keys(error.fields).length) {
        setErrors({
          email: error.fields.email,
          name: error.fields.name,
          password: error.fields.password,
          form: error.fields.role,
        })
      } else {
        setErrors({ form: error.message })
      }
    }
  }

  return (
    <Sheet
      open={open}
      onOpenChange={change}
      title="Новый пользователь"
      onSubmit={submit}
      initialFocus={emailRef}
      footer={
        <>
          <Button variant="secondary" onClick={() => change(false)} disabled={busy}>
            Отмена
          </Button>
          <Button type="submit" variant="primary" loading={busy}>
            Создать
          </Button>
        </>
      }
    >
      <Field label="Email" error={errors.email} hint="По нему пользователь входит">
        <input
          ref={emailRef}
          className={forms.input}
          type="email"
          inputMode="email"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </Field>
      <Field label="Имя" error={errors.name}>
        <input
          ref={nameRef}
          className={forms.input}
          autoComplete="off"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
      <PasswordField ref={passwordRef} label="Пароль" value={password} onChange={setPassword} error={errors.password} />
      <Segmented
        legend="Роль"
        value={role}
        onChange={setRole}
        options={[
          { value: 'user', label: ROLE_LABEL.user },
          { value: 'admin', label: ROLE_LABEL.admin },
        ]}
      />
      {role === 'admin' && <p className={forms.hint}>{ADMIN_HINT}</p>}
      {errors.form && (
        <p className={forms.alert} role="alert">
          <AlertCircle size={16} strokeWidth={1.75} aria-hidden />
          <span>{errors.form}</span>
        </p>
      )}
    </Sheet>
  )
}

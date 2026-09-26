import { useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Lock } from 'lucide-react'
import { admin } from '../api/client'
import type { ApiError } from '../api/client'
import type { AdminJob, AdminUser, JobStatus, Role, UserPatch } from '../api/types'
import { MIN_PASSWORD } from '../components/ChangePasswordDialog'
import { Avatar } from '../components/ui/Avatar'
import { Button } from '../components/ui/Button'
import { Segmented } from '../components/ui/Segmented'
import { Sheet } from '../components/ui/Sheet'
import { dateTime, duration } from '../lib/format'
import { useMediaQuery } from '../lib/hooks'
import { useAuth } from '../state/authContext'
import { useToast } from '../state/toastContext'
import { ADMIN_HINT, audio, compact, date, lastSeen, providerName, ROLE_LABEL } from './format'
import { LoadError, Loading, Page, Section } from './Page'
import { PasswordField } from './PasswordField'
import { useResource } from './useResource'
import forms from '../components/forms.module.css'
import ui from './admin.module.css'
import styles from './UserCard.module.css'

export function UserCard({ id }: { id: number }) {
  const users = useResource('users', admin.users)
  const user = users.data?.find((u) => u.id === id) ?? null
  const back = { href: '/admin/users', label: 'Пользователи' }

  if (users.error && !users.data) {
    return (
      <Page title="Пользователь" back={back}>
        <LoadError error={users.error} onRetry={users.reload} />
      </Page>
    )
  }
  if (!users.data) {
    return (
      <Page title="" back={back}>
        <Loading />
      </Page>
    )
  }
  if (!user) {
    return (
      <Page title="Пользователь не найден" back={back}>
        <p className={ui.empty}>Возможно, ссылка устарела.</p>
      </Page>
    )
  }
  return (
    <Profile
      user={user}
      back={back}
      onChange={(next) => users.setData((prev) => prev.map((u) => (u.id === next.id ? next : u)))}
    />
  )
}

function Profile({
  user,
  back,
  onChange,
}: {
  user: AdminUser
  back: { href: string; label: string }
  onChange: (user: AdminUser) => void
}) {
  const auth = useAuth()
  const toast = useToast()
  const self = auth.user.id === user.id
  const [pending, setPending] = useState<keyof UserPatch | null>(null)
  const [passwordOpen, setPasswordOpen] = useState(false)

  /** Toggles apply at once; on failure the control returns to the server's value. */
  const patch = async (change: UserPatch, field: keyof UserPatch) => {
    setPending(field)
    try {
      const next = await admin.updateUser(user.id, change)
      onChange(next)
      if (self) auth.setUser({ id: next.id, email: next.email, name: next.name, role: next.role })
      return true
    } catch (e) {
      toast((e as ApiError).message)
      return false
    } finally {
      setPending(null)
    }
  }

  const selfHint = 'Это вы. Свою роль и доступ может изменить только другой администратор.'

  return (
    <Page
      title={user.name || user.email}
      back={back}
      lead={<Avatar name={user.name} email={user.email} size="large" muted={!user.is_active} />}
      subtitle={
        <span className={styles.subtitle}>
          <span>{user.email}</span>
          {user.role === 'admin' && (
            <span className={ui.badge} data-tone="accent">
              {ROLE_LABEL.admin}
            </span>
          )}
          {!user.is_active && <span className={ui.badge}>Отключён</span>}
          {self && <span className={ui.badge}>Это вы</span>}
        </span>
      }
    >
      <dl className={ui.stats}>
        <Stat label="Записей" value={String(user.jobs_count)} />
        <Stat label="Аудио" value={audio(user.audio_sec)} />
        <Stat label="Токенов" value={user.tokens_total ? compact(user.tokens_total) : '—'} />
        <Stat label="Последний вход" value={lastSeen(user.last_login_at)} small />
      </dl>

      <Section title="Учётная запись" description={`Создана ${date(user.created_at)}`}>
        <div className={ui.group}>
          <NameRow user={user} busy={pending === 'name'} onSave={(name) => patch({ name }, 'name')} />

          <div className={ui.row}>
            <span className={ui.rowLabel}>
              <span className={ui.rowTitle} id="role-label">
                Роль
              </span>
              <span className={ui.rowHint}>{self ? selfHint : ADMIN_HINT}</span>
            </span>
            <span className={ui.rowControl}>
              <Segmented<Role>
                legend="Роль"
                hideLegend
                className={styles.role}
                value={user.role}
                disabled={self || pending === 'role'}
                onChange={(role) => void patch({ role }, 'role')}
                options={[
                  { value: 'user', label: ROLE_LABEL.user },
                  { value: 'admin', label: ROLE_LABEL.admin },
                ]}
              />
            </span>
          </div>

          <label className={ui.row} data-disabled={self || undefined}>
            <span className={ui.rowLabel}>
              <span className={ui.rowTitle}>Может входить</span>
              <span className={ui.rowHint}>
                {self
                  ? selfHint
                  : user.is_active
                    ? 'Если отключить, пользователь сразу выйдет и не сможет войти. Записи сохранятся.'
                    : 'Отключён: войти не может, записи сохранены.'}
              </span>
            </span>
            <span className={ui.rowControl}>
              <input
                type="checkbox"
                role="switch"
                className={forms.switch}
                checked={user.is_active}
                disabled={self || pending === 'is_active'}
                onChange={(e) => void patch({ is_active: e.target.checked }, 'is_active')}
              />
            </span>
          </label>

          <div className={ui.row}>
            <span className={ui.rowLabel}>
              <span className={ui.rowTitle}>Пароль</span>
              <span className={ui.rowHint}>
                {self ? 'Свой пароль меняйте в меню учётной записи.' : 'Задайте новый, если пользователь забыл свой.'}
              </span>
            </span>
            <span className={ui.rowControl}>
              <Button variant="secondary" onClick={() => setPasswordOpen(true)} disabled={self}>
                Задать новый…
              </Button>
            </span>
          </div>
        </div>
      </Section>

      <Jobs user={user} />

      <ResetPasswordDialog
        user={user}
        open={passwordOpen}
        onOpenChange={setPasswordOpen}
        onSave={(password) => patch({ password }, 'password')}
      />
    </Page>
  )
}

function Stat({ label, value, small }: { label: string; value: string; small?: boolean }) {
  return (
    <div className={ui.stat}>
      <dt className={ui.statLabel}>{label}</dt>
      <dd className={ui.statValue} data-small={small || undefined}>
        {value}
      </dd>
    </div>
  )
}

function NameRow({
  user,
  busy,
  onSave,
}: {
  user: AdminUser
  busy: boolean
  onSave: (name: string) => Promise<boolean>
}) {
  const [name, setName] = useState(user.name)
  const [base, setBase] = useState(user.name)
  if (user.name !== base) {
    setBase(user.name)
    setName(user.name)
  }
  const dirty = name.trim() !== user.name
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!dirty || !name.trim()) return
    await onSave(name.trim())
  }
  return (
    <form className={ui.row} onSubmit={submit}>
      <label className={ui.rowLabel} htmlFor="user-name">
        <span className={ui.rowTitle}>Имя</span>
        <span className={ui.rowHint}>Так пользователь подписан в интерфейсе</span>
      </label>
      <span className={`${ui.rowControl} ${styles.nameControl}`}>
        <input
          id="user-name"
          className={`${forms.input} ${styles.nameInput}`}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && setName(user.name)}
          autoComplete="off"
        />
        {dirty && (
          <Button type="submit" variant="primary" loading={busy} disabled={!name.trim()} className={styles.appear}>
            Сохранить
          </Button>
        )}
      </span>
    </form>
  )
}

// --- Recordings: metadata only ---

const STATUS: Record<JobStatus, string> = {
  done: 'Готово',
  error: 'Ошибка',
  running: 'Обрабатывается',
  queued: 'В очереди',
}

function Jobs({ user }: { user: AdminUser }) {
  const jobs = useResource(`user-jobs-${user.id}`, () => admin.userJobs(user.id))
  const types = useResource('types', admin.types)
  const table = useMediaQuery('(min-width: 768px)')
  const typeLabel = (id: string | null) => (id ? (types.data?.find((t) => t.id === id)?.label ?? id) : '—')

  return (
    <Section title="Записи" id="jobs">
      <p className={ui.note}>
        <Lock size={14} strokeWidth={1.75} aria-hidden />
        Расшифровки и итоги видит только сам пользователь — здесь только сведения о файлах.
      </p>
      {jobs.error && !jobs.data ? (
        <LoadError error={jobs.error} onRetry={jobs.reload} />
      ) : !jobs.data ? (
        <Loading />
      ) : jobs.data.length === 0 ? (
        <p className={ui.empty}>Записей пока нет</p>
      ) : table ? (
        <div className={ui.tableWrap}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th scope="col">Файл</th>
                <th scope="col">Загружен</th>
                <th scope="col" className={ui.num}>
                  Длительность
                </th>
                <th scope="col">Тип</th>
                <th scope="col">Модель</th>
                <th scope="col">Статус</th>
              </tr>
            </thead>
            <tbody>
              {jobs.data.map((j) => (
                <tr key={j.id}>
                  <td className={styles.file}>{j.filename}</td>
                  <td className={ui.muted}>{dateTime(j.created_at)}</td>
                  <td className={ui.num}>{duration(j.duration_sec) || '—'}</td>
                  <td>{typeLabel(j.summary_type)}</td>
                  <td className={ui.muted}>{providerName(j.provider_used)}</td>
                  <td>
                    <JobStatusLabel status={j.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <ul className={ui.group}>
          {jobs.data.map((j) => (
            <JobRow key={j.id} job={j} type={typeLabel(j.summary_type)} />
          ))}
        </ul>
      )}
    </Section>
  )
}

function JobStatusLabel({ status }: { status: JobStatus }) {
  if (status === 'done') return <span className={ui.muted}>{STATUS.done}</span>
  return (
    <span className={ui.badge} data-tone={status === 'error' ? 'danger' : 'accent'}>
      {STATUS[status]}
    </span>
  )
}

function JobRow({ job, type }: { job: AdminJob; type: string }) {
  const meta = [
    dateTime(job.created_at),
    duration(job.duration_sec),
    job.summary_type ? type : null,
    job.provider_used ? providerName(job.provider_used) : null,
  ].filter(Boolean)
  return (
    <li className={styles.jobRow}>
      <span className={ui.linkText}>
        <span className={ui.linkTitle}>
          <span>{job.filename}</span>
          {job.status !== 'done' && <JobStatusLabel status={job.status} />}
        </span>
        <span className={`${ui.linkMeta} tabular`}>{meta.join(' · ')}</span>
      </span>
    </li>
  )
}

// --- Password reset ---

function ResetPasswordDialog({
  user,
  open,
  onOpenChange,
  onSave,
}: {
  user: AdminUser
  open: boolean
  onOpenChange: (open: boolean) => void
  onSave: (password: string) => Promise<boolean>
}) {
  const toast = useToast()
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const ref = useRef<HTMLInputElement>(null)

  const change = (o: boolean) => {
    if (busy) return
    if (!o) {
      setPassword('')
      setError(null)
    }
    onOpenChange(o)
  }

  const submit = async () => {
    if (password.length < MIN_PASSWORD) {
      setError(`Не короче ${MIN_PASSWORD} символов`)
      return ref.current?.focus()
    }
    setBusy(true)
    const ok = await onSave(password)
    setBusy(false)
    if (ok) {
      change(false)
      toast('Пароль изменён — передайте его пользователю')
    }
  }

  return (
    <Sheet
      open={open}
      onOpenChange={change}
      title="Новый пароль"
      description={`Для ${user.name || user.email}. Старый пароль перестанет подходить, а открытые сессии закроются.`}
      width="narrow"
      onSubmit={submit}
      initialFocus={ref}
      footer={
        <>
          <Button variant="secondary" onClick={() => change(false)} disabled={busy}>
            Отмена
          </Button>
          <Button type="submit" variant="primary" loading={busy}>
            Сохранить
          </Button>
        </>
      }
    >
      <PasswordField ref={ref} label="Пароль" value={password} onChange={setPassword} error={error} />
    </Sheet>
  )
}

import { createContext, useContext, useEffect, useId } from 'react'
import type { ReactNode } from 'react'
import { AlertCircle, ChevronLeft } from 'lucide-react'
import type { ApiError } from '../api/client'
import { Button } from '../components/ui/Button'
import { Link } from '../components/ui/Link'
import styles from './Page.module.css'

/** Wide: navigation in a sidebar. Narrow: sections are pages with a back button. */
export const AdminLayout = createContext<{ wide: boolean }>({ wide: true })

interface Props {
  title: string
  /** One line under the title: counts, what the page is for. */
  subtitle?: ReactNode
  /** Parent page for detail views; top-level pages go back to the section list on phones. */
  back?: { href: string; label: string }
  actions?: ReactNode
  /** Wider content for tables. */
  width?: 'text' | 'wide'
  children?: ReactNode
  /** Content before the title (e.g. an avatar). */
  lead?: ReactNode
}

export function Page({ title, subtitle, back, actions, width = 'wide', children, lead }: Props) {
  const { wide } = useContext(AdminLayout)
  const backLink = back ?? (wide ? null : { href: '/admin', label: 'Администрирование' })

  useEffect(() => {
    document.title = `${title} — Администрирование`
  }, [title])

  return (
    <div className={styles.page} data-width={width}>
      <div className={styles.bar}>
        {backLink && (
          <Link href={backLink.href} className={styles.back}>
            <ChevronLeft size={22} strokeWidth={2} aria-hidden />
            <span>{backLink.label}</span>
          </Link>
        )}
      </div>
      <header className={styles.header}>
        {lead}
        <div className={styles.heading}>
          <h1 className={styles.title}>{title}</h1>
          {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
        </div>
        {actions && <div className={styles.actions}>{actions}</div>}
      </header>
      {children}
    </div>
  )
}

/** Appears only if loading takes noticeable time, so fast loads don't flicker. */
export function Loading() {
  return (
    <p className={styles.loading} role="status">
      <span className={styles.spinner} aria-hidden />
      Загружаем…
    </p>
  )
}

export function LoadError({ error, onRetry }: { error: ApiError; onRetry: () => void }) {
  return (
    <div className={styles.loadError} role="alert">
      <AlertCircle size={22} strokeWidth={1.75} aria-hidden />
      <div>
        <p className={styles.loadErrorTitle}>
          {error.status === 403 ? 'Нет доступа' : 'Не удалось загрузить'}
        </p>
        <p className={styles.loadErrorText}>
          {error.status === 403 ? 'Раздел открыт только администраторам.' : error.message}
        </p>
      </div>
      {error.status !== 403 && (
        <Button variant="secondary" onClick={onRetry}>
          Повторить
        </Button>
      )}
    </div>
  )
}

/** A titled block of the page. */
export function Section({
  title,
  description,
  actions,
  children,
  id,
}: {
  title: string
  description?: ReactNode
  actions?: ReactNode
  children: ReactNode
  id?: string
}) {
  const headingId = useId()
  return (
    <section className={styles.section} aria-labelledby={headingId} id={id}>
      <div className={styles.sectionHead}>
        <div>
          <h2 id={headingId} className={styles.sectionTitle}>
            {title}
          </h2>
          {description && <p className={styles.sectionText}>{description}</p>}
        </div>
        {actions && <div className={styles.sectionActions}>{actions}</div>}
      </div>
      {children}
    </section>
  )
}

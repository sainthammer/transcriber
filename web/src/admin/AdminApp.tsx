import { useEffect } from 'react'
import type { ComponentType } from 'react'
import { ChartColumn, ChevronLeft, ChevronRight, KeyRound, LayoutList, Users as UsersIcon } from 'lucide-react'
import type { LucideProps } from 'lucide-react'
import { AccountMenu } from '../components/AccountMenu'
import { Link } from '../components/ui/Link'
import { useMediaQuery } from '../lib/hooks'
import { navigate, useRoute } from '../lib/router'
import type { AdminRoute } from '../lib/router'
import { AdminLayout } from './Page'
import { BasePromptEditor, NewTypeEditor, TypeEditor } from './TypeEditor'
import { Settings } from './Settings'
import { Types } from './Types'
import { Usage } from './Usage'
import { UserCard } from './UserCard'
import { Users } from './Users'
import styles from './AdminApp.module.css'

type SectionId = 'users' | 'usage' | 'settings' | 'types'

const SECTIONS: { id: SectionId; href: string; label: string; hint: string; icon: ComponentType<LucideProps> }[] = [
  { id: 'users', href: '/admin/users', label: 'Пользователи', hint: 'Учётные записи и доступ', icon: UsersIcon },
  { id: 'usage', href: '/admin/usage', label: 'Расход', hint: 'Токены и минуты аудио', icon: ChartColumn },
  { id: 'settings', href: '/admin/settings', label: 'Модели и ключи', hint: 'DeepSeek, YandexGPT, Ollama, Whisper', icon: KeyRound },
  { id: 'types', href: '/admin/types', label: 'Типы встреч', hint: 'Промпты и разделы итога', icon: LayoutList },
]

function sectionOf(route: AdminRoute): SectionId | null {
  switch (route.name) {
    case 'admin-users':
    case 'admin-user':
      return 'users'
    case 'admin-usage':
      return 'usage'
    case 'admin-settings':
      return 'settings'
    case 'admin-types':
    case 'admin-type':
    case 'admin-type-new':
    case 'admin-base-prompt':
      return 'types'
    default:
      return null
  }
}

function page(route: AdminRoute) {
  switch (route.name) {
    case 'admin-users':
      return <Users />
    case 'admin-user':
      return <UserCard key={route.id} id={route.id} />
    case 'admin-usage':
      return <Usage />
    case 'admin-settings':
      return <Settings />
    case 'admin-types':
      return <Types />
    case 'admin-type':
      return <TypeEditor key={route.id} id={route.id} />
    case 'admin-type-new':
      return <NewTypeEditor />
    case 'admin-base-prompt':
      return <BasePromptEditor />
    default:
      return null
  }
}

export default function AdminApp() {
  const route = useRoute() as AdminRoute
  const wide = useMediaQuery('(min-width: 1024px)')
  const section = sectionOf(route)

  // /admin is the section list on phones; with a sidebar there is nothing to show there.
  useEffect(() => {
    if (route.name === 'admin' && wide) navigate('/admin/users', { replace: true })
  }, [route, wide])

  useEffect(() => {
    if (route.name === 'admin') document.title = 'Администрирование'
  }, [route])

  if (!wide) {
    return (
      <AdminLayout.Provider value={{ wide }}>
        <main className={styles.narrow}>{route.name === 'admin' ? <SectionList /> : page(route)}</main>
      </AdminLayout.Provider>
    )
  }

  return (
    <AdminLayout.Provider value={{ wide }}>
      <div className={styles.shell}>
        <nav className={styles.sidebar} aria-labelledby="admin-nav-h">
          <div className={styles.sidebarHeader}>
            <Link href="/" className={styles.backLink}>
              <ChevronLeft size={22} strokeWidth={2} aria-hidden />
              <span>Записи</span>
            </Link>
            <AccountMenu place="admin" />
          </div>
          <h2 id="admin-nav-h" className={styles.sidebarTitle}>
            Администрирование
          </h2>
          <ul className={styles.navList}>
            {SECTIONS.map((s) => (
              <li key={s.id}>
                <Link
                  href={s.href}
                  className={styles.navItem}
                  aria-current={section === s.id ? 'page' : undefined}
                >
                  <s.icon size={18} strokeWidth={1.75} aria-hidden />
                  <span>{s.label}</span>
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <main className={styles.content}>{page(route)}</main>
      </div>
    </AdminLayout.Provider>
  )
}

/** Phones: the admin opens on a list of sections, like Settings. */
function SectionList() {
  return (
    <div className={styles.index}>
      <div className={styles.indexBar}>
        <Link href="/" className={styles.backLink}>
          <ChevronLeft size={22} strokeWidth={2} aria-hidden />
          <span>Записи</span>
        </Link>
        <AccountMenu place="admin" />
      </div>
      <h1 className={styles.indexTitle}>Администрирование</h1>
      <ul className={styles.indexList}>
        {SECTIONS.map((s) => (
          <li key={s.id}>
            <Link href={s.href} className={styles.indexItem}>
              <span className={styles.indexIcon} aria-hidden>
                <s.icon size={18} strokeWidth={1.75} />
              </span>
              <span className={styles.indexText}>
                <span className={styles.indexLabel}>{s.label}</span>
                <span className={styles.indexHint}>{s.hint}</span>
              </span>
              <ChevronRight size={18} strokeWidth={2} className={styles.indexChevron} aria-hidden />
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}

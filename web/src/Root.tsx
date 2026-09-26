import { lazy, Suspense } from 'react'
import App from './App'
import { Button } from './components/ui/Button'
import { navigate, useRoute } from './lib/router'
import { useAuth } from './state/authContext'
import { DeletesProvider } from './state/deletes'
import styles from './components/Offline.module.css'

// Most people never open the admin: its code loads on the first visit.
const AdminApp = lazy(() => import('./admin/AdminApp'))

export function Root() {
  const route = useRoute()
  const { isAdmin } = useAuth()

  if (route.name.startsWith('admin')) {
    if (!isAdmin) return <NoAccess />
    return (
      <Suspense fallback={<div style={{ minHeight: '100dvh' }} />}>
        <AdminApp />
      </Suspense>
    )
  }
  return (
    <DeletesProvider>
      <App />
    </DeletesProvider>
  )
}

export function NoAccess() {
  return (
    <main className={styles.offline}>
      <h1 className={styles.title}>Нет доступа</h1>
      <p className={styles.text}>Этот раздел открыт только администраторам.</p>
      <Button variant="secondary" onClick={() => navigate('/', { replace: true })}>
        К записям
      </Button>
    </main>
  )
}

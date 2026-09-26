import { useCallback, useState } from 'react'
import { ConfirmDialog } from '../components/ui/ConfirmDialog'
import { useNavigationBlocker } from '../lib/router'

/** While `dirty`, leaving the page asks first. Render the returned dialog. */
export function useLeaveGuard(dirty: boolean, what = 'Изменения не сохранены.') {
  const [leave, setLeave] = useState<(() => void) | null>(null)
  const onBlock = useCallback((proceed: () => void) => setLeave(() => proceed), [])
  useNavigationBlocker(dirty, onBlock)
  return (
    <ConfirmDialog
      open={!!leave}
      onOpenChange={(o) => !o && setLeave(null)}
      title="Уйти без сохранения?"
      description={what}
      confirm="Уйти"
      cancel="Остаться"
      danger
      onConfirm={() => {
        const go = leave
        setLeave(null)
        go?.()
      }}
    />
  )
}

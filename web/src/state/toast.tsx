import { useCallback, useState } from 'react'
import type { ReactNode } from 'react'
import { Toast } from '../components/Toast'
import { ToastContext } from './toastContext'
import type { ToastOptions } from './toastContext'

interface State extends ToastOptions {
  id: number
  message: string
}

let seq = 0

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<State | null>(null)
  const close = useCallback(() => setToast(null), [])
  const show = useCallback((message: string, options: ToastOptions = {}) => {
    setToast({ id: ++seq, message, ...options })
  }, [])

  return (
    <ToastContext.Provider value={show}>
      {children}
      <Toast
        key={toast?.id}
        message={toast?.message ?? null}
        action={
          toast?.action && {
            label: toast.action.label,
            onClick: () => {
              toast.action?.onClick()
              close()
            },
          }
        }
        duration={toast?.duration ?? 4000}
        onClose={close}
      />
    </ToastContext.Provider>
  )
}

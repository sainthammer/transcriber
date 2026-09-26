import { createContext, useContext } from 'react'

export interface ToastOptions {
  action?: { label: string; onClick: () => void }
  duration?: number
}

export const ToastContext = createContext<(message: string, options?: ToastOptions) => void>(() => {})

/** Show a short message at the bottom of the window; a new one replaces the previous. */
export const useToast = () => useContext(ToastContext)

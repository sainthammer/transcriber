import * as Dialog from '@radix-ui/react-dialog'
import type { FormEvent, ReactNode, RefObject } from 'react'
import { X } from 'lucide-react'
import { IconButton } from './Button'
import styles from './Sheet.module.css'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: ReactNode
  children?: ReactNode
  footer: ReactNode
  /** Submitting (Enter in a field) runs this; the dialog content is a form. */
  onSubmit?: () => void
  /** Element to focus when the dialog opens instead of the first field. */
  initialFocus?: RefObject<HTMLElement | null>
  /** An alert: no close button, Escape and the backdrop still cancel. */
  alert?: boolean
  width?: 'regular' | 'narrow'
}

/** Centered dialog on wide screens, bottom sheet on phones. */
export function Sheet({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  onSubmit,
  initialFocus,
  alert,
  width = 'regular',
}: Props) {
  const submit = (e: FormEvent) => {
    e.preventDefault()
    onSubmit?.()
  }
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content
          className={styles.content}
          data-width={width}
          role={alert ? 'alertdialog' : 'dialog'}
          {...(description ? {} : { 'aria-describedby': undefined })}
          onOpenAutoFocus={(e) => {
            if (!initialFocus?.current) return
            e.preventDefault()
            initialFocus.current.focus()
          }}
        >
          <form onSubmit={submit} noValidate>
            <header className={styles.header} data-alert={alert || undefined}>
              <Dialog.Title className={styles.title}>{title}</Dialog.Title>
              {!alert && (
                <Dialog.Close asChild>
                  <IconButton label="Закрыть">
                    <X size={20} strokeWidth={1.75} />
                  </IconButton>
                </Dialog.Close>
              )}
            </header>
            {description && (
              <Dialog.Description className={styles.description}>{description}</Dialog.Description>
            )}
            {children && <div className={styles.body}>{children}</div>}
            <footer className={styles.footer}>{footer}</footer>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

import { useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from './Button'
import { Sheet } from './Sheet'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: ReactNode
  confirm: string
  cancel?: string
  danger?: boolean
  /** May be async; the button shows progress until it settles. */
  onConfirm: () => unknown
}

/** A question with two answers. The safe one is focused, so Enter never destroys anything. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirm,
  cancel = 'Отмена',
  danger,
  onConfirm,
}: Props) {
  const cancelRef = useRef<HTMLButtonElement>(null)
  const [busy, setBusy] = useState(false)
  const run = async () => {
    setBusy(true)
    try {
      await onConfirm()
    } finally {
      setBusy(false)
    }
  }
  return (
    <Sheet
      open={open}
      onOpenChange={(o) => !busy && onOpenChange(o)}
      title={title}
      description={description}
      alert
      width="narrow"
      initialFocus={cancelRef}
      footer={
        <>
          <Button ref={cancelRef} variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>
            {cancel}
          </Button>
          <Button variant={danger ? 'danger-solid' : 'primary'} onClick={run} loading={busy}>
            {confirm}
          </Button>
        </>
      }
    />
  )
}

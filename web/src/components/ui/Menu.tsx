import * as Dropdown from '@radix-ui/react-dropdown-menu'
import type { ReactNode } from 'react'
import styles from './Menu.module.css'

interface Props {
  trigger: ReactNode
  children: ReactNode
  align?: 'start' | 'end'
}

export function Menu({ trigger, children, align = 'end' }: Props) {
  return (
    <Dropdown.Root>
      <Dropdown.Trigger asChild>{trigger}</Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content className={styles.content} align={align} sideOffset={6} collisionPadding={12}>
          {children}
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  )
}

interface ItemProps {
  icon?: ReactNode
  children: ReactNode
  hint?: string
  danger?: boolean
  href?: string
  download?: boolean
  onSelect?: () => void
  disabled?: boolean
}

export function MenuItem({ icon, children, hint, danger, href, download, onSelect, disabled }: ItemProps) {
  const body = (
    <>
      <span className={styles.icon} aria-hidden>
        {icon}
      </span>
      <span className={styles.label}>{children}</span>
      {hint && <span className={styles.hint}>{hint}</span>}
    </>
  )
  return (
    <Dropdown.Item
      className={styles.item}
      data-danger={danger || undefined}
      onSelect={onSelect}
      disabled={disabled}
      asChild={!!href}
    >
      {href ? (
        <a href={href} download={download || undefined}>
          {body}
        </a>
      ) : (
        body
      )}
    </Dropdown.Item>
  )
}

export function MenuSeparator() {
  return <Dropdown.Separator className={styles.separator} />
}

/** Non-interactive header, e.g. who is signed in. */
export function MenuLabel({ children }: { children: ReactNode }) {
  return <Dropdown.Label className={styles.menuLabel}>{children}</Dropdown.Label>
}

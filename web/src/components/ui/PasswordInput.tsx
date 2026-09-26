import { forwardRef, useState } from 'react'
import type { InputHTMLAttributes, ReactNode } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { IconButton } from './Button'
import forms from '../forms.module.css'

interface Props extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  /** Reveal the value, e.g. right after generating a password. */
  revealed?: boolean
  onRevealedChange?: (revealed: boolean) => void
  /** An extra trailing button before the show/hide toggle. */
  extra?: ReactNode
}

/** Password field with a show/hide toggle. Field's id and aria props land on the input. */
export const PasswordInput = forwardRef<HTMLInputElement, Props>(function PasswordInput(
  { revealed, onRevealedChange, extra, className, ...rest },
  ref,
) {
  const [own, setOwn] = useState(false)
  const shown = revealed ?? own
  const toggle = () => (onRevealedChange ? onRevealedChange(!shown) : setOwn(!shown))
  return (
    <div className={forms.inputWrap} data-extra={extra ? '' : undefined}>
      <input
        ref={ref}
        type={shown ? 'text' : 'password'}
        className={[forms.input, className].filter(Boolean).join(' ')}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        {...rest}
      />
      <span className={forms.inputAction}>
        {extra}
        <IconButton label={shown ? 'Скрыть пароль' : 'Показать пароль'} onClick={toggle}>
          {shown ? <EyeOff size={18} strokeWidth={1.75} /> : <Eye size={18} strokeWidth={1.75} />}
        </IconButton>
      </span>
    </div>
  )
})

import { forwardRef } from 'react'
import type { AnchorHTMLAttributes } from 'react'
import { navigate } from '../../lib/router'

interface Props extends AnchorHTMLAttributes<HTMLAnchorElement> {
  href: string
}

/** A real link (opens in a new tab with ⌘/Ctrl) that navigates in-app on a plain click. */
export const Link = forwardRef<HTMLAnchorElement, Props>(function Link({ href, onClick, ...rest }, ref) {
  return (
    <a
      ref={ref}
      href={href}
      onClick={(e) => {
        onClick?.(e)
        if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return
        e.preventDefault()
        navigate(href)
      }}
      {...rest}
    />
  )
})

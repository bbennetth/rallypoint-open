import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react'

// Make a non-<button> row a keyboard-accessible "open detail" target. The
// list rows already contain Done/checkbox/pencil <button>s, so the row itself
// can't be a <button> (no nested buttons) — spread these props instead.
export function openProps(open: () => void) {
  return {
    role: 'button' as const,
    tabIndex: 0,
    onClick: open,
    onKeyDown: (e: ReactKeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        open()
      }
    },
  }
}

// Wrap a row's inner action button so its click doesn't bubble up and also
// open the detail drawer.
export const stopRowOpen = (e: ReactMouseEvent) => e.stopPropagation()

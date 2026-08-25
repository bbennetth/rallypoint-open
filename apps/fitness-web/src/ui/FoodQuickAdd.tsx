// Food-tab quick-add: the sub-bar's trailing `+` FAB opening a popover
// menu of the four logging paths (barcode / photo / manual / drink).
// Menu shell mirrors planner's QuickAdd `anchor="subbar"` shape — raw
// `.rp-fab` in a relative wrapper so the shared `.pl-fab-menu` popover
// anchors above the button; the sheets themselves stay owned by
// FoodPage, this component only reports which action was picked.

import { useEffect, useRef, useState } from 'react'
import { Icon, useFilePicker, type IconName } from '@rallypoint/ui'
import type { FoodFavoriteDto } from '@rallypoint/fitness-shared'

// How many pins the menu shows before it stops being a quick-add and
// starts being a list — the full set lives on the diary's own strip.
const MENU_FAVORITES = 5

// 'photo' is not in this union: that row opens the OS picker directly and
// reports through `onPhoto` with the file, so there is no "open the sheet,
// then choose a source" hop.
export type FoodAddAction = 'barcode' | 'text' | 'manual' | 'drink'

const MENU: { key: FoodAddAction | 'photo'; label: string; icon: IconName }[] = [
  { key: 'barcode', label: 'Scan barcode', icon: 'barcode' },
  { key: 'photo', label: 'Snap a meal', icon: 'camera' },
  { key: 'text', label: 'Describe it', icon: 'bolt' },
  { key: 'manual', label: 'Add manually', icon: 'pencil' },
  { key: 'drink', label: 'Add drink', icon: 'cup' },
]

export function FoodQuickAdd({
  onAction,
  onPhoto,
  favorites = [],
  onFavorite,
}: {
  onAction: (action: FoodAddAction) => void
  onPhoto: (file: File) => void
  // Pinned quick-log templates, newest first. Omitted by hosts that
  // don't offer one-tap re-logging.
  favorites?: FoodFavoriteDto[]
  onFavorite?: (fav: FoodFavoriteDto) => void
}) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const picker = useFilePicker({
    onPick: (file) => {
      setOpen(false)
      onPhoto(file)
    },
    ariaLabel: 'Snap a meal',
  })

  // Outside-click + Escape close the menu (mirrors planner's QuickAdd).
  useEffect(() => {
    if (!open) return
    const off = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', off)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('mousedown', off)
      document.removeEventListener('keydown', esc)
    }
  }, [open])

  const shownFavorites = onFavorite ? favorites.slice(0, MENU_FAVORITES) : []

  function pick(key: FoodAddAction | 'photo') {
    // The photo row opens the picker in THIS handler — synchronously, or
    // Safari drops the user-activation token. The menu closes on the pick
    // instead, so a cancelled picker leaves the menu where it was.
    if (key === 'photo') {
      picker.open()
      return
    }
    setOpen(false)
    onAction(key)
  }

  return (
    <div ref={wrapRef} style={{ position: 'relative', display: 'inline-flex', flex: '0 0 auto' }}>
      {open && (
        <div className="pl-fab-menu" role="menu">
          {/* Pins first: re-logging a regular is the fastest path, and
              the capture rows below stay in their familiar order. */}
          {shownFavorites.map((f) => (
            <button
              key={f.id}
              type="button"
              className="pl-fab-item"
              role="menuitem"
              onClick={() => {
                setOpen(false)
                onFavorite?.(f)
              }}
            >
              <Icon name="heart" size={15} />
              <span className="txt">{f.name}</span>
            </button>
          ))}
          {shownFavorites.length > 0 && <div className="pl-fab-sep" role="separator" />}
          {MENU.map((m) => (
            <button
              key={m.key}
              type="button"
              className="pl-fab-item"
              role="menuitem"
              onClick={() => pick(m.key)}
            >
              <Icon name={m.icon} size={15} />
              {m.label}
            </button>
          ))}
        </div>
      )}
      <button
        type="button"
        className={'rp-fab' + (open ? ' is-open' : '')}
        aria-label="Log food"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="plus" size={18} stroke={2.4} />
      </button>
      {/* Outside the `{open && …}` branch on purpose: the menu unmounts on
          pick, and an unmounted input never fires `change`. */}
      {picker.input}
    </div>
  )
}

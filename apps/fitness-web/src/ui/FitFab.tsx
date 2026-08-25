// Fitness quick-add FAB: the sub-bar's trailing `+` opening a popover
// menu of the five start paths. Menu shell mirrors FoodQuickAdd /
// planner's QuickAdd `anchor="subbar"` shape — raw `.rp-fab` in a
// relative wrapper so the shared `.pl-fab-menu` popover anchors above
// the button. Replaced the old StartSheet drawer (one consistent FAB
// style across the app; the Food tab keeps its contextual FoodQuickAdd).
// Pages just write `<SubBar fab={<FitFab />}>…</SubBar>`.

import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Icon, useFilePicker, type IconName } from '@rallypoint/ui'
import { stashPendingPhoto, type PendingPhotoKind } from '../lib/pending-photo.js'
import { useDefaultRestS } from '../lib/rest-settings.js'
import { seedFreeStrengthSession } from '../lib/start-free-strength.js'

type FitStartAction = 'wod' | 'strength' | 'run' | 'build' | 'body' | 'meal' | 'board'

// The two camera rows open the OS picker from here and hand the file to
// their destination page through the pending-photo slot — the picker has to
// open on THIS tap (user activation), so navigation waits for the file.
const CAPTURE: Partial<Record<FitStartAction, { kind: PendingPhotoKind; to: string }>> = {
  meal: { kind: 'meal', to: '/food' },
  board: { kind: 'board', to: '/composer' },
}

const MENU: { key: FitStartAction; label: string; icon: IconName; to?: string }[] = [
  { key: 'wod', label: 'Start a WOD', icon: 'stopwatch', to: '/library/wods' },
  // No `to`: seeds a blank live session, then navigates (see pick()).
  { key: 'strength', label: 'Strength session', icon: 'barbell' },
  { key: 'run', label: 'Log a run', icon: 'run', to: '/run/log' },
  { key: 'meal', label: 'Snap a meal', icon: 'camera' },
  { key: 'board', label: 'Scan a whiteboard', icon: 'file' },
  { key: 'build', label: 'Build a workout', icon: 'pencil', to: '/composer' },
  { key: 'body', label: 'Log body metric', icon: 'heart', to: '/stats/body?log=1' },
]

export function FitFab({ onMeal }: { onMeal?: (file: File) => void } = {}) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const nav = useNavigate()
  const defaultRestS = useDefaultRestS()
  // Which capture row is armed, so the shared picker knows where to send
  // the file. Set synchronously in pick() before open().
  const armed = useRef<FitStartAction | null>(null)
  const picker = useFilePicker({
    onPick: (file) => {
      const target = armed.current ? CAPTURE[armed.current] : undefined
      armed.current = null
      if (!target) return
      setOpen(false)
      // A host that logs food in place takes the meal photo directly; the
      // FAB stays route-agnostic because the behaviour is supplied, not
      // sniffed from the current path.
      if (target.kind === 'meal' && onMeal) {
        onMeal(file)
        return
      }
      stashPendingPhoto(target.kind, file)
      nav(target.to)
    },
    ariaLabel: 'Take or choose a photo',
  })

  // Outside-click + Escape close the menu (mirrors FoodQuickAdd).
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

  function pick(item: (typeof MENU)[number]) {
    if (CAPTURE[item.key]) {
      // Open the picker in THIS handler and navigate from onPick — an
      // await or a nav() first would drop Safari's user-activation token
      // and the picker would silently never open.
      armed.current = item.key
      picker.open()
      return
    }
    setOpen(false)
    if (item.key === 'strength') {
      // Blank free session: starts immediately, exercises added live.
      nav(seedFreeStrengthSession(defaultRestS))
      return
    }
    if (item.to) nav(item.to)
  }

  return (
    <div ref={wrapRef} style={{ position: 'relative', display: 'inline-flex', flex: '0 0 auto' }}>
      {open && (
        <div className="pl-fab-menu" role="menu">
          {MENU.map((m) => (
            <button
              key={m.key}
              type="button"
              className="pl-fab-item"
              role="menuitem"
              onClick={() => pick(m)}
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
        aria-label="Start a session"
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

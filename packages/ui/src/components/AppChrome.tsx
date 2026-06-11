import { useEffect, useRef, useState, type ReactNode, type Ref } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { Icon, type IconName } from './icons.js'
import { swipeDirection, nextTabIndex } from '../lib/swipe-nav.js'

// Rallypoint "Ink" app chrome — the shared shell promoted from planner-web.
// Desktop: a 220px sidebar (≥1024px). Mobile: a 52px top bar + bottom pill
// tab-bar. The brand lockup (an app-switcher) and the user menu are injected
// via render-prop slots so each app supplies its own session-aware controls; an
// optional FAB slot and an internal toast complete the chrome. The app passes
// its own `nav` config and `subLabel`.

export interface AppChromeNavItem {
  to: string
  label: string
  icon: IconName
  /** Match the route exactly (passed through to NavLink `end`). */
  end?: boolean
}

export interface AppChromeProps {
  nav: readonly AppChromeNavItem[]
  /** App name shown under the brand lockup (e.g. "Planner", "Lists"). */
  subLabel: string
  /** Brand / app-switcher slot, rendered in both sidebar (desktop) and top bar (mobile). */
  brand?: (ctx: { size: 'desktop' | 'mobile'; showToast: (msg: string) => void }) => ReactNode
  /** User-menu slot, rendered in both sidebar (desktop) and top bar (mobile). */
  userMenu?: (ctx: { size: 'desktop' | 'mobile' }) => ReactNode
  /** Optional floating action button (e.g. planner's quick-add). */
  fab?: (ctx: { showToast: (msg: string) => void }) => ReactNode
  // Forwarded ref onto the scroll container `<main class="plapp-main">`.
  // Used by `<PullToRefresh>` so the gesture can attach touch handlers
  // and read `scrollTop`. Optional — most consumers leave it unset.
  mainRef?: Ref<HTMLElement>
  // Sibling content rendered inside `.plapp-main` above `children` (e.g.
  // `<PullToRefresh>`, which positions itself absolute against the
  // scroll container). Receives the same `mainRef`.
  mainOverlay?: ReactNode
  children: ReactNode
}

// ── Shared NavItem ────────────────────────────────────────────────────────────
// Renders the inner content of a nav link/tab pill. Used by both the desktop
// sidebar and the mobile tab bar so the two surfaces can't drift.

interface NavItemContentProps {
  def: AppChromeNavItem
  variant: 'sidebar' | 'tabbar'
}

function NavItemContent({ def, variant }: NavItemContentProps) {
  if (variant === 'sidebar') {
    return (
      <>
        <span className="ic">
          <Icon name={def.icon} size={16} />
        </span>
        {def.label}
      </>
    )
  }
  // tabbar: icon above label
  return (
    <>
      <span className="pl-tab-icon" aria-hidden="true">
        <Icon name={def.icon} size={18} />
      </span>
      <span className="pl-tab-label">{def.label}</span>
    </>
  )
}

interface SwipeStart {
  x: number
  y: number
  t: number
}

export function AppChrome({ nav, subLabel, brand, userMenu, fab, mainRef, mainOverlay, children }: AppChromeProps) {
  const [toast, setToast] = useState<string | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const swipeStart = useRef<SwipeStart | null>(null)
  const location = useLocation()
  const navigate = useNavigate()

  // Compute the active tab index by matching the current pathname against nav.
  // Prefer an exact match; fall back to longest prefix match for non-end routes.
  const pathname = location.pathname
  let activeIndex = -1
  {
    let bestLen = 0
    for (let i = 0; i < nav.length; i++) {
      const n = nav[i]!
      if (n.to === pathname) { activeIndex = i; break }
      if (!n.end && pathname.startsWith(n.to) && n.to.length > bestLen) {
        bestLen = n.to.length
        activeIndex = i
      }
    }
  }

  function handleTouchStart(e: React.TouchEvent<HTMLElement>) {
    const t = e.touches[0]
    if (!t) return
    swipeStart.current = { x: t.clientX, y: t.clientY, t: Date.now() }
  }

  function handleTouchEnd(e: React.TouchEvent<HTMLElement>) {
    if (!swipeStart.current || nav.length === 0 || activeIndex < 0) return
    const touch = e.changedTouches[0]
    if (!touch) return
    const dx = touch.clientX - swipeStart.current.x
    const dy = touch.clientY - swipeStart.current.y
    const dt = Date.now() - swipeStart.current.t
    swipeStart.current = null
    const dir = swipeDirection(dx, dy, dt)
    const dest = nextTabIndex(activeIndex, nav.length, dir)
    if (dest !== activeIndex) {
      const destItem = nav[dest]
      if (destItem) navigate(destItem.to)
    }
  }

  function showToast(msg: string) {
    setToast(msg)
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 2400)
  }

  useEffect(() => () => {
    if (toastTimer.current) clearTimeout(toastTimer.current)
  }, [])

  return (
    <div className="plapp">
      <aside className="pl-side">
        <div className="pl-brand">
          {brand?.({ size: 'desktop', showToast })}
          <div className="pl-sub">{subLabel}</div>
        </div>
        <nav className="pl-nav" aria-label="Primary navigation">
          {nav.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.end ?? false}
              className={({ isActive }) => 'pl-navlink' + (isActive ? ' is-active' : '')}
            >
              <NavItemContent def={n} variant="sidebar" />
            </NavLink>
          ))}
        </nav>
        {userMenu && <div className="pl-side-foot">{userMenu({ size: 'desktop' })}</div>}
      </aside>

      <div className="plapp-body">
        {(brand || userMenu) && (
          <div className="pl-topbar">
            {brand?.({ size: 'mobile', showToast })}
            {userMenu?.({ size: 'mobile' })}
          </div>
        )}

        <main
          className="plapp-main"
          ref={mainRef}
          style={mainOverlay ? { position: 'relative' } : undefined}
          onTouchStart={handleTouchStart}
          onTouchEnd={handleTouchEnd}
        >
          {mainOverlay}
          <div className="plapp-content">{children}</div>
        </main>

        {nav.length > 0 && (
          <nav className="pl-tabbar" aria-label="App navigation">
            {nav.map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                end={n.end ?? false}
                className={({ isActive }) => 'pl-tab' + (isActive ? ' is-active' : '')}
              >
                <NavItemContent def={n} variant="tabbar" />
              </NavLink>
            ))}
          </nav>
        )}
      </div>

      {fab?.({ showToast })}

      {toast && <div className="pl-toast" role="status">{toast}</div>}
    </div>
  )
}

import { useEffect, useRef, useState } from 'react'
import { AppBrandLockup, Icon } from './icons.js'
import { ThemeToggle } from './ThemeToggle.js'
import { DEFAULT_APPS, type AppSwitcherApp } from './apps.js'
import { detectStandalone } from '../lib/standalone.js'
import { appendEmbeddedParam, isIOS, shouldEmbedTarget } from '../lib/embedded-shell.js'

// App-switcher fly-out anchored to the brand lockup. Rows route to the sibling
// Rallypoint apps via build-time origins (toast fallback when unset); the row
// whose key matches `current` renders as ACTIVE and is non-navigable. A theme
// row (Ink 2-chip picker) plus optional Settings / Send feedback / Sign out
// shortcuts sit below. Promoted from planner-web's bespoke switcher and made
// router-free: signout / settings / feedback are injected callbacks so the
// shared component carries no app-specific session or routing dependency.

export interface AppSwitcherProps {
  /** Key of the app currently being viewed (matches an entry's `key`). */
  current: string
  /** App rows to show. Defaults to the canonical Rallypoint list. */
  apps?: readonly AppSwitcherApp[]
  size?: 'desktop' | 'mobile'
  onToast?: (msg: string) => void
  /** Sign the user out (app owns the API call + post-signout navigation). */
  onSignout?: () => void | Promise<void>
  /** Open the app's settings surface. When omitted, the Settings row is hidden. */
  onOpenSettings?: () => void
  /** Handle the "Send feedback" row. Defaults to a "coming soon" toast. */
  onFeedback?: () => void
  /** Version string for the footer (e.g. import.meta.env.VITE_APP_VERSION). */
  appVersion?: string
}

export function AppSwitcher({
  current,
  apps = DEFAULT_APPS,
  size = 'desktop',
  onToast,
  onSignout,
  onOpenSettings,
  onFeedback,
  appVersion,
}: AppSwitcherProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const flyoutRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  // Outside-click + Escape close.
  useEffect(() => {
    if (!open) return
    const off = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const esc = (e: KeyboardEvent) => {
      // Escape returns focus to the trigger (ARIA menu pattern);
      // outside-click closes without stealing focus from the click target.
      if (e.key === 'Escape') {
        setOpen(false)
        triggerRef.current?.focus()
      }
    }
    document.addEventListener('mousedown', off)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('mousedown', off)
      document.removeEventListener('keydown', esc)
    }
  }, [open])

  // Focus first menuitem when the flyout opens.
  useEffect(() => {
    if (!open || !flyoutRef.current) return
    const first = flyoutRef.current.querySelector<HTMLElement>('[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]')
    first?.focus()
  }, [open])

  // Arrow-key navigation within the menu.
  function onFlyoutKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (!flyoutRef.current) return
    // Include aria-disabled items so the active app row is still navigable via
    // arrow keys (it's not disabled for AT — only for click/activation).
    const items = Array.from(
      flyoutRef.current.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]'),
    ).filter((n) => !n.hasAttribute('disabled'))

    const active = document.activeElement as HTMLElement | null
    const idx = active ? items.indexOf(active) : -1

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      items[(idx + 1) % items.length]?.focus()
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      items[(idx - 1 + items.length) % items.length]?.focus()
    } else if (e.key === 'Home') {
      e.preventDefault()
      items[0]?.focus()
    } else if (e.key === 'End') {
      e.preventDefault()
      items[items.length - 1]?.focus()
    }
  }

  function pickApp(app: AppSwitcherApp) {
    setOpen(false)
    if (app.key === current) return
    if (app.tag === 'SOON') {
      onToast?.(`${app.name} is coming soon`)
      return
    }
    if (app.origin) {
      // Deep-link to the app's authed home so we skip its `/` splash screen.
      let href = app.origin + (app.home ?? '')
      // Launching from an iOS installed PWA: the sibling opens in a Safari sheet
      // (with a Done button back to here), so mark it embedded — the target
      // hides its own switcher + account icon and reads as an inner view.
      if (shouldEmbedTarget(detectStandalone(), isIOS())) {
        href = appendEmbeddedParam(href)
      }
      window.location.href = href
    } else {
      onToast?.(`${app.name} opens in its own app`)
    }
  }

  async function handleSignout() {
    setOpen(false)
    await onSignout?.()
  }

  function handleFeedback() {
    setOpen(false)
    if (onFeedback) onFeedback()
    else onToast?.('Feedback — coming soon')
  }

  // The app-switcher trigger is always left-anchored — the desktop sidebar
  // brand and the mobile top-bar's first (left) cell. So the flyout opens
  // rightward from the left edge (default `.pl-flyout`); a right-aligned
  // (`is-right`) flyout would anchor its right edge to the narrow left trigger
  // and run off the left of the viewport on mobile.
  const flyoutClass = 'pl-flyout'

  return (
    <div className="pl-switch" ref={ref}>
      <button
        type="button"
        ref={triggerRef}
        className="pl-switch-trigger"
        onClick={() => setOpen((o) => !o)}
        aria-label="Switch app"
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <AppBrandLockup size={size} caret caretOpen={open} />
      </button>
      {open && (
        <div
          ref={flyoutRef}
          className={flyoutClass}
          role="menu"
          onKeyDown={onFlyoutKeyDown}
        >
          <div className="eyebrow">Rallypoint apps</div>
          <div style={{ display: 'grid', gap: 6 }}>
            {apps.map((a) => {
              const isActive = a.key === current
              return (
                <button
                  key={a.key}
                  type="button"
                  role="menuitemradio"
                  aria-checked={isActive}
                  className={'pl-app-row' + (isActive ? ' is-active' : '')}
                  aria-disabled={isActive ? 'true' : undefined}
                  onClick={() => pickApp(a)}
                >
                  <span className="ag">
                    <Icon name={a.icon} size={16} />
                  </span>
                  {a.name}
                  {/* Don't dim the SOON tag — handled by the tag class, not opacity */}
                  <span className={'tag' + (a.tag === 'SOON' ? ' tag-soon' : '')}>
                    {isActive ? 'ACTIVE' : a.tag || 'OPEN'}
                  </span>
                </button>
              )
            })}
          </div>
          <div className="pl-div" />
          <div className="pl-theme-row">
            <span className="lbl">Theme</span>
            <ThemeToggle inMenu />
          </div>
          <div style={{ display: 'grid', gap: 6 }}>
            {onOpenSettings && (
              <button type="button" role="menuitem" className="pl-shortcut" onClick={() => { setOpen(false); onOpenSettings() }}>
                Settings
              </button>
            )}
            <button type="button" role="menuitem" className="pl-shortcut" onClick={handleFeedback}>
              Send feedback
            </button>
            <button type="button" role="menuitem" className="pl-shortcut" onClick={() => { void handleSignout() }}>
              Sign out
            </button>
          </div>
          <div className="eyebrow" style={{ textAlign: 'center' }}>
            v{appVersion ?? '0.0.0'}
          </div>
        </div>
      )}
    </div>
  )
}

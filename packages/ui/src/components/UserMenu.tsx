import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { Avatar } from './Avatar.js'

// User-bar fly-out anchored to the signed-in user's avatar. Renders the user's
// profile (avatar + name) with a dismissable menu (outside-click + Escape,
// mirroring AppSwitcher) offering Account (deep-links to id-web's hosted
// account page) and Logout. Promoted from planner-web and made router-free:
// the host injects `profile`, `onSignout`, and `accountUrl` so this carries no
// app-specific session dependency.

export interface UserMenuProfile {
  picture_url?: string | null
  username?: string | null
  first_name?: string | null
  last_name?: string | null
  email?: string | null
}

export interface UserMenuProps {
  /** Resolved profile of the signed-in user, or null while loading / signed out. */
  profile: UserMenuProfile | null
  size?: 'desktop' | 'mobile'
  /** Sign the user out (app owns the API call + post-signout navigation). */
  onSignout?: () => void | Promise<void>
  /**
   * Absolute http(s) URL of the hosted account page; opens in a new tab.
   * Hidden if unset — or if the value is relative or a non-http(s) scheme
   * (`javascript:` etc.), which the component rejects as defense-in-depth.
   */
  accountUrl?: string
  /**
   * In-app account navigation (same tab). id-web IS the account app, so it
   * passes this to route to /account/settings in place of the new-tab
   * `accountUrl` deep-link other apps use. Takes precedence over accountUrl;
   * the "Account" item shows if either is set.
   */
  onAccount?: () => void
}

// Guard for the injected account deep-link: this is a shared library
// component, so it enforces its own "absolute http(s) URL" contract rather
// than trusting every future caller. Returns the normalized href (so the
// validated parse is also what gets opened), or null for relative URLs and
// non-http(s) schemes (javascript:, data:, etc.).
function parseAccountUrl(url: string): string | null {
  try {
    const parsed = new URL(url)
    return /^https?:$/.test(parsed.protocol) ? parsed.href : null
  } catch {
    return null
  }
}

function displayName(profile: UserMenuProfile | null): string {
  if (!profile) return 'You'
  const full = [profile.first_name, profile.last_name].filter(Boolean).join(' ').trim()
  return profile.username?.trim() || full || profile.email?.trim() || 'You'
}

export function UserMenu({
  profile,
  size = 'desktop',
  onSignout,
  accountUrl,
  onAccount,
}: UserMenuProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const flyoutRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const off = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const esc = (e: globalThis.KeyboardEvent) => {
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
    const first = flyoutRef.current.querySelector<HTMLElement>('[role="menuitem"]')
    first?.focus()
  }, [open])

  // Arrow-key navigation within the menu (mirrors AppSwitcher.onFlyoutKeyDown).
  function onFlyoutKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (!flyoutRef.current) return
    const items = Array.from(
      flyoutRef.current.querySelectorAll<HTMLElement>('[role="menuitem"]'),
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

  async function handleSignout() {
    setOpen(false)
    await onSignout?.()
  }

  function openAccount() {
    setOpen(false)
    if (onAccount) {
      onAccount()
      return
    }
    if (safeAccountUrl) window.open(safeAccountUrl, '_blank', 'noopener,noreferrer')
  }

  const safeAccountUrl = accountUrl ? parseAccountUrl(accountUrl) : null
  const name = displayName(profile)
  const avatarSize = size === 'mobile' ? 28 : 32

  return (
    <div className="pl-switch" ref={ref}>
      <button
        type="button"
        ref={triggerRef}
        className="pl-user-trigger"
        onClick={() => setOpen((o) => !o)}
        aria-label="Account menu"
        aria-expanded={open}
        aria-haspopup="menu"
        style={
          size === 'desktop'
            ? { display: 'flex', alignItems: 'center', gap: 10, width: '100%', minWidth: 0 }
            : undefined
        }
      >
        <Avatar
          size={avatarSize}
          pictureUrl={profile?.picture_url ?? null}
          name={profile?.username ?? null}
          firstName={profile?.first_name ?? null}
          lastName={profile?.last_name ?? null}
          email={profile?.email ?? null}
        />
        {size === 'desktop' && (
          <span style={{ minWidth: 0, flex: 1, textAlign: 'left' }}>
            <span
              style={{
                display: 'block',
                fontSize: 12.5,
                color: 'var(--ink)',
                fontWeight: 600,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {name}
            </span>
            <span className="eyebrow" style={{ display: 'block', marginTop: 2 }}>
              Signed in
            </span>
          </span>
        )}
      </button>
      {open && (
        <div
          ref={flyoutRef}
          className={
            'pl-flyout' + (size === 'desktop' ? ' is-up' : ' is-right')
          }
          role="menu"
          onKeyDown={onFlyoutKeyDown}
        >
          <div style={{ display: 'grid', gap: 6 }}>
            {(safeAccountUrl || onAccount) && (
              <button type="button" role="menuitem" className="pl-shortcut" onClick={openAccount}>
                Account
              </button>
            )}
            <button type="button" role="menuitem" className="pl-shortcut" onClick={() => { void handleSignout() }}>
              Logout
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

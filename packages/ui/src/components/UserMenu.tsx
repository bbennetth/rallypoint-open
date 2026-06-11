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
  /** Absolute URL of the hosted account page; opens in a new tab. Hidden if unset. */
  accountUrl?: string
}

function displayName(profile: UserMenuProfile | null): string {
  if (!profile) return 'You'
  const full = [profile.first_name, profile.last_name].filter(Boolean).join(' ').trim()
  return profile.username?.trim() || full || profile.email?.trim() || 'You'
}

export function UserMenu({ profile, size = 'desktop', onSignout, accountUrl }: UserMenuProps) {
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
    if (accountUrl) window.open(accountUrl, '_blank', 'noopener,noreferrer')
  }

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
            {accountUrl && (
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

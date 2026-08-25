import { useEffect, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  AppChrome as SharedAppChrome,
  AppSwitcher,
  SwUpdateBanner,
  UserMenu,
  isEmbeddedShell,
  type AppChromeNavItem,
} from '@rallypoint/ui'
import { bootSucceeded, useSwUpdatePrompt } from '@rallypoint/web-kit'
import { signout } from '../lib/api.js'
import { purgeUserDb } from '../lib/offline/db.js'
import { engine } from '../lib/offline/engine.js'
import { OfflineIndicator } from './OfflineIndicator.js'
import { useSession, RPID_UI_URL } from '../lib/session.js'

// Lists chrome: a thin wrapper over the shared @rallypoint/ui AppChrome (the
// Ink shell). Lists supplies its own nav config, the app-switcher + user-menu
// wired to its session/api. Lists has no FAB so the fab prop is omitted and
// no Settings route so onOpenSettings is omitted.

const NAV: readonly AppChromeNavItem[] = [
  { to: '/me/lists', label: 'My Lists', icon: 'tasks', end: true },
  { to: '/me/tokens', label: 'MCP Tokens', icon: 'sliders' },
]

export function AppChrome({ children }: { children: ReactNode }) {
  const navigate = useNavigate()
  const { profile, userId } = useSession()
  // Opened from another app's switcher inside the iOS PWA → drop our own
  // switcher + account icon so this reads as an embedded view.
  const embedded = isEmbeddedShell()
  // Reload-to-update (#675 R5): the SW parks a new build in `waiting`
  // instead of blind-swapping it in; this banner is the user-facing
  // accept step that fires applyUpdate() (SKIP_WAITING + reload).
  const { updateReady, applyUpdate } = useSwUpdatePrompt()
  // Shell mounted — tell the boot watchdog this launch made it, so the
  // white-screen failure counter resets.
  useEffect(() => {
    bootSucceeded()
  }, [])

  async function handleSignout() {
    try {
      // Drop this user's offline cache + outbox before clearing the session so
      // a shared device never carries one user's private lists into the next;
      // dispose the flusher so no stale retry timer reopens the purged db.
      if (userId) {
        engine.dispose(userId)
        await purgeUserDb(userId)
      }
      await signout()
    } finally {
      navigate('/', { replace: true })
    }
  }

  // exactOptionalPropertyTypes: `brand?`/`userMenu?` mean "may be omitted",
  // not "may be `undefined`" — passing `brand={undefined}` explicitly still
  // fails the check, so the embedded case must omit the prop entirely
  // rather than hand it an undefined value.
  return (
    <SharedAppChrome
      nav={NAV}
      subLabel="Lists"
      {...(!embedded && {
        brand: ({ size, showToast }: { size: 'desktop' | 'mobile'; showToast: (msg: string) => void }) => (
          <AppSwitcher
            current="lists"
            size={size}
            onToast={showToast}
            onSignout={handleSignout}
            appVersion={import.meta.env.VITE_APP_VERSION}
          />
        ),
      })}
      {...(!embedded && {
        userMenu: ({ size }: { size: 'desktop' | 'mobile' }) => (
          <UserMenu
            size={size}
            profile={profile ?? null}
            onSignout={handleSignout}
            accountUrl={`${RPID_UI_URL}/account/settings`}
          />
        ),
      })}
    >
      <SwUpdateBanner updateReady={updateReady} onReload={applyUpdate} />
      {userId && <OfflineIndicator userId={userId} />}
      {children}
    </SharedAppChrome>
  )
}

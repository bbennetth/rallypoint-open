import { type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  AppChrome as SharedAppChrome,
  AppSwitcher,
  UserMenu,
  isEmbeddedShell,
  type AppChromeNavItem,
} from '@rallypoint/ui'
import { signout } from '../lib/api.js'
import { useSession, RPID_UI_URL } from '../lib/session.js'

// Lists chrome: a thin wrapper over the shared @rallypoint/ui AppChrome (the
// Ink shell). Lists supplies its own nav config, the app-switcher + user-menu
// wired to its session/api. Lists has no FAB so the fab prop is omitted and
// no Settings route so onOpenSettings is omitted.

const NAV: readonly AppChromeNavItem[] = [
  { to: '/me/lists', label: 'My Lists', icon: 'tasks', end: true },
]

export function AppChrome({ children }: { children: ReactNode }) {
  const navigate = useNavigate()
  const { profile } = useSession()
  // Opened from another app's switcher inside the iOS PWA → drop our own
  // switcher + account icon so this reads as an embedded view.
  const embedded = isEmbeddedShell()

  async function handleSignout() {
    try {
      await signout()
    } finally {
      navigate('/', { replace: true })
    }
  }

  return (
    <SharedAppChrome
      nav={NAV}
      subLabel="Lists"
      brand={
        embedded
          ? undefined
          : ({ size, showToast }) => (
              <AppSwitcher
                current="lists"
                size={size}
                onToast={showToast}
                onSignout={handleSignout}
                appVersion={import.meta.env.VITE_APP_VERSION}
              />
            )
      }
      userMenu={
        embedded
          ? undefined
          : ({ size }) => (
              <UserMenu
                size={size}
                profile={profile ?? null}
                onSignout={handleSignout}
                accountUrl={`${RPID_UI_URL}/account/settings`}
              />
            )
      }
    >
      {children}
    </SharedAppChrome>
  )
}

import { type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  AppChrome as SharedAppChrome,
  AppSwitcher,
  UserMenu,
  type AppChromeNavItem,
} from '@rallypoint/ui'
import { signout } from '../lib/api.js'
import { useSession, RPID_UI_URL } from '../lib/session.js'

// Money chrome: a thin wrapper over the shared @rallypoint/ui AppChrome (the
// Ink shell). Money supplies its own nav config, the app-switcher + user-menu
// wired to its session/api. Money has no FAB so the fab prop is omitted and
// no Settings route so onOpenSettings is omitted.

const NAV: readonly AppChromeNavItem[] = [
  { to: '/me/ledgers', label: 'My Ledgers', icon: 'money', end: true },
]

export function AppChrome({ children }: { children: ReactNode }) {
  const navigate = useNavigate()
  const { profile } = useSession()

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
      subLabel="Money"
      brand={({ size, showToast }) => (
        <AppSwitcher
          current="money"
          size={size}
          onToast={showToast}
          onSignout={handleSignout}
          appVersion={import.meta.env.VITE_APP_VERSION}
        />
      )}
      userMenu={({ size }) => (
        <UserMenu
          size={size}
          profile={profile ?? null}
          onSignout={handleSignout}
          accountUrl={`${RPID_UI_URL}/account/settings`}
        />
      )}
    >
      {children}
    </SharedAppChrome>
  )
}

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

// Admin chrome: a thin wrapper over the shared @rallypoint/ui AppChrome (the
// Ink shell). Two nav tabs (exercise + food review queues), the
// app-switcher + user-menu wired to the admin session/api. `current="admin"`
// matches no switcher row (Admin is an internal tool, not a peer app
// surface).

const NAV: readonly AppChromeNavItem[] = [
  { to: '/review', label: 'Exercises', icon: 'check', end: true },
  { to: '/food-review', label: 'Food', icon: 'flame', end: true },
  { to: '/catalog', label: 'Catalog', icon: 'barbell', end: true },
  { to: '/system-events', label: 'Events', icon: 'events', end: true },
  { to: '/artists', label: 'Artists', icon: 'star', end: true },
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
      subLabel="Admin"
      brand={({ size, showToast }) => (
        <AppSwitcher
          current="admin"
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

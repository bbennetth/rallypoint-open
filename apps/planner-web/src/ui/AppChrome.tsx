import { useMemo, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  AppChrome as SharedAppChrome,
  AppSwitcher,
  UserMenu,
  isEmbeddedShell,
} from '@rallypoint/ui'
import { signout } from '../lib/api.js'
import { useSession, RPID_UI_URL } from '../lib/session.js'
import { QuickAdd } from './QuickAdd.js'
import { NAV } from './nav.js'
import { useTabOrder, orderNav } from '../lib/tab-order.js'

// Planner chrome: a thin wrapper over the shared @rallypoint/ui AppChrome (the
// Ink shell promoted out of this app in the UI-stack-wide migration). Planner
// supplies its own nav config, the app-switcher + user-menu wired to its
// session/api, and the quick-add FAB.

export function AppChrome({ children }: { children: ReactNode }) {
  const navigate = useNavigate()
  const { profile } = useSession()
  const order = useTabOrder()
  const nav = useMemo(() => orderNav(NAV, order), [order])
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
      nav={nav}
      subLabel="Planner"
      brand={
        embedded
          ? undefined
          : ({ size, showToast }) => (
              <AppSwitcher
                current="planner"
                size={size}
                onToast={showToast}
                onSignout={handleSignout}
                onOpenSettings={() => navigate('/settings')}
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
      fab={({ showToast }) => <QuickAdd onToast={showToast} />}
    >
      {children}
    </SharedAppChrome>
  )
}

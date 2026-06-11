import type { ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import type { UserInfo } from '@rallypoint/shared'
import {
  AppChrome as SharedAppChrome,
  AppSwitcher,
  UserMenu,
  isEmbeddedShell,
  type AppChromeNavItem,
} from '@rallypoint/ui'
import { resetAnalytics } from '@rallypoint/web-kit'
import { api } from '../api/client.js'

// Layout shell for the /account/* pages — migrated onto the shared Ink
// AppChrome (issue #397 Phase 5). Nav = the two account sections;
// AppSwitcher current="id" lets the user jump to sibling apps.
// accountUrl is omitted from UserMenu since id IS the account app —
// hiding the redundant "Account" row; only "Logout" shows.

export interface AccountShellProps {
  user: UserInfo
  children: ReactNode
}

const NAV: readonly AppChromeNavItem[] = [
  { to: '/account/settings', label: 'Account settings', icon: 'sliders', end: true },
  { to: '/account/delete', label: 'Delete account', icon: 'trash', end: true },
]

export function AccountShell({ user, children }: AccountShellProps) {
  const navigate = useNavigate()
  // Opened from another app's switcher inside the iOS PWA → drop our own
  // switcher + account icon so this reads as an embedded view.
  const embedded = isEmbeddedShell()

  async function handleSignout() {
    await api.post('/api/v1/ui/signout')
    resetAnalytics()
    navigate('/signin')
  }

  const profile = {
    picture_url: user.picture,
    username: user.name,
    first_name: user.first_name,
    last_name: user.last_name,
    email: user.email,
  }

  return (
    <SharedAppChrome
      nav={NAV}
      subLabel="Account"
      brand={
        embedded
          ? undefined
          : ({ size, showToast }) => (
              <AppSwitcher
                current="id"
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
                profile={profile}
                onSignout={handleSignout}
              />
            )
      }
    >
      {children}
    </SharedAppChrome>
  )
}

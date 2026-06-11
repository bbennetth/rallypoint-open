import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import {
  AppChrome as SharedAppChrome,
  AppSwitcher,
  UserMenu,
  isEmbeddedShell,
  type AppChromeNavItem,
} from '@rallypoint/ui'
import { signout } from '../lib/api.js'
import { useSession, RPID_UI_URL } from '../lib/session.js'

// Events owner chrome: a thin wrapper over the shared @rallypoint/ui AppChrome.
//
// Two modes:
//   - Global (no eventContext): app-switcher brand + UserMenu + 3-item global nav.
//   - Event-scoped (eventContext set): back-affordance brand + UserMenu + 9-tab nav.

export interface EventContextProps {
  slug: string
  name: string
}

export interface AppChromeProps {
  children: ReactNode
  /**
   * When supplied, the sidebar switches to event-scoped nav (back to
   * /me/events + event-name heading + per-event tab list). Use from
   * the `<EventOwnerLayout>` route wrapper.
   */
  eventContext?: EventContextProps
}

const GLOBAL_NAV: readonly AppChromeNavItem[] = [
  { to: '/me/events', label: 'My Events', icon: 'events', end: true },
  { to: '/events/new', label: 'New Event', icon: 'plus', end: true },
  { to: '/events/join', label: 'Join', icon: 'download', end: true },
]

function eventNavFor(slug: string): readonly AppChromeNavItem[] {
  const base = `/events/${encodeURIComponent(slug)}`
  return [
    { to: base, label: 'Overview', icon: 'grid', end: true },
    { to: `${base}/lineup`, label: 'Lineup', icon: 'events' },
    { to: `${base}/sessions`, label: 'Sessions', icon: 'clock' },
    { to: `${base}/map`, label: 'Map', icon: 'pin' },
    { to: `${base}/attendees`, label: 'Attendees', icon: 'more' },
    { to: `${base}/public`, label: 'Public Page', icon: 'file' },
    { to: `${base}/tickets`, label: 'Tickets', icon: 'download' },
    { to: `${base}/settings`, label: 'Settings', icon: 'sliders' },
    { to: `${base}/preview`, label: 'Preview', icon: 'chevron' },
  ]
}

export function AppChrome({ children, eventContext }: AppChromeProps) {
  const { profile } = useSession()
  // Opened from another app's switcher inside the iOS PWA → drop our own
  // switcher + account icon so this reads as an embedded view. The event-scoped
  // back-affordance is kept (it's in-app navigation, not a cross-app switcher).
  const embedded = isEmbeddedShell()

  async function handleSignout() {
    try {
      await signout()
    } finally {
      window.location.assign('/')
    }
  }

  const nav = eventContext ? eventNavFor(eventContext.slug) : GLOBAL_NAV
  const subLabel = eventContext ? eventContext.name : 'Events'

  const brand = eventContext
    ? // Event-scoped: Ink back-affordance showing ← Events + event name
      ({ size }: { size: 'desktop' | 'mobile' }) => (
        <Link
          to="/me/events"
          style={{
            display: 'flex',
            flexDirection: size === 'desktop' ? 'column' : 'row',
            alignItems: size === 'desktop' ? 'flex-start' : 'center',
            gap: size === 'desktop' ? 4 : 6,
            textDecoration: 'none',
            minWidth: 0,
          }}
          aria-label="Back to all events"
        >
          <span
            style={{
              fontSize: 11,
              color: 'var(--ink-mute)',
              whiteSpace: 'nowrap',
            }}
          >
            ← Events
          </span>
          <span
            style={{
              fontSize: size === 'desktop' ? 14 : 13,
              fontWeight: 500,
              color: 'var(--ink)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              minWidth: 0,
              maxWidth: '100%',
            }}
            title={eventContext.name}
          >
            {eventContext.name}
          </span>
        </Link>
      )
    : // Global: full app-switcher
      ({ size, showToast }: { size: 'desktop' | 'mobile'; showToast: (msg: string) => void }) => (
        <AppSwitcher
          current="events"
          size={size}
          onToast={showToast}
          onSignout={handleSignout}
          appVersion={import.meta.env.VITE_APP_VERSION}
        />
      )

  return (
    <SharedAppChrome
      nav={nav}
      subLabel={subLabel}
      brand={embedded && !eventContext ? undefined : brand}
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

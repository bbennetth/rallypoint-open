import { useEffect, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import {
  AppChrome as SharedAppChrome,
  AppSwitcher,
  SwUpdateBanner,
  UserMenu,
  isEmbeddedShell,
  type AppChromeNavItem,
} from '@rallypoint/ui'
import { bootSucceeded, useSwUpdatePrompt } from '@rallypoint/web-kit'
import type { EventFeatures } from '@rallypoint/events-shared'
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
  features?: EventFeatures
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
  { to: '/browse', label: 'Browse', icon: 'search', end: true },
  { to: '/events/new', label: 'New Event', icon: 'plus', end: true },
  { to: '/events/join', label: 'Join', icon: 'download', end: true },
]

function eventNavFor(slug: string, features?: EventFeatures): readonly AppChromeNavItem[] {
  const base = `/events/${encodeURIComponent(slug)}`
  return [
    { to: base, label: 'Overview', icon: 'grid', end: true },
    // Feature-gated tabs (#216). undefined = not loaded yet → show all.
    ...(features === undefined || features.lineup
      ? [{ to: `${base}/lineup`, label: 'Lineup', icon: 'events' } as const]
      : []),
    ...(features === undefined || features.sessions
      ? [{ to: `${base}/sessions`, label: 'Sessions', icon: 'clock' } as const]
      : []),
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
  const { updateReady, applyUpdate } = useSwUpdatePrompt()
  // Shell mounted — tell the boot watchdog this launch made it, so the
  // white-screen failure counter resets.
  useEffect(() => {
    bootSucceeded()
  }, [])

  async function handleSignout() {
    try {
      await signout()
    } finally {
      window.location.assign('/')
    }
  }

  const nav = eventContext ? eventNavFor(eventContext.slug, eventContext.features) : GLOBAL_NAV
  const subLabel = eventContext ? eventContext.name : 'Events'

  const brand = eventContext
    ? // Event-scoped: kit's `.ev-scope` shell — `← My Events` mono micro-link
      // back to the global list + display-font event name. Role chip is
      // rendered separately by EventOwnerLayout via the `sidebarEyebrow`
      // slot since the role lives in the event payload, not the chrome.
      ({ size }: { size: 'desktop' | 'mobile' }) => (
        <div
          className="ev-scope"
          style={
            size === 'desktop'
              ? undefined
              : {
                  // Mobile top-bar: row layout, no padding/border (the
                  // app-header already provides the surface chrome).
                  padding: 0,
                  border: 'none',
                  gridTemplateColumns: 'auto 1fr',
                  alignItems: 'center',
                  columnGap: 8,
                  gap: 0,
                }
          }
        >
          <Link
            to="/me/events"
            className="ev-back"
            aria-label="Back to all events"
          >
            ← My Events
          </Link>
          <span
            className="ev-scope-name"
            title={eventContext.name}
            style={
              size === 'desktop'
                ? undefined
                : {
                    fontSize: 13,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    minWidth: 0,
                  }
            }
          >
            {eventContext.name}
          </span>
        </div>
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

  const showBrand = !(embedded && !eventContext)
  const userMenu = embedded
    ? undefined
    : ({ size }: { size: 'desktop' | 'mobile' }) => (
        <UserMenu
          size={size}
          profile={profile ?? null}
          onSignout={handleSignout}
          accountUrl={`${RPID_UI_URL}/account/settings`}
        />
      )

  return (
    <SharedAppChrome
      nav={nav}
      subLabel={subLabel}
      {...(showBrand ? { brand } : {})}
      {...(userMenu ? { userMenu } : {})}
    >
      <SwUpdateBanner updateReady={updateReady} onReload={applyUpdate} />
      {children}
    </SharedAppChrome>
  )
}

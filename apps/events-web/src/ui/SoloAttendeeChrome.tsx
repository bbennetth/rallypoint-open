import { Link, Outlet, useNavigate, useParams } from 'react-router-dom'
import { useEffect, useState, type ReactNode } from 'react'
import {
  AppChrome as SharedAppChrome,
  BrandLockup,
  ThemeToggle,
  type AppChromeNavItem,
} from '@rallypoint/ui'
import { ApiError, getEvent, type EventDto, type EventFeatures } from '../lib/api.js'

// Phase 4 of platform/v-1.1 (#16). Migrated onto the shared @rallypoint/ui
// AppChrome. Wraps solo-attendee tab routes under `/events/:slug/attending/*`.
// Mirrors the 6-tab shape (Now / My Day / Lineup / Group / Rallies / Chat).
// Loads the event once and shares it with child routes via <Outlet context>;
// pages call `useSoloEventOutlet()` (in _solo-event-outlet.ts) to read it.

export interface SoloEventOutlet {
  event: EventDto
}

function tabsFor(slug: string, features?: EventFeatures): readonly AppChromeNavItem[] {
  const base = `/events/${encodeURIComponent(slug)}/attending`
  return [
    { to: `${base}/now`, label: 'Now', icon: 'clock', end: true },
    { to: `${base}/day`, label: 'My Day', icon: 'myday', end: true },
    // Feature-gated tabs (#216): hide what the owner toggled off.
    // `features` is undefined while the event is still loading.
    ...(features === undefined || features.lineup
      ? [{ to: `${base}/lineup`, label: 'Lineup', icon: 'events', end: true } as const]
      : []),
    ...(features === undefined || features.groups
      ? [{ to: `${base}/group`, label: 'Group', icon: 'grid', end: true } as const]
      : []),
    { to: `${base}/rallies`, label: 'Rallies', icon: 'bell', end: true },
    { to: `${base}/chat`, label: 'Chat', icon: 'more', end: true },
  ]
}

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; event: EventDto }
  | { status: 'error'; message: string }

export function SoloAttendeeLayout() {
  const { slug } = useParams<{ slug: string }>()
  const navigate = useNavigate()
  const [state, setState] = useState<LoadState>({ status: 'loading' })

  useEffect(() => {
    if (!slug) return
    let cancelled = false
    void getEvent(slug)
      .then((event) => {
        if (!cancelled) setState({ status: 'ready', event })
      })
      .catch((err: unknown) => {
        if (cancelled) return
        if (err instanceof ApiError && err.status === 404) {
          void navigate('/me/events', { replace: true })
          return
        }
        setState({
          status: 'error',
          message: err instanceof ApiError ? err.message : 'Failed to load event.',
        })
      })
    return () => {
      cancelled = true
    }
  }, [slug, navigate])

  if (state.status === 'loading') {
    return (
      <ChromeShell title="Loading…" slug={slug ?? ''}>
        <main className="page-pad">
          <p className="text-sm text-white/60">Loading event…</p>
        </main>
      </ChromeShell>
    )
  }

  if (state.status === 'error') {
    return (
      <ChromeShell title="Error" slug={slug ?? ''}>
        <main className="page-pad">
          <p className="text-sm text-white/80">{state.message}</p>
        </main>
      </ChromeShell>
    )
  }

  return (
    <ChromeShell
      title={state.event.name}
      slug={state.event.slug}
      features={state.event.features}
    >
      {state.event.viewer_role === 'owner' && (
        <OwnerPreviewBanner slug={state.event.slug} />
      )}
      <Outlet context={{ event: state.event } satisfies SoloEventOutlet} />
    </ChromeShell>
  )
}

// Shown to event owners who landed on the solo-attendee shell via
// the owner "Preview" tab — makes the preview state obvious and
// gives a one-click route back to the owner chrome.
function OwnerPreviewBanner({ slug }: { slug: string }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        padding: '10px 16px',
        background: 'var(--surface-2)',
        borderBottom: '1.5px solid var(--line)',
      }}
    >
      <span
        style={{
          fontSize: 11,
          color: 'var(--ink-dim)',
        }}
      >
        Previewing as attendee
      </span>
      <Link
        to={`/events/${encodeURIComponent(slug)}`}
        style={{
          fontSize: 11,
          color: 'var(--acid)',
          textDecoration: 'none',
        }}
      >
        Return to owner view
      </Link>
    </div>
  )
}

function ChromeShell({
  title,
  slug,
  features,
  children,
}: {
  title: string
  slug: string
  features?: EventFeatures
  children: ReactNode
}) {
  const tabs = tabsFor(slug, features)

  return (
    <SharedAppChrome
      nav={tabs}
      subLabel="Attending"
      brand={({ size }) => (
        <Link
          to="/me/events"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            textDecoration: 'none',
            flex: '1 1 0',
            minWidth: 0,
          }}
          aria-label="Back to all events"
        >
          <BrandLockup size={size === 'desktop' ? 20 : 22} />
          {title && title !== 'Loading…' && (
            <span
              style={{
                fontSize: 12,
                color: 'var(--ink-dim)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                minWidth: 0,
              }}
              title={title}
            >
              {title}
            </span>
          )}
        </Link>
      )}
      userMenu={() => <ThemeToggle />}
    >
      {children}
    </SharedAppChrome>
  )
}

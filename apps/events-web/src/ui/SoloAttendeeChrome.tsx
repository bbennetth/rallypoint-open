import { Link, Outlet, useNavigate, useParams } from 'react-router-dom'
import { useEffect, useState, type ReactNode } from 'react'
import {
  AppChrome as SharedAppChrome,
  BrandLockup,
  ThemeToggle,
  type AppChromeNavItem,
} from '@rallypoint/ui'
import { useAsyncTask } from '@rallypoint/web-kit'
import { useEventPwaHead } from '../lib/installPrompt.js'
import { InstallEventBanner } from './InstallEventBanner.js'
import {
  ApiError,
  getEvent,
  joinAttendance,
  type EventDto,
  type EventFeatures,
} from '../lib/api.js'

// Phase 4 of platform/v-1.1 (#16). Migrated onto the shared @rallypoint/ui
// AppChrome. Wraps solo-attendee tab routes under `/events/:slug/attending/*`.
// Mirrors the group shell's 5 tabs (Now / Lineup / Map / Group / Rallies).
// Loads the event once and shares it with child routes via <Outlet context>;
// pages call `useSoloEventOutlet()` (in _solo-event-outlet.ts) to read it.

export interface SoloEventOutlet {
  event: EventDto
}

export function tabsFor(slug: string, features?: EventFeatures): readonly AppChromeNavItem[] {
  const base = `/events/${encodeURIComponent(slug)}/attending`
  // Now / Lineup / Map / Group / Rallies — mirrors the group shell.
  // "My Day" merged into Now, which carries the day picker and that day's
  // agenda. Map took Social's slot when chat was dropped. (Feature-gated
  // tabs — Lineup/Group — are still respected when the owner toggles them
  // off, and default on while features load.)
  return [
    { to: `${base}/now`, label: 'Now', icon: 'clock', end: true },
    ...(features === undefined || features.lineup
      ? [{ to: `${base}/lineup`, label: 'Lineup', icon: 'events', end: true } as const]
      : []),
    { to: `${base}/map`, label: 'Map', icon: 'pin', end: true },
    ...(features === undefined || features.groups
      ? [{ to: `${base}/group`, label: 'Group', icon: 'grid', end: true } as const]
      : []),
    { to: `${base}/rallies`, label: 'Rallies', icon: 'bell', end: true },
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
  // Bumped after the owner joins attendance so the event (and its
  // viewer_attending flag) re-loads.
  const [reloadKey, setReloadKey] = useState(0)
  const run = useAsyncTask()

  useEffect(() => {
    if (!slug) return
    void run(async (ctx) => {
      try {
        const event = await getEvent(slug)
        if (ctx.stale()) return
        setState({ status: 'ready', event })
      } catch (err) {
        if (ctx.stale()) return
        if (err instanceof ApiError && err.status === 404) {
          void navigate('/me/events', { replace: true })
          return
        }
        setState({
          status: 'error',
          message: err instanceof ApiError ? err.message : 'Failed to load event.',
        })
      }
    })
  }, [slug, navigate, run, reloadKey])

  // Point the document's manifest + iOS icon/title at THIS event while
  // the attendee shell is mounted, so an install from here becomes a
  // per-event app rather than the generic Events install. Restored on
  // unmount — see lib/pwaHead.ts.
  const ready = state.status === 'ready' ? state.event : null
  useEventPwaHead(
    ready
      ? {
          eventId: ready.id,
          name: ready.name,
          hasIcon: Boolean(ready.public_page_config?.theme?.icon_image_key),
        }
      : null,
  )

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
        <OwnerPreviewBanner
          event={state.event}
          onJoined={() => setReloadKey((k) => k + 1)}
        />
      )}
      <InstallEventBanner eventId={state.event.id} eventName={state.event.name} />
      <Outlet context={{ event: state.event } satisfies SoloEventOutlet} />
    </ChromeShell>
  )
}

// Shown to event owners on the solo-attendee shell. Read-only preview
// state offers a real "Join as attendee" action (creates an actual
// event_attendees row — roster, groups, rallies); once attending the
// banner reflects it. Either way there's a one-click route back to
// the owner chrome.
function OwnerPreviewBanner({
  event,
  onJoined,
}: {
  event: EventDto
  onJoined: () => void
}) {
  const [busy, setBusy] = useState(false)
  const attending = event.viewer_attending === true

  async function join() {
    setBusy(true)
    try {
      await joinAttendance(event.id)
      onJoined()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        padding: '10px 16px',
        background: 'var(--surface-2)',
        borderBottom: '1px solid var(--hairline-soft)',
      }}
    >
      <span
        style={{
          fontSize: 11,
          color: 'var(--ink-dim)',
        }}
      >
        {attending ? 'Attending as owner' : 'Previewing as attendee'}
      </span>
      <span style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
        {!attending && (
          <button
            type="button"
            onClick={() => void join()}
            disabled={busy}
            style={{
              fontSize: 11,
              color: 'var(--acid)',
              background: 'none',
              border: 'none',
              padding: 0,
              cursor: 'pointer',
            }}
          >
            Join as attendee
          </button>
        )}
        <Link
          to={`/events/${encodeURIComponent(event.slug)}`}
          style={{
            fontSize: 11,
            color: 'var(--acid)',
            textDecoration: 'none',
          }}
        >
          Return to owner view
        </Link>
      </span>
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

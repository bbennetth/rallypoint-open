import { Link, Outlet, useOutletContext, useParams } from 'react-router-dom'
import { useCallback, useEffect, useRef } from 'react'
import {
  AppChrome as SharedAppChrome,
  BrandLockup,
  PullToRefresh,
  ThemeToggle,
  useConnectionView,
  type AppChromeNavItem,
} from '@rallypoint/ui'
import { useAsyncTask } from '@rallypoint/web-kit'
import { useActiveGroupStore } from '../stores/active-group.js'
import { getGroup } from '../lib/api.js'
import { readGroupDetail, writeGroupDetail } from '../lib/cache.js'
import { publishRefresh } from '../lib/refresh-bus.js'
import { subscribeGroupStream } from '../lib/realtime.js'
import { useEventPwaHead } from '../lib/installPrompt.js'
import { InstallEventBanner } from './InstallEventBanner.js'

// Attendee-side shell (slice 13). Migrated onto the shared @rallypoint/ui
// AppChrome (Ink shell). Data-loading hooks are preserved exactly — only
// the chrome JSX has changed. Mounts on /groups/:groupId/* routes.

export function buildNav(groupId: string): readonly AppChromeNavItem[] {
  const base = `/groups/${encodeURIComponent(groupId)}`
  // Now / Lineup / Map / Group / Rallies. "My Day" used to sit between
  // Lineup and Group; it merged into Now, which now carries the day picker
  // and that day's agenda. Map took Social's slot when chat was dropped.
  return [
    { to: `${base}/now`, label: 'Now', icon: 'clock', end: true },
    { to: `${base}/lineup`, label: 'Lineup', icon: 'events', end: true },
    { to: `${base}/map`, label: 'Map', icon: 'pin', end: true },
    { to: base, label: 'Group', icon: 'grid', end: true },
    { to: `${base}/rallies`, label: 'Rallies', icon: 'bell', end: true },
  ]
}

// Populate useActiveGroupStore for the current :groupId. Reads from
// cache instantly; revalidates from the API; clears on unmount.
function useHydrateActiveGroup(groupId: string | undefined): void {
  const set = useActiveGroupStore((s) => s.set)
  const clear = useActiveGroupStore((s) => s.clear)
  const run = useAsyncTask()
  useEffect(() => {
    if (!groupId) return
    void run(async (ctx) => {
      const cached = await readGroupDetail<{
        id: string
        name: string
        event_id: string
        event_name?: string | null
        event_has_app_icon?: boolean
        viewer_role: import('../lib/api.js').GroupRole
      }>(groupId)
      if (!ctx.stale() && cached) {
        set({
          groupId: cached.id,
          groupName: cached.name,
          eventId: cached.event_id,
          eventSlug: null,
          // Optional on the cached shape: entries written before these
          // fields existed replay without them.
          eventName: cached.event_name ?? null,
          eventHasAppIcon: cached.event_has_app_icon ?? false,
          viewerRole: cached.viewer_role,
        })
      }
      try {
        const fresh = await getGroup(groupId)
        if (ctx.stale()) return
        await writeGroupDetail(groupId, fresh).catch(() => {})
        set({
          groupId: fresh.id,
          groupName: fresh.name,
          eventId: fresh.event_id,
          eventSlug: null, // group DTO doesn't carry event slug; populated lazily by callers if needed
          eventName: fresh.event_name,
          eventHasAppIcon: fresh.event_has_app_icon,
          viewerRole: fresh.viewer_role,
        })
      } catch {
        // Network failure — leave the cached values (if any) in the
        // store. Pages will degrade per their own error handling.
      }
    })
    return () => {
      clear()
    }
  }, [groupId, set, clear, run])
}

// Mount the group SSE for the lifetime of the chrome — without it the
// connection-status store would only flip `synced=true` when a
// subscribing page was open, so the BrandLockup dot would age
// amber→red on the other attendee tabs (Now, Lineup, Rallies, Group)
// even though everything was healthy. The chrome subscriber uses a
// no-op `onEvent`; pages that want event-driven refetches still mount
// their own subscription alongside (e.g. the Map tab) and the realtime
// ref-counter keeps the store coherent across both.
function useChromeGroupStream(groupId: string | undefined): void {
  useEffect(() => {
    if (!groupId) return
    const unsubscribe = subscribeGroupStream(groupId, {
      onEvent: () => {
        // Chrome-level subscriber drives connection-status only; the
        // page-level subscribers handle their own refetches.
      },
    })
    return unsubscribe
  }, [groupId])
}

// React Router 6 layout-route variant of AttendeeChrome (#158). Renders
// the shared shell once per `/groups/:groupId/*` visit and lets nested
// routes paint into `<Outlet />` instead of remounting the chrome on
// every tab nav.
//
// Pages that need the per-route `userId` read it via `useAttendeeOutlet()`.
export interface AttendeeOutlet {
  groupId: string
  userId: string
}

export function useAttendeeOutlet(): AttendeeOutlet {
  return useOutletContext<AttendeeOutlet>()
}

export function AttendeeLayout({ userId }: { userId: string }) {
  const { groupId } = useParams<{ groupId: string }>()
  useHydrateActiveGroup(groupId)
  useChromeGroupStream(groupId)
  const groupName = useActiveGroupStore((s) => s.groupName)
  const eventId = useActiveGroupStore((s) => s.eventId)
  const eventName = useActiveGroupStore((s) => s.eventName)
  const eventHasAppIcon = useActiveGroupStore((s) => s.eventHasAppIcon)
  const connectionView = useConnectionView()

  // Per-event PWA head tags for the group surface. `start=group:<id>`
  // makes an install from here cold-launch into this group's Now view.
  useEventPwaHead(
    eventId && eventName && groupId
      ? { eventId, name: eventName, groupId, hasIcon: eventHasAppIcon }
      : null,
  )
  const nav = groupId ? buildNav(groupId) : []
  const mainRef = useRef<HTMLElement | null>(null)

  // PullToRefresh treats a `false` return as "don't drive the
  // connection-store handshake". AttendeeChrome only kicks data
  // revalidate via the bus — it doesn't recreate the EventSource,
  // so flipping `synced` would strand the dot amber until the
  // PTR safety timeout fires. Returning false lets PTR show the
  // brief pull/release indicator and clear cleanly.
  const onRefresh = useCallback((): boolean => {
    publishRefresh()
    return false
  }, [])

  return (
    <SharedAppChrome
      nav={nav}
      subLabel="Attendee"
      brand={() => (
        <Link
          to="/me/events"
          aria-label="Open all events"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            textDecoration: 'none',
            flex: '1 1 0',
            minWidth: 0,
          }}
        >
          <BrandLockup size={22} connectionView={connectionView} />
          {groupName && (
            <span
              style={{
                fontSize: 12,
                color: 'var(--ink-dim)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                minWidth: 0,
              }}
            >
              {groupName}
            </span>
          )}
        </Link>
      )}
      userMenu={() => <ThemeToggle />}
      mainRef={mainRef}
      mainOverlay={
        <PullToRefresh scrollRef={mainRef} onRefresh={onRefresh} disabled={false} />
      }
    >
      {eventId && eventName && (
        <InstallEventBanner eventId={eventId} eventName={eventName} />
      )}
      <Outlet context={{ groupId: groupId ?? '', userId } satisfies AttendeeOutlet} />
    </SharedAppChrome>
  )
}

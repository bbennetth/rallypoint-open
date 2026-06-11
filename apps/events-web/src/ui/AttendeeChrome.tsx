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
import { useActiveGroupStore } from '../stores/active-group.js'
import { getGroup } from '../lib/api.js'
import { readGroupDetail, writeGroupDetail } from '../lib/cache.js'
import { publishRefresh } from '../lib/refresh-bus.js'
import { subscribeGroupStream } from '../lib/realtime.js'

// Attendee-side shell (slice 13). Migrated onto the shared @rallypoint/ui
// AppChrome (Ink shell). Data-loading hooks are preserved exactly — only
// the chrome JSX has changed. Mounts on /groups/:groupId/* routes.

function buildNav(groupId: string): readonly AppChromeNavItem[] {
  const base = `/groups/${encodeURIComponent(groupId)}`
  return [
    { to: `${base}/now`, label: 'Now', icon: 'clock', end: true },
    { to: `${base}/day`, label: 'My Day', icon: 'myday', end: true },
    { to: base, label: 'Group', icon: 'grid', end: true },
    { to: `${base}/rallies`, label: 'Rallies', icon: 'bell', end: true },
    { to: `${base}/chat`, label: 'Chat', icon: 'more', end: true },
  ]
}

// Populate useActiveGroupStore for the current :groupId. Reads from
// cache instantly; revalidates from the API; clears on unmount.
function useHydrateActiveGroup(groupId: string | undefined): void {
  const set = useActiveGroupStore((s) => s.set)
  const clear = useActiveGroupStore((s) => s.clear)
  useEffect(() => {
    if (!groupId) return
    let active = true
    void (async () => {
      const cached = await readGroupDetail<{
        id: string
        name: string
        event_id: string
        viewer_role: import('../lib/api.js').MemberRole
      }>(groupId)
      if (active && cached) {
        set({
          groupId: cached.id,
          groupName: cached.name,
          eventId: cached.event_id,
          eventSlug: null,
          eventName: null,
          viewerRole: cached.viewer_role,
        })
      }
      try {
        const fresh = await getGroup(groupId)
        if (!active) return
        await writeGroupDetail(groupId, fresh).catch(() => {})
        set({
          groupId: fresh.id,
          groupName: fresh.name,
          eventId: fresh.event_id,
          eventSlug: null, // group DTO doesn't carry event slug; populated lazily by callers if needed
          eventName: null,
          viewerRole: fresh.viewer_role,
        })
      } catch {
        // Network failure — leave the cached values (if any) in the
        // store. Pages will degrade per their own error handling.
      }
    })()
    return () => {
      active = false
      clear()
    }
  }, [groupId, set, clear])
}

// Mount the group SSE for the lifetime of the chrome — without it the
// connection-status store would only flip `synced=true` when ChatPage
// was open, so the BrandLockup dot would age amber→red on the other
// attendee tabs (Now, My Day, Rallies, Group) even though everything
// was healthy. The chrome subscriber uses a no-op `onEvent`; pages
// that want event-driven refetches still mount their own subscription
// alongside (e.g. ChatPage) and the realtime ref-counter keeps the
// store coherent across both.
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
  const connectionView = useConnectionView()
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
      <Outlet context={{ groupId: groupId ?? '', userId } satisfies AttendeeOutlet} />
    </SharedAppChrome>
  )
}

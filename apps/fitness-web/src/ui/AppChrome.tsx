import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  AppChrome as SharedAppChrome,
  AppSwitcher,
  SwUpdateBanner,
  UserMenu,
  type AppChromeNavItem,
} from '@rallypoint/ui'
import {
  ApiError,
  bootSucceeded,
  captureEvent,
  captureException,
  usePushSync,
  useSwUpdatePrompt,
} from '@rallypoint/web-kit'
import { SESSION_REVOKED_EVENT, signout } from '../lib/api.js'
import { pushResync } from '../lib/rest-push.js'
import { setOfflineUser } from '../lib/offline/cache.js'
import { purgeOfflineUser, useOfflineSync } from '../lib/offline/hooks.js'
import { useSession, RPID_UI_URL, beginSso } from '../lib/session.js'
import { ResumeSessionPill } from './ResumeSessionPill.js'
import { MigrationOfferGate } from './MigrationOfferGate.js'

// Fitness chrome: a thin wrapper over the shared @rallypoint/ui AppChrome
// (the Ink shell). Per the design handoff, four tabs at the root —
// Log / Plan / Library / Stats. Each tab renders its own docked SubBar
// with the quick-add FAB attached as a flex child (per the planner
// convention — the FitFab popover is self-contained, see FitFab.tsx).
// The chrome only owns nav + brand + user menu.

const NAV: readonly AppChromeNavItem[] = [
  { to: '/log', label: 'Log', icon: 'calendar' },
  { to: '/food', label: 'Food', icon: 'flame' },
  { to: '/plan', label: 'Plan', icon: 'week-grid' },
  { to: '/library', label: 'Library', icon: 'grid' },
  { to: '/stats', label: 'Stats', icon: 'bar-chart' },
]

export function AppChrome({ children }: { children: ReactNode }) {
  const navigate = useNavigate()
  const { userId, profile } = useSession()
  const { updateReady, applyUpdate } = useSwUpdatePrompt()
  // Shell mounted — tell the boot watchdog this launch made it, so the
  // white-screen failure counter resets.
  useEffect(() => {
    bootSucceeded()
  }, [])
  // Surface rejected outbox ops (server said no to a write the UI already
  // showed as done). Auto-dismisses; the reconcile refetch reverts the
  // optimistic change on screen.
  const [opError, setOpError] = useState<string | null>(null)
  const opErrorTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (opErrorTimer.current) clearTimeout(opErrorTimer.current)
    },
    [],
  )
  const onAuthRequired = useCallback(() => {
    // The queue survives the bounce; the flusher resumes post-reauth.
    beginSso(window.location.pathname + window.location.search)
  }, [])
  // The instant-boot session revalidation found the session revoked
  // (401/403 after we already rendered from the cached SessionDto) —
  // bounce to SSO exactly as a blocking probe failure would have.
  useEffect(() => {
    window.addEventListener(SESSION_REVOKED_EVENT, onAuthRequired)
    return () => window.removeEventListener(SESSION_REVOKED_EVENT, onAuthRequired)
  }, [onAuthRequired])
  // `op`/`err` are optional so this stays assignable to the msg-only
  // `onError: (msg: string) => void` shape MigrationOfferGate expects
  // below — useOfflineSync always supplies all three.
  const onOpFailed = useCallback((msg: string, op?: { type: string }, err?: unknown) => {
    setOpError(msg)
    if (opErrorTimer.current) clearTimeout(opErrorTimer.current)
    opErrorTimer.current = setTimeout(() => setOpError(null), 6000)
    if (!op) return
    const code = err instanceof ApiError ? err.code : undefined
    const detail =
      err instanceof ApiError && err.detail !== undefined
        ? JSON.stringify(err.detail).slice(0, 2000)
        : undefined
    captureException(err, {
      feature: 'outbox-flush',
      op_type: op.type,
      ...(code !== undefined ? { code } : {}),
      ...(detail !== undefined ? { detail } : {}),
    })
    if (op.type === 'workout:create') {
      captureEvent('workout_save_failed', { code })
    }
  }, [])
  // Wire the offline write-queue: listeners on online + visible, and a
  // flush on user-switch. Safe to mount before userId resolves — the
  // hook no-ops until it does.
  useOfflineSync(userId, onAuthRequired, onOpFailed)
  // Re-register the Web Push subscription on launch and on tab-visible.
  // iOS rotates push endpoints behind the app's back; without this the
  // server's row is reaped on the first 404/410 and rest-timer alerts
  // die silently until the user re-picks +Notify.
  usePushSync(userId, pushResync)

  async function handleSignout() {
    try {
      // Drop this user's offline state before clearing the session so a
      // shared device never carries one user's private training data into
      // the next. purgeOfflineUser disposes the flusher first — a pending
      // retry timer must not race its flush() against the just-deleted
      // Dexie DB.
      if (userId) {
        setOfflineUser(null)
        await purgeOfflineUser(userId)
      }
      await signout()
    } finally {
      navigate('/', { replace: true })
    }
  }

  // The `fab` slot on SharedAppChrome is intentionally NOT passed — every
  // fitness tab carries its own SubBar with a docked FAB, so the kit's
  // "FAB attached to the sub-bar" composition falls out of the page-side
  // declaration. Mirrors apps/planner-web/src/ui/AppChrome.tsx.
  return (
    <SharedAppChrome
      nav={NAV}
      subLabel="Health"
      brand={({ size, showToast }) => {
        const v = import.meta.env.VITE_APP_VERSION
        return (
          <AppSwitcher
            current="fitness"
            size={size}
            onToast={showToast}
            onSignout={handleSignout}
            onOpenSettings={() => navigate('/settings')}
            {...(v ? { appVersion: v } : {})}
          />
        )
      }}
      userMenu={({ size }) => (
        <UserMenu
          size={size}
          profile={profile ?? null}
          onSignout={handleSignout}
          accountUrl={`${RPID_UI_URL}/account/settings`}
        />
      )}
    >
      <SwUpdateBanner updateReady={updateReady} onReload={applyUpdate} />
        {opError && (
          <div
            role="alert"
            style={{
              position: 'fixed',
              insetInline: 0,
              bottom: 0,
              zIndex: 300,
              display: 'flex',
              justifyContent: 'center',
              padding: '0.5rem',
              pointerEvents: 'none',
            }}
          >
            <div
              style={{
                background: 'var(--hot, #b3261e)',
                color: '#fff',
                borderRadius: '0.5rem',
                padding: '0.5rem 1rem',
                fontSize: '0.875rem',
                boxShadow: '0 2px 8px rgba(0,0,0,0.35)',
                pointerEvents: 'auto',
              }}
            >
              {opError}
            </div>
          </div>
        )}
      {children}
      <ResumeSessionPill />
      <MigrationOfferGate userId={userId} onError={onOpFailed} />
    </SharedAppChrome>
  )
}

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  AppChrome as SharedAppChrome,
  AppSwitcher,
  SwUpdateBanner,
  UserMenu,
  isEmbeddedShell,
} from '@rallypoint/ui'
import { bootSucceeded, usePushSync, useSwUpdatePrompt } from '@rallypoint/web-kit'
import { triggerCachedQueryRefetch } from '@rallypoint/offline-kit'
import { SESSION_REVOKED_EVENT, signout } from '../lib/api.js'
import { pushResync } from '../lib/push.js'
import { SW_DATA_REFRESH_MESSAGE } from '../lib/sw-messages.js'
import { useSession, RPID_UI_URL, beginSso } from '../lib/session.js'
import { setOfflineUser } from '../lib/offline/cache.js'
import { purgeOfflineUser, useOfflineSync } from '../lib/offline/hooks.js'
import { NAV } from './nav.js'
import { useTabOrder, orderNav } from '../lib/tab-order.js'

// Planner chrome: a thin wrapper over the shared @rallypoint/ui AppChrome (the
// Ink shell promoted out of this app in the UI-stack-wide migration). Planner
// supplies its own nav config + the app-switcher + user-menu wired to its
// session/api. The `fab` slot on SharedAppChrome is intentionally NOT passed
// — each page renders its own QuickAdd now (either inside its sub-bar via
// `<QuickAdd anchor="subbar" />` or standalone via `<QuickAdd anchor="float" />`)
// so the kit's "FAB attached to the sub-bar" pattern can compose.

export function AppChrome({ children }: { children: ReactNode }) {
  const navigate = useNavigate()
  const { userId, profile } = useSession()
  const order = useTabOrder()
  const nav = useMemo(() => orderNav(NAV, order), [order])
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
  const onOpFailed = useCallback((msg: string) => {
    setOpError(msg)
    if (opErrorTimer.current) clearTimeout(opErrorTimer.current)
    opErrorTimer.current = setTimeout(() => setOpError(null), 6000)
  }, [])
  // Wire the offline write-queue (E4 O4): listeners on online + visible +
  // SW background-sync, and a flush on user-switch. Safe to mount before
  // userId resolves — the hook no-ops until it does.
  useOfflineSync(userId, onAuthRequired, onOpFailed)
  // Re-register the Web Push subscription on launch and on tab-visible.
  // iOS rotates push endpoints behind the app's back; without this the
  // server's row is reaped on the first 404/410 and reminders die
  // silently until the user toggles notifications off and on.
  usePushSync(userId, pushResync)
  // The SW broadcasts on push receipt (something changed server-side) —
  // revalidate every mounted cached query so the surface is fresh before
  // the user even taps the notification.
  useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.serviceWorker) return
    const onSwMessage = (event: MessageEvent) => {
      const data: unknown = event.data
      if (
        data &&
        typeof data === 'object' &&
        (data as { type?: unknown }).type === SW_DATA_REFRESH_MESSAGE
      ) {
        triggerCachedQueryRefetch()
      }
    }
    navigator.serviceWorker.addEventListener('message', onSwMessage)
    return () => navigator.serviceWorker.removeEventListener('message', onSwMessage)
  }, [])
  // Opened from another app's switcher inside the iOS PWA → drop our own
  // switcher + account icon so this reads as an embedded view.
  const embedded = isEmbeddedShell()

  async function handleSignout() {
    try {
      // Drop this user's offline state before clearing the session so a
      // shared device never carries one user's private data into the next
      // (same hygiene lists-web's AppChrome enforces). purgeOfflineUser
      // disposes the flusher first — a pending retry timer must not race
      // its flush() against the just-deleted Dexie DB.
      if (userId) {
        setOfflineUser(null)
        await purgeOfflineUser(userId)
      }
      await signout()
    } finally {
      navigate('/', { replace: true })
    }
  }

  return (
    <SharedAppChrome
      nav={nav}
      subLabel="Planner"
      {...(!embedded && {
        brand: ({ size, showToast }: { size: 'desktop' | 'mobile'; showToast: (msg: string) => void }) => (
          <AppSwitcher
            current="planner"
            size={size}
            onToast={showToast}
            onSignout={handleSignout}
            onOpenSettings={() => navigate('/settings')}
            {...(import.meta.env.VITE_APP_VERSION && {
              appVersion: import.meta.env.VITE_APP_VERSION,
            })}
          />
        ),
      })}
      {...(!embedded && {
        userMenu: ({ size }: { size: 'desktop' | 'mobile' }) => (
          <UserMenu
            size={size}
            profile={profile ?? null}
            onSignout={handleSignout}
            accountUrl={`${RPID_UI_URL}/account/settings`}
          />
        ),
      })}
    >
      <SwUpdateBanner updateReady={updateReady} onReload={applyUpdate} />
      {opError && (
        <div
          role="alert"
          style={{
            position: 'fixed',
            insetInline: 0,
            // Flush at the bottom, padded past the iOS home-indicator gesture
            // zone so the Dismiss button stays tappable (taps at bottom: 0
            // trigger the app switcher in the standalone PWA).
            bottom: 0,
            zIndex: 300,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '0.75rem',
            padding: '0.6rem 1rem calc(0.6rem + env(safe-area-inset-bottom, 0px))',
            background: 'var(--hot, #b3261e)',
            color: '#fff',
            fontSize: '0.875rem',
          }}
        >
          <span>{opError}</span>
          <button
            type="button"
            onClick={() => setOpError(null)}
            style={{
              background: 'transparent',
              color: '#fff',
              border: '1px solid rgba(255,255,255,0.6)',
              borderRadius: '4px',
              padding: '0.1rem 0.6rem',
              cursor: 'pointer',
            }}
          >
            Dismiss
          </button>
        </div>
      )}
      {children}
    </SharedAppChrome>
  )
}

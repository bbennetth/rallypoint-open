// React glue for the offline layer. One mount-time hook installs the
// connectivity listeners, wires flush triggers, and handles the user-switch
// purge; a second exposes the reactive pending-sync count for the chrome.

import { useEffect, useRef, useState } from 'react'
import { liveQuery } from 'dexie'
import { installConnectionListeners, useConnectionStore, useToast } from '@rallypoint/ui'
import { ApiError } from '../api.js'
import { beginSso } from '../session.js'
import { getDb, purgeUserDb } from './db.js'
import { engine, flushNow } from './engine.js'

// Mount once near the app root (in AppChrome). Wires:
//   • navigator online/offline → connection store;
//   • online-regained and tab-visible → drain the outbox;
//   • a detected user-switch → purge the previous user's offline db;
//   • the engine's auth-required callback → SSO bounce.
export function useOfflineSync(userId: string): void {
  const online = useConnectionStore((s) => s.online)
  const toast = useToast()
  const prevUserId = useRef<string | null>(null)

  // Connectivity listeners are app-global; install once.
  useEffect(() => installConnectionListeners(), [])

  // Route the engine's auth-required signal to the SSO flow.
  useEffect(() => {
    engine.onAuthRequired = () => beginSso()
    return () => {
      engine.onAuthRequired = null
    }
  }, [])

  // Surface a hard-failed (dropped) op so the optimistic revert isn't silent —
  // the flusher's onDrained refetch reverts the row; this explains why.
  useEffect(() => {
    engine.onOpFailed = (_op, err) => {
      toast({
        tone: 'error',
        body: err instanceof ApiError ? `Change not saved: ${err.message}` : 'A change could not be saved and was reverted.',
      })
    }
    return () => {
      engine.onOpFailed = null
    }
  }, [toast])

  // On user change: purge the previous user's offline store, then drain the
  // new user's queue. Opening the db for `userId` first makes purge of the
  // old name safe (different db name, no open-handle conflict).
  useEffect(() => {
    const prev = prevUserId.current
    if (prev && prev !== userId) {
      engine.dispose(prev)
      void purgeUserDb(prev)
    }
    prevUserId.current = userId
    getDb(userId)
    flushNow(userId)
  }, [userId])

  // Drain when connectivity is regained.
  useEffect(() => {
    if (online) flushNow(userId)
  }, [online, userId])

  // Drain when the tab becomes visible again (covers wake-from-background on
  // mobile, where online/offline events can be missed).
  useEffect(() => {
    function onVisible() {
      if (document.visibilityState === 'visible') flushNow(userId)
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [userId])
}

// Reactive count of not-yet-synced ops (pending + inflight), for the chrome's
// "N changes pending" pill. Backed by a Dexie liveQuery so it updates as the
// outbox drains without manual invalidation.
export function useOutboxCount(userId: string): number {
  const [count, setCount] = useState(0)
  useEffect(() => {
    setCount(0)
    const db = getDb(userId)
    const sub = liveQuery(() =>
      db.outbox.where('status').anyOf(['pending', 'inflight']).count(),
    ).subscribe({ next: setCount, error: () => setCount(0) })
    return () => sub.unsubscribe()
  }, [userId])
  return count
}

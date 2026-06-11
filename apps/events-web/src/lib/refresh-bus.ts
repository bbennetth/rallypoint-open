// Tiny pub/sub the attendee shell uses to tell every cached-fetch
// widget AND every imperative page-load on the current page to
// revalidate. PullToRefresh in the shell publishes here; widgets
// subscribe via `useCachedFetch` (which calls `subscribeRefresh`
// internally) or via the `useRefreshBus` hook for pages that own
// a `load()` function.
//
// Kept minimal — no payload, no per-key targeting. The festival-planner
// equivalent just kicks the WS reconnect and lets every subscription
// react. For us, the SSE store + page revalidate hooks are independent,
// so we explicitly fan-out via this bus.

import { useEffect } from 'react'

type Listener = () => void
const listeners = new Set<Listener>()

export function publishRefresh(): void {
  for (const l of [...listeners]) {
    try {
      l()
    } catch {
      // A misbehaving subscriber must not strand siblings.
    }
  }
}

export function subscribeRefresh(fn: Listener): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

// React-friendly wrapper for pages that hold their data outside
// `useCachedFetch` — e.g. MyDayPage / RalliesPage / GroupDetailPage /
// ChatPage each manage their own `load()`. Without this, pull-to-
// refresh would only revalidate cached-fetch widgets (NowPage's
// tiles) and silently do nothing on the other tabs.
export function useRefreshBus(callback: () => void): void {
  useEffect(() => {
    return subscribeRefresh(callback)
  }, [callback])
}

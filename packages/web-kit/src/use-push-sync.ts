// Mount the shared push self-heal (see ./push-sync.ts) into an app
// shell. Runs on launch and whenever the tab becomes visible again —
// the visibility trigger is the load-bearing one on iOS, where an
// installed PWA is resumed for days at a time without ever running a
// fresh launch. Both paths are throttled inside `maybeSync`.

import { useEffect } from 'react'
import type { PushResync } from './push-sync.js'

/**
 * @param userId  null/undefined until the session resolves; the heal
 *                needs an authenticated session to register, so it
 *                no-ops until then (and re-runs on user switch).
 */
export function usePushSync(userId: string | null | undefined, resync: PushResync): void {
  useEffect(() => {
    if (!userId) return
    // Bind the throttle/blocked slots to this user before the first run,
    // so a shared device never inherits another account's state.
    resync.setScope(userId)
    void resync.maybeSync()
    if (typeof document === 'undefined') return
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void resync.maybeSync()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [userId, resync])
}

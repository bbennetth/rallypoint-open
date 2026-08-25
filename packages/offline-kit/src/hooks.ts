// React glue for the offline write queue. Mount useOfflineSync once near
// the app root: wires connectivity listeners, kicks a flush on reconnect /
// tab-visible / SW background-sync postMessage, and tears down the
// flusher on user-switch.

import { useEffect } from 'react'
import type { OpBase } from './types.js'
import type { OfflineEngine } from './engine.js'

export interface OfflineHooks<Op extends OpBase = OpBase> {
  // Use stable named parameters (not an opts object) so the effect's dep
  // array can be stable across renders. Chrome calls
  // `useOfflineSync(userId)` without callbacks; if a parent passes inline
  // closures they MUST be wrapped in useCallback or this hook will
  // re-mount each render.
  useOfflineSync(
    userId: string | null,
    onAuthRequired?: () => void,
    // `op`/`err` let callers do more than toast (e.g. capture an
    // exception with structured properties) without re-deriving the
    // failure from scratch. A msg-only closure `(msg) => ...` stays a
    // valid callback — the extra params are additive.
    onOpFailed?: (msg: string, op: Op, err: unknown) => void,
  ): void
  // Sign-out helper — drop the active user's outbox + cache, then dispose
  // the flusher so the next mount opens a fresh one.
  purgeOfflineUser(userId: string): Promise<void>
}

export function createOfflineHooks<Op extends OpBase>(cfg: {
  engine: OfflineEngine<Op>
  purgeUserDb(userId: string): Promise<void>
  // The `data.type` value of the app SW's background-sync postMessage
  // that should kick a flush (e.g. 'planner-outbox-replay'). Apps without
  // a SW sync hook can pass any unused string — the listener simply
  // never fires.
  swMessageType: string
}): OfflineHooks<Op> {
  const { engine, purgeUserDb, swMessageType } = cfg

  function useOfflineSync(
    userId: string | null,
    onAuthRequired?: () => void,
    onOpFailed?: (msg: string, op: Op, err: unknown) => void,
  ): void {
    useEffect(() => {
      if (!userId) return

      engine.onAuthRequired = () => {
        // Reset the dead flusher so the next flushNow() (post-reauth)
        // builds a fresh one. Without this, the flusher stays
        // authStopped forever and the queue never drains again.
        engine.dispose(userId)
        onAuthRequired?.()
      }
      engine.onOpFailed = (op, err) => {
        const code = err && typeof err === 'object' ? (err as { code?: string }).code : undefined
        onOpFailed?.(`Could not save ${op.type} — ${code ?? 'server rejected'}`, op, err)
      }

      // Initial flush in case the page boots online with a non-empty queue.
      engine.flushNow(userId)

      const onOnline = () => engine.flushNow(userId)
      const onVisible = () => {
        if (document.visibilityState === 'visible') engine.flushNow(userId)
      }
      const onSwMessage = (event: MessageEvent) => {
        const data: unknown = event.data
        if (
          data &&
          typeof data === 'object' &&
          (data as { type?: unknown }).type === swMessageType
        ) {
          engine.flushNow(userId)
        }
      }

      window.addEventListener('online', onOnline)
      document.addEventListener('visibilitychange', onVisible)
      if (typeof navigator !== 'undefined' && navigator.serviceWorker) {
        navigator.serviceWorker.addEventListener('message', onSwMessage)
      }

      return () => {
        window.removeEventListener('online', onOnline)
        document.removeEventListener('visibilitychange', onVisible)
        if (typeof navigator !== 'undefined' && navigator.serviceWorker) {
          navigator.serviceWorker.removeEventListener('message', onSwMessage)
        }
        // Drop the flusher so its retry timer is cleared. The engine
        // re-creates a flusher on the next enqueueOp / flushNow.
        engine.dispose(userId)
      }
    }, [userId, onAuthRequired, onOpFailed])
  }

  async function purgeOfflineUser(userId: string): Promise<void> {
    engine.dispose(userId)
    engine.resetTmpIdResolutions()
    await purgeUserDb(userId)
  }

  return { useOfflineSync, purgeOfflineUser }
}

// Self-healing boot watchdog for the installed (standalone) PWAs.
//
// Failure mode this exists for: iOS home-screen apps keep their own
// storage, isolated from Safari. If the service worker's cached shell
// stops booting (evicted cache entries, a broken build stuck as the
// active SW), the reload-to-update banner (sw-update.ts) can never
// render — so the fixed build parked in `waiting` never activates and
// the app white-screens forever while Safari keeps working.
//
// Mechanism: every launch marks a "boot pending" flag in localStorage
// (localStorage, not sessionStorage — iOS kills and relaunches PWAs, and
// each relaunch is a fresh session). Reaching the app shell's first
// effect calls `bootSucceeded()`, which clears it. A launch that finds
// the flag still set knows the PREVIOUS launch never booted and
// escalates:
//
//   failure 1 → activate any `waiting` SW (SKIP_WAITING + reload) — the
//               parked new build is the most likely fix.
//   failure 2+ → unregister the SW and delete all caches, then reload —
//               guaranteed clean slate from the network.
//
// The normal epic-#675 update flow is untouched: the watchdog only acts
// when the previous launch demonstrably failed to boot, so there are no
// mid-session bundle swaps. At most one reload per page life.

import { SKIP_WAITING_MESSAGE } from './sw-update.js'

export type BootAction = 'none' | 'activate-waiting' | 'nuke'

const PENDING_KEY = 'rp-boot-pending'
const FAILS_KEY = 'rp-boot-fails'

/** Minimal storage surface so the state machine is testable over a Map. */
export interface BootStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** Escalation policy. Pure + unit-tested. `failCount` is the count
 *  INCLUDING the failure just detected. */
export function nextBootAction(prevPending: boolean, failCount: number): BootAction {
  if (!prevPending) return 'none'
  return failCount >= 2 ? 'nuke' : 'activate-waiting'
}

/** Read the previous launch's outcome, record this launch as pending,
 *  and decide the recovery action. Pure over the storage surface. */
export function recordLaunch(storage: BootStorage): { action: BootAction; failCount: number } {
  const prevPending = storage.getItem(PENDING_KEY) === '1'
  let failCount = Number.parseInt(storage.getItem(FAILS_KEY) ?? '0', 10) || 0
  if (prevPending) {
    failCount += 1
    storage.setItem(FAILS_KEY, String(failCount))
  }
  storage.setItem(PENDING_KEY, '1')
  return { action: nextBootAction(prevPending, failCount), failCount }
}

/** Mark this launch as booted. Pure over the storage surface. */
export function clearBootPending(storage: BootStorage): void {
  storage.removeItem(PENDING_KEY)
  storage.removeItem(FAILS_KEY)
}

let reloaded = false
function reloadOnce(): void {
  if (reloaded) return
  reloaded = true
  window.location.reload()
}

async function activateWaiting(): Promise<void> {
  const reg = await navigator.serviceWorker.getRegistration()
  const waiting = reg?.waiting
  if (!waiting) return
  navigator.serviceWorker.addEventListener('controllerchange', reloadOnce, { once: true })
  waiting.postMessage(SKIP_WAITING_MESSAGE)
}

async function nuke(storage: BootStorage): Promise<void> {
  const regs = await navigator.serviceWorker.getRegistrations()
  await Promise.all(regs.map((r) => r.unregister().catch(() => false)))
  if (typeof caches !== 'undefined') {
    const names = await caches.keys()
    await Promise.all(names.map((n) => caches.delete(n).catch(() => false)))
  }
  // Clean slate: clear the pending flag + counter so the post-nuke
  // reload starts fresh (and a still-broken app re-escalates from level
  // one rather than nuking on every relaunch).
  clearBootPending(storage)
  reloadOnce()
}

let booted = false

/** Call from the app shell once it has actually mounted (first effect). */
export function bootSucceeded(): void {
  booted = true
  try {
    clearBootPending(window.localStorage)
  } catch {
    // Storage unavailable (private mode edge cases) — nothing to clear.
  }
}

/**
 * Call from main.tsx before React mounts. Detects a previous failed
 * launch and self-heals; also arms a timeout so a HUNG (not crashed)
 * shell with a fix parked in `waiting` recovers without another manual
 * relaunch.
 */
export function initBootWatchdog(timeoutMs = 8000): void {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return
  let state: { action: BootAction }
  try {
    state = recordLaunch(window.localStorage)
  } catch {
    return // storage unavailable — watchdog can't help here
  }
  if (state.action === 'activate-waiting') {
    void activateWaiting().catch(() => undefined)
  } else if (state.action === 'nuke') {
    void nuke(window.localStorage).catch(() => undefined)
  }
  if (state.action !== 'none') {
    // Recovery launch still not booted after the grace period: if a
    // newer build is parked in `waiting`, swap to it now. Armed ONLY on
    // launches already flagged as failing — a healthy-but-slow launch
    // (e.g. a long SSO exchange, where the shell hasn't mounted yet)
    // must never get a surprise mid-session swap. (No nuke from the
    // timer — destructive recovery only runs on an explicit relaunch.)
    window.setTimeout(() => {
      if (!booted) void activateWaiting().catch(() => undefined)
    }, timeoutMs)
  }
}

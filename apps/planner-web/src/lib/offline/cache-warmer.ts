// Eager cache warmer for the planner-web offline read surface (E4 O3
// follow-up). The base cachedFetch wrap is *lazy* — a page only has
// offline data after the user has visited it online. That's fine for
// hot users but punishing for "I just installed the PWA and now I'm on
// the train" cold-start: only My Day works (because the user opened it
// once); everything else 404s the offline reload.
//
// This module fires once per session, in the background, after the
// session probe succeeds. It pulls the full read surface — list of
// lists, items in each, holidays, settings — and writes each into the
// cache via the normal cachedFetch path (no special-case writer).
//
// Throttling: skipped when the previous warm completed less than
// WARM_TTL_MS ago, so we don't repaint a healthy cache on every load.
// 7 days picked deliberately to bracket "weekly use" — anything fresher
// is wasted work; anything staler risks the user seeing very old data
// on their next offline session.

import { readMeta, writeMeta } from './cache.js'

// 7 days — long enough that an actively-used app skips it on every
// boot, short enough that a returning user gets fresh data before
// their next offline session.
export const WARM_TTL_MS = 7 * 24 * 60 * 60 * 1000

const WARM_KEY = 'lastWarmAt'
const LOCK_KEY = 'warmInProgressAt'
// If a tab dies mid-warm the lock would strand forever; expire stale
// locks after 5 minutes (the warmer itself completes in seconds for
// realistic data sizes).
const LOCK_TTL_MS = 5 * 60_000

// In-process guard so two RequireSession remounts in the same tab
// don't queue two warmups. Per-tab; cross-tab is the meta LOCK_KEY.
let _warming = false

export interface WarmerDeps {
  getSettings: (ns: string) => Promise<unknown>
  getMyDay: (date: string, tz: string) => Promise<unknown>
  getUpcoming: (date: string, tz: string) => Promise<unknown>
  getRecurring: (date: string, tz: string) => Promise<unknown>
  listHolidays: (from: string, to: string) => Promise<unknown>
  listTaskLists: () => Promise<{ id: string }[]>
  listTaskItems: (id: string) => Promise<unknown>
  listFieldDefs: (id: string) => Promise<unknown>
  getShoppingList: () => Promise<{ id: string }>
  listShoppingItems: (id: string) => Promise<unknown>
  getChoresList: () => Promise<{ id: string }>
  listChoreItems: (id: string) => Promise<unknown>
  listChoreSeries: (id: string) => Promise<unknown>
  getDiaryList: () => Promise<{ id: string }>
  listDiaryEntries: (id: string) => Promise<unknown>
  getBraindumpList: () => Promise<{ id: string }>
  listPersonalEvents: () => Promise<{ id: string; ticketCount?: number }[]>
  listTickets: (eventId: string) => Promise<unknown>
  listNoteFolders: () => Promise<unknown>
  listNotes: (folderId?: string) => Promise<unknown>
}

export interface WarmerEnv {
  now?: () => number
  isOnline?: () => boolean
  today?: () => string // YYYY-MM-DD in the user's tz
  tz?: () => string
}

// Pure decision: is the cache cold or older than WARM_TTL_MS?
// At-boundary (exactly TTL elapsed) counts as stale — `>=` is more
// intuitive than `>` for a "7 days have passed" check.
export function shouldWarm(lastWarmAt: number | undefined, now: number): boolean {
  if (lastWarmAt === undefined) return true
  return now - lastWarmAt >= WARM_TTL_MS
}

// Pure decision: is the meta-table cross-tab lock still active?
export function lockIsActive(lockAt: number | undefined, now: number): boolean {
  if (lockAt === undefined) return false
  return now - lockAt < LOCK_TTL_MS
}

// Default day-window for the holiday warm: 90 days forward from today.
function plusDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

// Fire-and-forget warm. Idempotent + cheap on a fresh cache.
// Never throws — failures degrade to "user keeps the lazy path".
export async function warmCacheIfStale(deps: WarmerDeps, env: WarmerEnv = {}): Promise<void> {
  // Claim the in-process slot SYNCHRONOUSLY before any await — otherwise
  // two callers in quick succession both pass the guard, hit the same
  // pending readMeta, and end up both warming.
  if (_warming) return
  _warming = true
  // Tracks whether THIS invocation took the cross-tab lock. The finally
  // only clears the lock when we set it — otherwise an early-bail tab
  // would zero out a peer tab's active lock and let a third tab
  // double-warm.
  let lockAcquired = false
  try {
    const now = env.now ? env.now() : Date.now()
    if (env.isOnline && !env.isOnline()) return

    const last = await readMeta<number>(WARM_KEY)
    if (!shouldWarm(last, now)) return

    // Cross-tab lock so two tabs don't both fire the warm. Best-effort —
    // a tab crash leaves a stale lock that expires after LOCK_TTL_MS.
    const lockAt = await readMeta<number>(LOCK_KEY)
    if (lockIsActive(lockAt, now)) return
    await writeMeta(LOCK_KEY, now)
    lockAcquired = true

    const today = env.today ? env.today() : todayLocalIsoDate()
    const tz = env.tz ? env.tz() : (Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC')

    // Round 1 — independent reads + the four list-of-lists that gate
    // the per-list round. settle-all (not all) so one failure doesn't
    // strand the others; each failed read just leaves its cache cold.
    // Round 1 fires the independent reads + the five list-of-lists/
    // event-list reads that gate round 2's per-entity fan-out. We only
    // keep references to the ones round 2 reads from; the rest are
    // dropped into a `_` array purely so the destructure positions
    // stay aligned.
    const round1Results = await Promise.allSettled([
      deps.getSettings('planner'),
      deps.getSettings('shared'),
      deps.getMyDay(today, tz),
      deps.getUpcoming(today, tz),
      deps.getRecurring(today, tz),
      deps.listHolidays(today, plusDays(today, 90)),
      deps.listNoteFolders(),
      deps.listNotes(),
      deps.listTaskLists(),
      deps.getShoppingList(),
      deps.getChoresList(),
      deps.getDiaryList(),
      deps.listPersonalEvents(),
      // Appended after the positional destructures above so their indices
      // stay stable.
      deps.getBraindumpList(),
    ])
    const taskListsR = round1Results[8] as PromiseSettledResult<{ id: string }[]>
    const shoppingListR = round1Results[9] as PromiseSettledResult<{ id: string }>
    const choresListR = round1Results[10] as PromiseSettledResult<{ id: string }>
    const diaryListR = round1Results[11] as PromiseSettledResult<{ id: string }>
    const personalEventsR = round1Results[12] as PromiseSettledResult<
      { id: string; ticketCount?: number }[]
    >
    const braindumpListR = round1Results[13] as PromiseSettledResult<{ id: string }>

    // Round 2 — per-list reads gated on the list-of-lists results.
    const round2: Promise<unknown>[] = []
    if (taskListsR.status === 'fulfilled') {
      for (const list of taskListsR.value) {
        round2.push(deps.listTaskItems(list.id))
        round2.push(deps.listFieldDefs(list.id))
      }
    }
    if (shoppingListR.status === 'fulfilled') {
      round2.push(deps.listShoppingItems(shoppingListR.value.id))
    }
    if (choresListR.status === 'fulfilled') {
      round2.push(deps.listChoreItems(choresListR.value.id))
      round2.push(deps.listChoreSeries(choresListR.value.id))
    }
    if (diaryListR.status === 'fulfilled') {
      round2.push(deps.listDiaryEntries(diaryListR.value.id))
      round2.push(deps.listFieldDefs(diaryListR.value.id))
    }
    if (braindumpListR.status === 'fulfilled') {
      // Braindump entries ride the same generic per-list items read/cache
      // as diary (listId-keyed), so the diary reader warms them too.
      round2.push(deps.listDiaryEntries(braindumpListR.value.id))
      round2.push(deps.listFieldDefs(braindumpListR.value.id))
    }
    if (personalEventsR.status === 'fulfilled') {
      // Only warm tickets for events that actually have any — most
      // events don't, and the call would be wasted.
      for (const event of personalEventsR.value) {
        if ((event.ticketCount ?? 0) > 0) {
          round2.push(deps.listTickets(event.id))
        }
      }
    }
    await Promise.allSettled(round2)

    // Only stamp lastWarmAt on a successful pass. A partial cache is
    // fine — the next session's warm will retry whatever failed —
    // BUT we stamp anyway so we don't hammer the BFF on every load
    // when one endpoint is permanently broken. The threshold for "
    // successful enough to stamp": list-of-lists round resolved.
    await writeMeta(WARM_KEY, now)
  } catch {
    // Best-effort; never let the warmer break the app.
  } finally {
    if (lockAcquired) await writeMeta(LOCK_KEY, 0)
    _warming = false
  }
}

// "Today" in the browser's local tz as YYYY-MM-DD. Mirrors the BFF
// convention so the cache-key matches what the page reads later.
function todayLocalIsoDate(): string {
  const d = new Date()
  // toLocaleDateString in en-CA emits ISO YYYY-MM-DD, which is the
  // format the planner-api day endpoints expect.
  return d.toLocaleDateString('en-CA')
}

// Hook for tests that need to reset the in-process guard.
export function _resetWarmerStateForTests(): void {
  _warming = false
}

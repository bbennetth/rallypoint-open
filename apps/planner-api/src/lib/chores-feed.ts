import type { ListItemDto, ListsClient } from '@rallypoint/lists-client'
import { findChoresList } from './personal-scope.js'

// Shared chores→feed plumbing for My Day + Upcoming (#546).
//
// Chores are normally hidden from every task surface (listPersonalTaskLists
// excludes the chores list). The feed toggle re-admits them: when
// `showChoresInFeeds` is on (the default), My Day & Upcoming additionally fetch
// the chores list's items and append them to the `tasks` array passed to the
// pure compose helpers — which stay signature-stable (they just see more
// ListItemDtos, each already carrying its `listId` so the UI can badge the
// chore rows).

// The planner-namespace setting key. Absent → true (chores show by default).
// Keep in lockstep with the web mirror `SHOW_CHORES_IN_FEEDS_KEY` in
// apps/planner-web/src/lib/api.ts (separate build targets, same string).
export const SETTING_SHOW_CHORES_IN_FEEDS = 'showChoresInFeeds'

// Minimal shape of the settings service this helper needs (a get(actor, ns)
// returning a record). Kept structural so tests can pass a tiny fake.
export interface SettingsReader {
  get(actor: string, namespace: string): Promise<Record<string, unknown>>
}

// Pure decision: is the chores feed toggle ON for this settings blob? Only an
// explicit `false` turns it off; absent / any other value defaults ON. Mirrors
// how shopping reads `shoppingAutoCategorize`. Unit-tested.
export function choresInFeedsEnabled(settings: Record<string, unknown>): boolean {
  return settings[SETTING_SHOW_CHORES_IN_FEEDS] !== false
}

// Resolve the actor's chores-list items for the feed.
//
// `scope` controls how the showChoresInFeeds toggle is interpreted:
//
//   • 'future' (default; used by Upcoming) — toggle gates the read. When the
//     toggle is OFF returns []; when ON returns the items.
//   • 'today' (used by My Day) — the toggle DOES NOT gate the read. Today's
//     Chores section on My Day is always visible (handoff: "always renders on
//     the current day's agenda regardless of the chores toggle"); the
//     showChoresInFeeds toggle only controls future-scope surfaces.
//
// Returns [] when the chores list doesn't exist yet (never provisions), or any
// settings read fails (non-fatal — a settings hiccup must never drop the feed).
export async function fetchChoresFeedItems(
  listsClient: ListsClient,
  settings: SettingsReader,
  actor: string,
  scope: 'today' | 'future' = 'future',
): Promise<ListItemDto[]> {
  return (await fetchChoresFeed(listsClient, settings, actor, scope)).items
}

// Like fetchChoresFeedItems, but also surfaces the resolved chores-list id so
// the caller can return it to the UI. My Day includes it in its response —
// the client needs it to split chore rows out of the agenda (and to render
// the morning check-in's chores) and previously had to derive it from a
// separate /recurring + chore-series round trip, delaying the chores render
// until the slowest request chain finished.
//
// `listId` is the chores list's id whenever the list exists — even when the
// 'future' toggle suppresses the items — and null when no chores list exists
// yet (never provisions).
export async function fetchChoresFeed(
  listsClient: ListsClient,
  settings: SettingsReader,
  actor: string,
  scope: 'today' | 'future' = 'future',
): Promise<{ listId: string | null; items: ListItemDto[] }> {
  let suppressed = false
  if (scope === 'future') {
    let enabled = true
    try {
      enabled = choresInFeedsEnabled(await settings.get(actor, 'planner'))
    } catch {
      // Settings fetch failure is non-fatal — fall back to default (on).
    }
    suppressed = !enabled
  }
  const list = await findChoresList(listsClient, actor)
  if (!list) return { listId: null, items: [] }
  if (suppressed) return { listId: list.id, items: [] }
  return { listId: list.id, items: await listsClient.listItems(list.id, actor) }
}

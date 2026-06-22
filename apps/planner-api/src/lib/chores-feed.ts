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

// Resolve the actor's chores-list items for the feed, honoring the toggle.
// Returns [] when the toggle is off, the chores list doesn't exist yet, or any
// settings read fails (non-fatal — a settings hiccup must never drop the feed).
// Never provisions the chores list (findChoresList is read-only).
export async function fetchChoresFeedItems(
  listsClient: ListsClient,
  settings: SettingsReader,
  actor: string,
): Promise<ListItemDto[]> {
  let enabled = true
  try {
    enabled = choresInFeedsEnabled(await settings.get(actor, 'planner'))
  } catch {
    // Settings fetch failure is non-fatal — fall back to default (on).
  }
  if (!enabled) return []
  const list = await findChoresList(listsClient, actor)
  if (!list) return []
  return listsClient.listItems(list.id)
}

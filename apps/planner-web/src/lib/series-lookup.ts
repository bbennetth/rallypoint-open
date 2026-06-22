// Pure resolver shared by My Day and the Upcoming feed. Recurring task rows
// carry only a `seriesId`; to badge them and open the right editor we need the
// full series object AND which surface (Tasks vs Chores) owns it, since the two
// have separate BFF series endpoints. The `/recurring` roll-up only covers task
// lists (chores are excluded server-side), so chore series are fetched
// separately and merged here.

import type { TaskSeriesDto } from './api.js'

export type SeriesSurface = 'tasks' | 'chores'

export interface ResolvedSeries {
  series: TaskSeriesDto
  surface: SeriesSurface
}

// Build a seriesId → {series, surface} lookup. Task and chore series live in
// distinct lists so their ids never collide; if one somehow appeared in both,
// the task surface wins (it's the canonical non-chores surface).
export function buildSeriesLookup(
  taskSeries: readonly TaskSeriesDto[],
  choreSeries: readonly TaskSeriesDto[],
): Map<string, ResolvedSeries> {
  const map = new Map<string, ResolvedSeries>()
  for (const s of choreSeries) map.set(s.id, { series: s, surface: 'chores' })
  for (const s of taskSeries) map.set(s.id, { series: s, surface: 'tasks' })
  return map
}

export function resolveSeries(
  lookup: Map<string, ResolvedSeries>,
  seriesId: string | null,
): ResolvedSeries | null {
  if (seriesId == null) return null
  return lookup.get(seriesId) ?? null
}

// The chores list id is not in the My Day / Upcoming payloads, and resolving it
// through the chores endpoint would auto-provision a chores list for users who
// have none. Instead derive it from the rows: the `/recurring` roll-up covers
// every task list but excludes chores, so a task row whose seriesId is NOT a
// known task series must be a chore occurrence — and its listId is the chores
// list. Returns null when no chore occurrence is visible (the common case).
export function pickChoresListId(
  tasks: readonly { seriesId: string | null; listId: string }[],
  taskSeriesIds: ReadonlySet<string>,
): string | null {
  for (const t of tasks) {
    if (t.seriesId != null && !taskSeriesIds.has(t.seriesId)) return t.listId
  }
  return null
}

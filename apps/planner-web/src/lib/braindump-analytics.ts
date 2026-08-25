// Pure client-side analytics for the Brain Dump insights view, computed from
// the cached merged stream — no API. The one server round-trip (the AI range
// summary) gets its input capped/trimmed here (selectEntriesForSummary) so
// the request can never trip the BFF's hard size limits. Unit-tested in
// braindump-analytics.test.ts.

import type { BraindumpSummaryEntry } from './api.js'
import { UNCATEGORIZED, type StreamEntry } from './braindump-helpers.js'

// Mirrors the BFF caps in apps/planner-api/src/lib/braindump.ts (client
// trims slightly under them so boundary drift can never 400).
export const SUMMARY_MAX_ENTRIES = 50
export const SUMMARY_MAX_ENTRY_CHARS = 1000
export const SUMMARY_MAX_TOTAL_CHARS = 15000

export interface CategoryCount {
  category: string
  count: number
}

// Category distribution over the stream, largest first (label as tiebreak);
// rows without a category bucket under UNCATEGORIZED (always last when
// present).
export function categoryDistribution(entries: readonly StreamEntry[]): CategoryCount[] {
  const counts = new Map<string, number>()
  let uncategorized = 0
  for (const e of entries) {
    if (e.category === null) {
      uncategorized += 1
      continue
    }
    counts.set(e.category, (counts.get(e.category) ?? 0) + 1)
  }
  const out = [...counts.entries()]
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count || (a.category < b.category ? -1 : 1))
  if (uncategorized > 0) out.push({ category: UNCATEGORIZED, count: uncategorized })
  return out
}

export interface ThemeCount {
  theme: string
  count: number
}

// Top themes across analyzed entries (case-insensitive, first casing wins),
// most frequent first, capped at `limit`.
export function topThemes(entries: readonly StreamEntry[], limit = 8): ThemeCount[] {
  const counts = new Map<string, { theme: string; count: number }>()
  for (const e of entries) {
    if (!e.analysis) continue
    const seen = new Set<string>()
    for (const t of e.analysis.themes) {
      const key = t.trim().toLowerCase()
      if (key === '' || seen.has(key)) continue
      seen.add(key)
      const hit = counts.get(key)
      if (hit) hit.count += 1
      else counts.set(key, { theme: t.trim(), count: 1 })
    }
  }
  return [...counts.values()]
    .sort((a, b) => b.count - a.count || (a.theme < b.theme ? -1 : 1))
    .slice(0, limit)
}

// Entries per ISO week ('YYYY-Www'), most recent first. Undated rows are
// skipped (they have no week to land in).
export function entriesPerWeek(entries: readonly StreamEntry[]): { week: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const e of entries) {
    if (!e.day) continue
    const week = isoWeekOf(e.day)
    if (!week) continue
    counts.set(week, (counts.get(week) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([week, count]) => ({ week, count }))
    .sort((a, b) => (a.week < b.week ? 1 : -1))
}

// 'YYYY-Www' ISO week for a 'YYYY-MM-DD' day, or null on garbage.
export function isoWeekOf(ymd: string): string | null {
  const [y, m, d] = ymd.split('-').map(Number)
  if (!y || !m || !d) return null
  const date = new Date(Date.UTC(y, m - 1, d))
  if (Number.isNaN(date.getTime())) return null
  // ISO week: Thursday of the current week decides the week-year.
  const day = date.getUTCDay() || 7
  date.setUTCDate(date.getUTCDate() + 4 - day)
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1)
  const week = Math.ceil(((date.getTime() - yearStart) / 86400000 + 1) / 7)
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

// Cap + trim the newest dated entries with a body into the summary request
// shape. Newest-first selection (the summary is about "lately"), then
// re-sorted oldest-first so the model reads chronologically. Enforces all
// three caps client-side.
export function selectEntriesForSummary(
  entries: readonly StreamEntry[],
): BraindumpSummaryEntry[] {
  const dated = entries.filter((e) => e.day && (e.body ?? e.title))
  // The stream arrives newest-first already, but don't rely on it.
  const newestFirst = dated.slice().sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0))
  const out: BraindumpSummaryEntry[] = []
  let total = 0
  for (const e of newestFirst) {
    const text = (e.body ?? e.title).trim().slice(0, SUMMARY_MAX_ENTRY_CHARS)
    if (text === '') continue
    if (out.length >= SUMMARY_MAX_ENTRIES || total + text.length > SUMMARY_MAX_TOTAL_CHARS) break
    out.push({ date: e.day, category: e.category, text })
    total += text.length
  }
  return out.reverse()
}

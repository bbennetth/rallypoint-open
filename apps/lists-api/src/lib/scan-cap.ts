// Scan cap for the items-listing endpoint (#472). SQLite has no
// JSON-containment index, so a `has_any` (or unfiltered) query is a per-row
// json_each scan; this bounds it. The route fetches `cap + 1` and reports
// `filter_truncated` when more matched, rather than silently capping.

export const ITEM_SCAN_CAP = 2000

// Trim a result set to `cap`, reporting whether anything was dropped. Pass the
// rows fetched with `limit: cap + 1` so a full `cap + 1` means "more exist".
export function applyScanCap<T>(rows: T[], cap: number): { items: T[]; truncated: boolean } {
  if (rows.length > cap) return { items: rows.slice(0, cap), truncated: true }
  return { items: rows, truncated: false }
}

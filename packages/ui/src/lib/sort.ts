// Pure decision helpers for the <Table> primitive's sortable headers.
// Extracted so the click-cycle and order rules can be unit-tested
// without RTL.

export type SortDir = 'asc' | 'desc'

export interface SortState<TColumn extends string = string> {
  column: TColumn
  dir: SortDir
}

// Click cycle: same column → flip direction; new column → asc.
// Matches the convention in most admin tables (Notion, Linear,
// GitHub) so users don't have to learn a new rule.
export function nextSortState<TColumn extends string>(
  prev: SortState<TColumn> | null,
  clicked: TColumn,
): SortState<TColumn> {
  if (!prev || prev.column !== clicked) {
    return { column: clicked, dir: 'asc' }
  }
  return { column: clicked, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
}

// Stable comparator: NULL/undefined values sort to the end regardless
// of direction. Mirrors what every "Recent" / "Joined" column does in
// practice — a missing value doesn't fight either alphabet end.
export function compareValues(
  a: string | number | Date | null | undefined,
  b: string | number | Date | null | undefined,
  dir: SortDir,
): number {
  if (a === null || a === undefined) {
    if (b === null || b === undefined) return 0
    return 1
  }
  if (b === null || b === undefined) return -1
  const av = a instanceof Date ? a.getTime() : a
  const bv = b instanceof Date ? b.getTime() : b
  if (av === bv) return 0 // avoid -0 for desc on equal values
  const cmp = av < bv ? -1 : 1
  return dir === 'asc' ? cmp : -cmp
}

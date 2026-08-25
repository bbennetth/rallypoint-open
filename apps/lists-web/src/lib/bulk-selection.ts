// Pure partitioning for bulk actions (#675). A selection can include items
// that were created offline and haven't flushed yet — their id is still the
// client-minted `tmp_…` placeholder, which the server has never heard of.
// Sending those ids straight through the bulk endpoint either 404s the whole
// batch or silently no-ops on them; either way the item reverts once the
// outbox eventually flushes and the page reconciles to server truth, which
// looks like the bulk action "undid itself" for that item. Partition them out
// up front instead, so the caller can act on the synced ids and separately
// surface a "still syncing" notice for the skipped ones.
export function partitionBulkSelection(
  itemIds: readonly string[],
  isTempId: (id: string) => boolean,
): { synced: string[]; skipped: string[] } {
  const synced: string[] = []
  const skipped: string[] = []
  for (const id of itemIds) {
    if (isTempId(id)) skipped.push(id)
    else synced.push(id)
  }
  return { synced, skipped }
}

export function skippedNoticeText(skippedCount: number): string {
  return `${skippedCount} item(s) still syncing were skipped.`
}

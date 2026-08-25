// List items are recoverable for 30 days after a soft delete. Keep this
// policy shared by the cookie UI route and the cross-Worker RPC surface so
// Planner's Deleted view cannot advertise an item the restore call rejects.
export const ITEM_RESTORE_GRACE_MS = 30 * 24 * 60 * 60 * 1000

export function isItemRestorable(deletedAt: Date, now = Date.now()): boolean {
  return now - deletedAt.getTime() <= ITEM_RESTORE_GRACE_MS
}

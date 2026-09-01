// Pure decision helpers for the service worker (`../sw.ts`). Kept in
// their own module so they're unit-testable without a Workbox runtime.
// MUST stay pure — no `self.*`, no globals.

export function isCacheableImage(destination: string, pathname: string): boolean {
  return destination === 'image' && !pathname.startsWith('/api/')
}

/** Whether a server backstop push duplicates a visible banner: true
 *  ONLY when a same-tag notification carries the SAME rest deadline —
 *  that is this rest period's local alert, whose disarm lost the race.
 *  The tag alone is per-session, so an undismissed banner from an
 *  earlier rest is NOT a duplicate of a later rest's backstop; and
 *  with no payload deadline (old server build) or no banner data (old
 *  client banner) we fail open to not-a-duplicate. A duplicate is
 *  still shown — as a silent same-tag replacement, since a push that
 *  shows nothing burns the origin's silent-push budget — it just must
 *  not re-alert. */
export function isDuplicateRestPush(
  payloadDeadlineMs: number | undefined,
  existingDeadlines: readonly unknown[],
): boolean {
  if (payloadDeadlineMs == null) return false
  return existingDeadlines.includes(payloadDeadlineMs)
}

/** The showNotification options the SW derives from a rest-push
 *  payload: a duplicate (this rest period's local banner already up)
 *  is re-shown silently in the same tag slot; anything else alerts
 *  normally. The deadline rides along as data so a later push can be
 *  matched against this banner. */
export function restPushShowOptions(
  payloadDeadlineMs: number | undefined,
  existingDeadlines: readonly unknown[],
): { silent: true | null; data: { deadlineMs: number } | undefined } {
  // null (the spec default), not false, so the whole decision — including
  // NotificationOptions' silent shape — lives here, not at the call site.
  return {
    silent: isDuplicateRestPush(payloadDeadlineMs, existingDeadlines) || null,
    data: payloadDeadlineMs != null ? { deadlineMs: payloadDeadlineMs } : undefined,
  }
}

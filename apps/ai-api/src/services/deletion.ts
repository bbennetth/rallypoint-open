import type { R2Bucket, Service } from '@cloudflare/workers-types'
import type { IdRPC } from '@rallypoint/id-api'
import type { Logger } from '../logger.js'
import type { TracesRepo } from '../repos/traces.js'

// Daily deletion sweep: ask id-api which accounts are soft-deleted and
// purge everything ai-api stores for them. Pull-based (ai-api polls)
// rather than push-based (id-api fans out) so id-api stays tier-1 with
// no outbound service bindings, and the sweep self-heals: a purge that
// fails today just runs again tomorrow — the user stays listed until
// nothing of theirs is left to delete.

export interface PurgeCounts {
  traces: number
  feedback: number
  blobs: number
}

/** Purge everything stored for one user: trace rows, feedback rows, and
 * R2 blobs under the user's `traces/{userId}/` prefix. Shared by
 * AiRPC.deleteUserData and the cron sweep. */
export async function purgeUserData(
  repo: TracesRepo,
  store: R2Bucket,
  userId: string,
): Promise<PurgeCounts> {
  const feedback = await repo.deleteUserFeedback(userId)
  const traces = await repo.deleteUserTraces(userId)
  let blobs = 0
  let cursor: string | undefined
  do {
    const listing = await store.list({
      prefix: `traces/${userId}/`,
      ...(cursor ? { cursor } : {}),
    })
    if (listing.objects.length > 0) {
      await store.delete(listing.objects.map((o) => o.key))
      blobs += listing.objects.length
    }
    cursor = listing.truncated ? listing.cursor : undefined
  } while (cursor)
  return { traces, feedback, blobs }
}

export interface DeletionSweepResult {
  users: number
  traces: number
  feedback: number
  blobs: number
}

export async function runDeletionSweep(
  rpid: Service<IdRPC>,
  repo: TracesRepo,
  store: R2Bucket,
  logger: Logger,
): Promise<DeletionSweepResult> {
  const userIds = await rpid.listDeletedUserIds({ client: 'ai' })
  const result: DeletionSweepResult = { users: 0, traces: 0, feedback: 0, blobs: 0 }
  for (const userId of userIds) {
    try {
      const counts = await purgeUserData(repo, store, userId)
      if (counts.traces > 0 || counts.feedback > 0 || counts.blobs > 0) {
        result.users++
        result.traces += counts.traces
        result.feedback += counts.feedback
        result.blobs += counts.blobs
      }
    } catch (err) {
      logger.error({ err, userId }, 'deletion sweep: purge failed for user')
    }
  }
  return result
}

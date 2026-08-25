import type { R2Bucket } from '@cloudflare/workers-types'
import type { Logger } from '../logger.js'
import type { TracesRepo } from '../repos/traces.js'

// Retention drain: rows older than RETENTION_DAYS leave D1 for a JSONL
// archive in R2 (`exports/{yyyy-mm}/traces-{iso}.jsonl`), one
// `{ trace, feedback: [...] }` bundle per line — self-contained for
// offline analysis/tuning. Image blobs are NOT touched: the archived
// trace still references its `traces/{userId}/...` R2 keys, and blobs
// only ever die via user deletion (deleteUserData's prefix purge).

const BATCH_LIMIT = 500

export interface RetentionDrainResult {
  drained: number
  exportKey: string | null
}

export async function runRetentionDrain(
  repo: TracesRepo,
  store: R2Bucket,
  retentionDays: number,
  now: Date,
  logger: Logger,
): Promise<RetentionDrainResult> {
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000)
  const rows = await repo.listTracesOlderThan(cutoff, BATCH_LIMIT)
  if (rows.length === 0) return { drained: 0, exportKey: null }

  const lines: string[] = []
  for (const trace of rows) {
    const feedback = await repo.listFeedbackForTrace(trace.id)
    lines.push(JSON.stringify({ trace, feedback }))
  }
  const month = now.toISOString().slice(0, 7)
  const exportKey = `exports/${month}/traces-${now.toISOString().replaceAll(':', '-')}.jsonl`
  await store.put(exportKey, lines.join('\n') + '\n', {
    httpMetadata: { contentType: 'application/jsonl' },
  })
  // Delete only after the export object is durably written. Guard each
  // delete so one failing row doesn't abort the loop — otherwise the rows
  // AFTER it stay past their cutoff and get re-exported (duplicated in the
  // archive) on the next drain. Mirrors runDeletionSweep's per-item catch.
  let drained = 0
  for (const trace of rows) {
    try {
      await repo.deleteTrace(trace.id)
      drained++
    } catch (err) {
      logger.error({ err, traceId: trace.id }, 'retention drain: delete failed for trace')
    }
  }
  return { drained, exportKey }
}

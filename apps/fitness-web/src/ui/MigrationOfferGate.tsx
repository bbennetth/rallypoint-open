// Chrome-level gate for the post-approval migration prompt: when one of
// the actor's custom-exercise submissions is approved and the catalog
// replacement is ready, offer to roll their logged history onto it —
// on whatever page they're on, not just Library.
//
// The check only runs online with a fully drained offline outbox (a
// queued write can still reference the custom exercise id a migration
// accept is about to delete). Because those gates fail transiently on
// mobile — the PWA resumes from background instead of remounting, and
// the outbox is more often mid-flush — the check re-runs on reconnect
// and on tab-visible, after a short delay so the offline-kit's own
// flush (kicked by the same events) can drain the queue first.

import { useEffect, useRef, useState } from 'react'
import type { SubmissionDto } from '@rallypoint/fitness-shared'
import {
  hasPendingWrites,
  listSubmissions,
  migrateSubmission,
  refreshExercisesAndFavorites,
} from '../lib/api.js'
import { nextMigrationOffers } from '../lib/submissions.js'
import { SubmissionMigratePrompt } from './SubmissionMigratePrompt.js'

// Lets the offline-kit flush (listening on the same online/visible
// events) win the race before we re-test hasPendingWrites().
const RECHECK_DELAY_MS = 1500

export function MigrationOfferGate({
  userId,
  onError,
}: {
  userId: string | null
  onError: (msg: string) => void
}) {
  const [offers, setOffers] = useState<SubmissionDto[]>([])
  // Offers waved away this session. Dismissal isn't persisted, so the
  // re-checks below must filter against this or the prompt would nag on
  // every resume.
  const dismissedIds = useRef(new Set<string>())

  useEffect(() => {
    if (!userId) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    // Monotonic check counter: overlapping checks are routine here (mount
    // + a reconnect-triggered recheck), so a slow stale response must not
    // overwrite a newer result.
    let seq = 0

    function check() {
      if (cancelled || !navigator.onLine) return
      const mySeq = ++seq
      hasPendingWrites()
        .then((pending) => {
          if (pending || cancelled || mySeq !== seq) return null
          return listSubmissions()
        })
        .then((res) => {
          if (cancelled || !res || mySeq !== seq) return
          // Don't pop the dialog over an open sheet/dialog — it would
          // steal focus mid-interaction. The Drawer sheets and dialogs
          // all set aria-modal; a skipped round surfaces on the next
          // online/visible recheck instead.
          if (document.querySelector('[aria-modal="true"]')) return
          setOffers(nextMigrationOffers(res.submissions, dismissedIds.current))
        })
        .catch(() => {
          // Non-fatal: the actor just isn't offered a migration this check.
        })
    }

    function recheckSoon() {
      if (timer) clearTimeout(timer)
      timer = setTimeout(check, RECHECK_DELAY_MS)
    }

    const onOnline = () => recheckSoon()
    const onVisible = () => {
      if (document.visibilityState === 'visible') recheckSoon()
    }

    check()
    window.addEventListener('online', onOnline)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      window.removeEventListener('online', onOnline)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [userId])

  const current = offers[0]
  if (!current) return null

  async function decide(submission: SubmissionDto, accept: boolean) {
    try {
      await migrateSubmission(submission.id, accept)
      if (accept) await refreshExercisesAndFavorites()
    } catch (err: unknown) {
      onError(err instanceof Error ? err.message : 'Migration failed — try again later')
    } finally {
      setOffers((cur) => cur.filter((s) => s.id !== submission.id))
    }
  }

  return (
    <SubmissionMigratePrompt
      submission={current}
      onDecide={(accept) => decide(current, accept)}
      onDismiss={() => {
        dismissedIds.current.add(current.id)
        setOffers((cur) => cur.filter((s) => s.id !== current.id))
      }}
    />
  )
}

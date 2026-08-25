import { ulid } from 'ulid'
import type { Discipline, MetricShape, MovementPattern } from '@rallypoint/fitness-shared'
import { normalizeForDedup, planExercisePromotion } from '../lib/submission-promote.js'
import type { Repos, SubmissionAdminRecord, SubmissionRecord } from '../repos/types.js'

// Admin review logic for exercise submissions: approve creates (or links
// to) the curated-global exercise and offers the submitter a migration;
// reject just records the note. Kept out of rpc.ts so FitnessRPC stays a
// thin dispatcher (mirrors services/rpc-core.ts for listWorkouts).

export class SubmissionNotFoundError extends Error {
  constructor(id: string) {
    super(`Submission ${id} not found`)
    this.name = 'SubmissionNotFoundError'
  }
}

export class SubmissionNotPendingError extends Error {
  constructor(id: string) {
    super(`Submission ${id} is not pending review`)
    this.name = 'SubmissionNotPendingError'
  }
}

export async function approveSubmission(
  repos: Repos,
  submissionId: string,
  opts?: { note?: string },
): Promise<SubmissionRecord> {
  const submission = await repos.submissions.getById(submissionId)
  if (!submission) throw new SubmissionNotFoundError(submissionId)
  if (submission.status !== 'pending') throw new SubmissionNotPendingError(submissionId)

  const exercise = await repos.exercises.getForActor(submission.userId, submission.exerciseId)
  if (!exercise) {
    // The custom exercise disappeared between submit and review (e.g. the
    // owner deleted it) — nothing to promote. Reject with an explanatory
    // note rather than leaving the row stuck pending forever.
    return approveOrRejectMissingExercise(repos, submissionId)
  }

  const existingGlobal = await repos.exercises.findGlobalByName(exercise.name)
  const plan = planExercisePromotion(
    {
      name: exercise.name,
      discipline: exercise.discipline as Discipline,
      movementPattern: exercise.movementPattern as MovementPattern,
      metricShape: exercise.metricShape as MetricShape,
      unilateral: exercise.unilateral,
      muscles: exercise.muscles,
    },
    existingGlobal ? existingGlobal.id : null,
  )

  // Dedup by normalized name: two submissions promoting exercises that
  // normalize to the same global name must land on ONE global row, not
  // two near-duplicates in the curated catalog.
  let globalExerciseId: string
  if (plan.kind === 'duplicate') {
    globalExerciseId = plan.existingGlobalExerciseId
  } else {
    try {
      const created = await repos.exercises.createGlobal({
        id: `fx_${ulid()}`,
        ...plan.payload,
      })
      globalExerciseId = created.id
    } catch {
      // Lost a race against a concurrent approval of an equivalent name —
      // re-resolve to whichever row won.
      const raced = await repos.exercises.findGlobalByName(exercise.name)
      if (!raced) throw new Error('exercise_name_taken but no matching global row found')
      globalExerciseId = raced.id
    }
  }

  const updated = await repos.submissions.setReviewed(submissionId, {
    status: 'approved',
    adminNote: opts?.note ?? null,
    globalExerciseId,
    migrationStatus: 'offered',
    reviewedAt: new Date(),
  })
  if (!updated) throw new SubmissionNotFoundError(submissionId)
  return updated
}

async function approveOrRejectMissingExercise(
  repos: Repos,
  submissionId: string,
): Promise<SubmissionRecord> {
  const updated = await repos.submissions.setReviewed(submissionId, {
    status: 'rejected',
    adminNote: 'The submitted exercise no longer exists.',
    reviewedAt: new Date(),
  })
  if (!updated) throw new SubmissionNotFoundError(submissionId)
  return updated
}

export async function rejectSubmission(
  repos: Repos,
  submissionId: string,
  opts?: { note?: string },
): Promise<SubmissionRecord> {
  const submission = await repos.submissions.getById(submissionId)
  if (!submission) throw new SubmissionNotFoundError(submissionId)
  if (submission.status !== 'pending') throw new SubmissionNotPendingError(submissionId)

  const updated = await repos.submissions.setReviewed(submissionId, {
    status: 'rejected',
    adminNote: opts?.note ?? null,
    reviewedAt: new Date(),
  })
  if (!updated) throw new SubmissionNotFoundError(submissionId)
  return updated
}

export async function listSubmissionsForAdmin(
  repos: Repos,
  status?: 'pending' | 'approved' | 'rejected',
): Promise<SubmissionAdminRecord[]> {
  return repos.submissions.listByStatus(status)
}

export async function getSubmissionForAdmin(
  repos: Repos,
  submissionId: string,
): Promise<SubmissionAdminRecord | null> {
  return repos.submissions.getAdminById(submissionId)
}

// Exported for tests / callers that want the raw normalize fn without
// pulling in the whole approve/reject flow.
export { normalizeForDedup }

// Pure helpers for the exercise-submission UI (Library "Submit to
// catalog" flow + the post-approval migration prompt). Kept dependency-
// free of React so they're trivially unit-testable.

import type { SubmissionDto } from '@rallypoint/fitness-shared'

// Submissions the actor should be prompted to migrate: approved and
// still awaiting a yes/no on rolling their logged history onto the now-
// global catalog exercise.
export function eligibleMigrationOffers(submissions: SubmissionDto[]): SubmissionDto[] {
  return submissions.filter((s) => s.status === 'approved' && s.migrationStatus === 'offered')
}

// Same as eligibleMigrationOffers, minus offers the actor already waved
// away this session. Dismissal is local-only (nothing is persisted), so
// the chrome gate's periodic re-checks must filter re-fetched offers
// against the dismissed set or the prompt would nag on every resume.
export function nextMigrationOffers(
  submissions: SubmissionDto[],
  dismissedIds: ReadonlySet<string>,
): SubmissionDto[] {
  return eligibleMigrationOffers(submissions).filter((s) => !dismissedIds.has(s.id))
}

// Look up the most recent submission for a given custom exercise id, if
// any — used to decide whether a status chip should render on that
// exercise's row/edit sheet. Submissions are returned newest-first is
// not guaranteed by the API, so this picks the most recently created.
export function latestSubmissionForExercise(
  submissions: SubmissionDto[],
  exerciseId: string,
): SubmissionDto | null {
  let latest: SubmissionDto | null = null
  for (const s of submissions) {
    if (s.exerciseId !== exerciseId) continue
    if (!latest || s.createdAt > latest.createdAt) latest = s
  }
  return latest
}

export interface SubmissionStatusChip {
  label: string
  tone: 'pending' | 'approved' | 'rejected'
}

// Maps a submission's status to the chip label/tone shown next to a
// custom exercise. Returns null when there's nothing to show (e.g. a
// migration was already accepted/declined and the exercise has moved
// on) — callers should not render a chip in that case.
export function submissionStatusChip(submission: SubmissionDto | null): SubmissionStatusChip | null {
  if (!submission) return null
  switch (submission.status) {
    case 'pending':
      return { label: 'Pending review', tone: 'pending' }
    case 'approved':
      return { label: 'Approved', tone: 'approved' }
    case 'rejected':
      return { label: 'Rejected', tone: 'rejected' }
    default:
      return null
  }
}

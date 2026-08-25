// Pure helpers for the food-submission UI (post-approval migration
// prompt on FoodPage). Mirrors lib/submissions.ts (the exercise-catalog
// equivalent) — kept dependency-free of React so it's trivially
// unit-testable.

import type { FoodSubmissionDto } from '@rallypoint/fitness-shared'

// Submissions the actor should be prompted to migrate: approved and
// still awaiting a yes/no on rolling their logged history onto the now-
// global food item.
export function eligibleFoodMigrationOffers(
  submissions: FoodSubmissionDto[],
): FoodSubmissionDto[] {
  return submissions.filter((s) => s.status === 'approved' && s.migrationStatus === 'offered')
}

export interface FoodSubmissionStatusChip {
  label: string
  tone: 'pending' | 'approved' | 'rejected'
}

// Maps a submission's status to the chip label/tone shown next to a
// contributed food item. Returns null when there's nothing to show.
export function foodSubmissionStatusChip(
  submission: FoodSubmissionDto | null,
): FoodSubmissionStatusChip | null {
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

// Maps a saveAsUpc log response's contributionStatus to the post-save
// notice text shown on FoodPage. `undefined`/'cached' means no notice.
export function foodContributionNotice(
  contributionStatus: 'submitted' | 'already_pending' | 'cached' | 'corrected' | undefined,
): string | null {
  switch (contributionStatus) {
    case 'submitted':
      return "Submitted for review — it'll join the shared database once approved."
    case 'already_pending':
      return 'This barcode is already awaiting review — logged privately for now.'
    case 'corrected':
      return 'Fixed — future scans of this barcode will use your corrected nutrition.'
    default:
      return null
  }
}

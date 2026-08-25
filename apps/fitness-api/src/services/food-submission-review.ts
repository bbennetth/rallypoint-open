import { ulid } from 'ulid'
import { planFoodPromotion } from '../lib/food-submission-promote.js'
import { UniqueConstraintError } from '@rallypoint/api-kit'
import type {
  FoodSubmissionAdminRecord,
  FoodSubmissionRecord,
  FoodSubmissionStatus,
  Repos,
} from '../repos/types.js'

// Admin review logic for food submissions: approve links to (or creates)
// the shared global food_items row and offers the submitter a migration
// of their diary entry off the interim private row; reject just records
// the note. Kept out of rpc.ts so FitnessRPC stays a thin dispatcher
// (mirrors services/submission-review.ts for exercise submissions).

export class FoodSubmissionNotFoundError extends Error {
  constructor(id: string) {
    super(`Food submission ${id} not found`)
    this.name = 'FoodSubmissionNotFoundError'
  }
}

export class FoodSubmissionNotPendingError extends Error {
  constructor(id: string) {
    super(`Food submission ${id} is not pending review`)
    this.name = 'FoodSubmissionNotPendingError'
  }
}

export async function approveFoodSubmission(
  repos: Repos,
  submissionId: string,
  opts?: { note?: string },
): Promise<FoodSubmissionRecord> {
  const submission = await repos.foodSubmissions.getById(submissionId)
  if (!submission) throw new FoodSubmissionNotFoundError(submissionId)
  if (submission.status !== 'pending') throw new FoodSubmissionNotPendingError(submissionId)

  const existingGlobal = await repos.foodItems.getByUpc(submission.upc)
  const plan = planFoodPromotion(existingGlobal ? existingGlobal.id : null)

  // Dedup by upc: two submissions for the same barcode must land on ONE
  // global row, not two near-duplicates in the shared cache.
  let globalFoodItemId: string
  if (plan.kind === 'link') {
    globalFoodItemId = plan.existingGlobalFoodItemId
  } else {
    try {
      const created = await repos.foodItems.create({
        id: `ff_${ulid()}`,
        upc: submission.upc,
        source: 'ai',
        name: submission.name,
        brand: submission.brand,
        servingGrams: submission.servingGrams,
        servingQuantity: submission.servingQuantity,
        servingUnit: submission.servingUnit,
        isLiquid: submission.isLiquid,
        per100g: submission.per100g,
        createdBy: submission.userId,
        raw: JSON.stringify({
          kind: 'ai-label-contribution',
          submissionId: submission.id,
          contributedBy: submission.userId,
        }),
      })
      globalFoodItemId = created.id
    } catch (err) {
      if (!(err instanceof UniqueConstraintError)) throw err
      // Lost a race against a concurrent approval/contribution of the
      // same upc — re-resolve to whichever row won.
      const raced = await repos.foodItems.getByUpc(submission.upc)
      if (!raced) throw new Error('upc_taken but no matching global row found')
      globalFoodItemId = raced.id
    }
  }

  const updated = await repos.foodSubmissions.setReviewed(submissionId, {
    status: 'approved',
    adminNote: opts?.note ?? null,
    globalFoodItemId,
    migrationStatus: 'offered',
    reviewedAt: new Date(),
  })
  if (!updated) throw new FoodSubmissionNotFoundError(submissionId)
  // setReviewed's UPDATE is guarded on status='pending'; if a concurrent
  // review won that race the returned row carries the OTHER outcome —
  // report the conflict rather than claiming this approval applied.
  if (updated.status !== 'approved' || updated.globalFoodItemId !== globalFoodItemId) {
    throw new FoodSubmissionNotPendingError(submissionId)
  }
  return updated
}

export async function rejectFoodSubmission(
  repos: Repos,
  submissionId: string,
  opts?: { note?: string },
): Promise<FoodSubmissionRecord> {
  const submission = await repos.foodSubmissions.getById(submissionId)
  if (!submission) throw new FoodSubmissionNotFoundError(submissionId)
  if (submission.status !== 'pending') throw new FoodSubmissionNotPendingError(submissionId)

  const updated = await repos.foodSubmissions.setReviewed(submissionId, {
    status: 'rejected',
    adminNote: opts?.note ?? null,
    reviewedAt: new Date(),
  })
  if (!updated) throw new FoodSubmissionNotFoundError(submissionId)
  // See approveFoodSubmission: a lost status='pending' guard means a
  // concurrent review already landed — surface not_pending, not success.
  if (updated.status !== 'rejected') {
    throw new FoodSubmissionNotPendingError(submissionId)
  }
  return updated
}

export async function listFoodSubmissionsForAdmin(
  repos: Repos,
  status?: FoodSubmissionStatus,
): Promise<FoodSubmissionAdminRecord[]> {
  return repos.foodSubmissions.listByStatus(status)
}

export async function getFoodSubmissionForAdmin(
  repos: Repos,
  submissionId: string,
): Promise<FoodSubmissionAdminRecord | null> {
  return repos.foodSubmissions.getAdminById(submissionId)
}

// Exported for tests / callers that want the raw plan fn without pulling
// in the whole approve/reject flow.
export { planFoodPromotion }

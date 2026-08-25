import { Hono } from 'hono'
import { migrateFoodSubmissionSchema, type FoodSubmissionDto } from '@rallypoint/fitness-shared'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'
import type { FoodSubmissionRecord } from '../repos/types.js'
import { readJsonBody } from './_body.js'

// Food submissions — the user-facing side of the AI nutrition-label UPC
// contribution review queue (see routes/food.ts saveAsUpc +
// services/food-submission-review.ts for the admin side). Cookie + CSRF
// + session gated in build-app (mirrors submissions.ts).

function toDto(r: FoodSubmissionRecord): FoodSubmissionDto {
  return {
    id: r.id,
    upc: r.upc,
    status: r.status,
    adminNote: r.adminNote,
    privateFoodItemId: r.privateFoodItemId,
    globalFoodItemId: r.globalFoodItemId,
    migrationStatus: r.migrationStatus,
    name: r.name,
    brand: r.brand,
    servingGrams: r.servingGrams,
    servingQuantity: r.servingQuantity,
    servingUnit: r.servingUnit,
    isLiquid: r.isLiquid,
    per100g: {
      kcal: r.per100g.kcal,
      protein: r.per100g.proteinG,
      carbs: r.per100g.carbsG,
      fat: r.per100g.fatG,
    },
    createdAt: r.createdAt.toISOString(),
    reviewedAt: r.reviewedAt?.toISOString() ?? null,
    migratedAt: r.migratedAt?.toISOString() ?? null,
  }
}

export const foodSubmissionsRoutes = new Hono<HonoApp>()
  // --- list the actor's own contributions ------------------------------
  .get('/api/v1/ui/food-submissions', async (c) => {
    const userId = c.var.session!.userId
    const rows = await c.var.repos.foodSubmissions.listByUser(userId)
    return c.json({ submissions: rows.map(toDto) })
  })
  // --- accept/decline the offered migration ----------------------------
  .post('/api/v1/ui/food-submissions/:id/migrate', async (c) => {
    const userId = c.var.session!.userId
    const id = c.req.param('id')
    const parsed = migrateFoodSubmissionSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })

    const submission = await c.var.repos.foodSubmissions.getByIdForUser(id, userId)
    if (!submission) {
      throw errors.notFound('Food submission not found.')
    }
    if (submission.status !== 'approved' || submission.migrationStatus !== 'offered') {
      throw errors.conflict(
        'migration_not_offered',
        'This submission has no pending migration offer.',
      )
    }

    if (!parsed.data.accept) {
      const declined = await c.var.repos.foodSubmissions.declineMigration(id)
      if (!declined) throw errors.notFound('Food submission not found.')
      // The guarded UPDATE is a no-op when an accept won the race — don't
      // report "declined" for a migration that already ran.
      if (declined.migrationStatus !== 'declined') {
        throw errors.conflict(
          'migration_already_resolved',
          'This migration offer was already resolved.',
        )
      }
      return c.json(toDto(declined))
    }

    // globalFoodItemId is guaranteed non-null once status === 'approved'
    // (setReviewed always sets it alongside migrationStatus 'offered').
    if (!submission.globalFoodItemId) {
      throw errors.conflict(
        'migration_not_offered',
        'This submission has no global food item linked.',
      )
    }

    const accepted = await c.var.repos.foodSubmissions.acceptMigration({
      submissionId: id,
      userId,
      privateFoodItemId: submission.privateFoodItemId,
      globalFoodItemId: submission.globalFoodItemId,
    })
    if (!accepted) throw errors.notFound('Food submission not found.')
    if (accepted.migrationStatus !== 'accepted') {
      throw errors.conflict(
        'migration_already_resolved',
        'This migration offer was already resolved.',
      )
    }
    return c.json(toDto(accepted))
  })

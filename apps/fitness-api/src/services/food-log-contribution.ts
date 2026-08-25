import { ulid } from 'ulid'
import { constantTimeEqual } from '@rallypoint/crypto'
import { isPlausiblePer100g, type CreateFoodLogEntryInput } from '@rallypoint/fitness-shared'
import { UniqueConstraintError } from '@rallypoint/api-kit'
import { contributionToken } from '../lib/contribution-token.js'
import { derivePer100g } from '../lib/food-log-create.js'
import type { FoodLogEntryRecord, NewFoodLogEntry, Repos } from '../repos/types.js'

// The POST /food/log write path: plain diary rows, private custom foods,
// and the shared-UPC contribution flow (token-verified against a real
// /food/label vision read, plausibility-gated, review-queued). Kept out
// of routes/food.ts so the route stays a thin parse → build → respond
// shell (mirrors services/food-submission-review.ts for the admin side).

export class ContributionForbiddenError extends Error {
  constructor() {
    super('Contribution token did not verify for this (user, upc)')
    this.name = 'ContributionForbiddenError'
  }
}

export class ImplausibleMacrosError extends Error {
  constructor() {
    super('Reviewed macros are implausible for the logged amount')
    this.name = 'ImplausibleMacrosError'
  }
}

export type ContributionStatus = 'already_pending' | 'submitted' | 'cached' | 'corrected'

export async function createFoodLogWithContribution(
  repos: Repos,
  userId: string,
  sessionKey: string,
  body: CreateFoodLogEntryInput,
  create: NewFoodLogEntry,
): Promise<{
  created: FoodLogEntryRecord
  contributionStatus?: ContributionStatus
  // Present only on the 'submitted' branch — the freshly minted
  // food_submissions id, so the route can fire the AI triage scan
  // after the transactional write commits.
  submissionId?: string
}> {
  if (body.saveAsUpc) {
    const s = body.saveAsUpc
    // Verify the contribution came from a real /food/label vision read
    // for this (user, upc) — otherwise a client could forge a review-
    // queue entry for any barcode it never scanned.
    const expected = await contributionToken(userId, s.upc, sessionKey)
    if (!constantTimeEqual(s.token, expected)) {
      throw new ContributionForbiddenError()
    }
    const per100g = derivePer100g(body, body.quantityGrams!)
    // The token proves a real scan, but the REVIEWED numbers still feed
    // the review queue — bound them so an implausible edit (e.g. a tiny
    // amount + huge macros) can't poison a future global cache row.
    if (!isPlausiblePer100g(per100g)) {
      throw new ImplausibleMacrosError()
    }

    const existingGlobal = await repos.foodItems.getByUpc(s.upc)
    if (existingGlobal && s.correction) {
      // "Incorrect?" flow: the user re-scanned the label for a UPC we
      // already cache (typically bad OFF data) and reviewed the fresh
      // read — replace the global row in place. The token above proves
      // a real /food/label vision read for this (user, upc), and the
      // plausibility gate already ran; barcode lookups cache-hit this
      // corrected row from now on, so OFF is never consulted (and its
      // write-throughs are onConflictDoNothing, so it can't clobber
      // the correction either). Row id stays stable for old diary rows.
      const overridden = await repos.foodItems.overrideByUpc(s.upc, {
        name: body.name,
        brand: s.brand ?? null,
        servingGrams: s.servingGrams,
        servingQuantity: s.servingGrams,
        servingUnit: s.servingUnit,
        isLiquid: s.isLiquid,
        per100g,
        raw: JSON.stringify({
          kind: 'user-correction',
          correctedBy: userId,
          previous: { source: existingGlobal.source, per100g: existingGlobal.per100g },
        }),
      })
      // overrideByUpc only misses if the global row vanished between the
      // read above and the update — fall through to the contribution
      // path below in that case instead of failing the log write.
      if (overridden) {
        const created = await repos.foodLog.create({ ...create, foodItemId: overridden.id })
        return { created, contributionStatus: 'corrected' }
      }
    }
    if (existingGlobal) {
      // Another contribution already promoted this upc into the shared
      // cache (or it's an OFF row) — log against it directly, same as
      // before the review queue existed.
      const created = await repos.foodLog.createWithUpcFood(
        {
          id: `ff_${ulid()}`,
          upc: s.upc,
          source: 'ai',
          name: body.name,
          brand: s.brand ?? null,
          servingGrams: s.servingGrams,
          servingQuantity: s.servingGrams,
          servingUnit: s.servingUnit,
          isLiquid: s.isLiquid,
          per100g,
          raw: JSON.stringify({
            kind: 'ai-label-contribution',
            contributedBy: userId,
            reviewed: { name: body.name, servingGrams: s.servingGrams, servingUnit: s.servingUnit, per100g },
          }),
          createdBy: userId,
        },
        create,
      )
      return { created, contributionStatus: 'cached' }
    }
    // No global row yet — the private item never carries the upc
    // (the partial unique index on food_submissions must stay free
    // for the eventual global row); the diary entry points at the
    // private row either way.
    const privateFood: Parameters<typeof repos.foodLog.createWithPrivateFood>[0] = {
      id: `ff_${ulid()}`,
      source: 'ai',
      name: body.name,
      brand: s.brand ?? null,
      servingGrams: s.servingGrams,
      servingQuantity: s.servingGrams,
      servingUnit: s.servingUnit,
      isLiquid: s.isLiquid,
      per100g,
      raw: JSON.stringify({
        kind: 'ai-label-contribution',
        contributedBy: userId,
        reviewed: { name: body.name, servingGrams: s.servingGrams, servingUnit: s.servingUnit, per100g },
      }),
      createdBy: userId,
      ownerUserId: userId,
    }

    const pending = await repos.foodSubmissions.getPendingByUpc(s.upc)
    if (pending) {
      // Someone else's contribution for this upc is already in the
      // review queue — this user still gets a working private item,
      // but no second submission row (the partial unique index would
      // reject it anyway).
      const created = await repos.foodLog.createWithPrivateFood(privateFood, create)
      return { created, contributionStatus: 'already_pending' }
    }
    try {
      const submissionId = `fdsub_${ulid()}`
      const created = await repos.foodLog.createWithUpcSubmission(privateFood, create, {
        id: submissionId,
        upc: s.upc,
      })
      return { created, contributionStatus: 'submitted', submissionId }
    } catch (err) {
      if (!(err instanceof UniqueConstraintError)) throw err
      // Lost the partial-unique-index race against a concurrent
      // submission for the same upc between the pre-check above
      // and this insert — fall back to the private-only path.
      const created = await repos.foodLog.createWithPrivateFood(privateFood, create)
      return { created, contributionStatus: 'already_pending' }
    }
  }
  if (body.saveAsCustom) {
    const created = await repos.foodLog.createWithCustomFood(
      {
        id: `ff_${ulid()}`,
        source: 'manual',
        name: body.name,
        servingGrams: body.quantityGrams!,
        servingQuantity: body.quantityGrams!,
        servingUnit: 'g',
        isLiquid: false,
        per100g: derivePer100g(body, body.quantityGrams!),
        createdBy: userId,
        ownerUserId: userId,
      },
      create,
    )
    return { created }
  }
  return { created: await repos.foodLog.create(create) }
}

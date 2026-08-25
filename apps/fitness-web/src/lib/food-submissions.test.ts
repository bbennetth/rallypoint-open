import { describe, expect, it } from 'vitest'
import type { FoodSubmissionDto } from '@rallypoint/fitness-shared'
import {
  eligibleFoodMigrationOffers,
  foodContributionNotice,
  foodSubmissionStatusChip,
} from './food-submissions.js'

function makeSubmission(overrides: Partial<FoodSubmissionDto> = {}): FoodSubmissionDto {
  return {
    id: 'fsub_1',
    upc: '012345678905',
    status: 'pending',
    adminNote: null,
    privateFoodItemId: 'food_1',
    globalFoodItemId: null,
    migrationStatus: 'none',
    name: 'Protein Bar',
    brand: 'Acme',
    servingGrams: 60,
    servingQuantity: 1,
    servingUnit: 'g',
    isLiquid: false,
    per100g: { kcal: 400, protein: 30, carbs: 40, fat: 10 },
    createdAt: '2026-07-01T00:00:00.000Z',
    reviewedAt: null,
    migratedAt: null,
    ...overrides,
  }
}

describe('eligibleFoodMigrationOffers', () => {
  it('includes only approved submissions with an offered migration', () => {
    const subs = [
      makeSubmission({ id: 'a', status: 'pending', migrationStatus: 'none' }),
      makeSubmission({ id: 'b', status: 'approved', migrationStatus: 'offered' }),
      makeSubmission({ id: 'c', status: 'approved', migrationStatus: 'accepted' }),
      makeSubmission({ id: 'd', status: 'approved', migrationStatus: 'declined' }),
      makeSubmission({ id: 'e', status: 'rejected', migrationStatus: 'none' }),
    ]
    expect(eligibleFoodMigrationOffers(subs).map((s) => s.id)).toEqual(['b'])
  })

  it('returns an empty array when there are no submissions', () => {
    expect(eligibleFoodMigrationOffers([])).toEqual([])
  })
})

describe('foodSubmissionStatusChip', () => {
  it('returns null for no submission', () => {
    expect(foodSubmissionStatusChip(null)).toBeNull()
  })

  it('maps pending/approved/rejected to labels and tones', () => {
    expect(foodSubmissionStatusChip(makeSubmission({ status: 'pending' }))).toEqual({
      label: 'Pending review',
      tone: 'pending',
    })
    expect(foodSubmissionStatusChip(makeSubmission({ status: 'approved' }))).toEqual({
      label: 'Approved',
      tone: 'approved',
    })
    expect(foodSubmissionStatusChip(makeSubmission({ status: 'rejected' }))).toEqual({
      label: 'Rejected',
      tone: 'rejected',
    })
  })
})

describe('foodContributionNotice', () => {
  it('maps submitted/already_pending to notice text', () => {
    expect(foodContributionNotice('submitted')).toMatch(/Submitted for review/)
    expect(foodContributionNotice('already_pending')).toMatch(/already awaiting review/)
  })

  it('returns null for cached or undefined', () => {
    expect(foodContributionNotice('cached')).toBeNull()
    expect(foodContributionNotice(undefined)).toBeNull()
  })
})

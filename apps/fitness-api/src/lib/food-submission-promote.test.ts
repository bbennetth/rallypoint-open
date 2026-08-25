import { describe, expect, it } from 'vitest'
import { planFoodPromotion } from './food-submission-promote.js'

describe('planFoodPromotion', () => {
  it('plans a create when no global food item exists for the upc', () => {
    expect(planFoodPromotion(null)).toEqual({ kind: 'create' })
  })

  it('plans a link to the existing global food item when one already exists', () => {
    expect(planFoodPromotion('ff_existing')).toEqual({
      kind: 'link',
      existingGlobalFoodItemId: 'ff_existing',
    })
  })
})

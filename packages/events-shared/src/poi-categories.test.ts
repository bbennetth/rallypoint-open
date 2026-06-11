import { describe, it, expect } from 'vitest'
import { POI_CATEGORY_IDS, isPoiCategory } from './poi-categories.js'

describe('POI_CATEGORY_IDS', () => {
  it('has no duplicates', () => {
    expect(new Set(POI_CATEGORY_IDS).size).toBe(POI_CATEGORY_IDS.length)
  })

  it('includes the festival-planner staples', () => {
    for (const id of ['stage', 'water', 'restroom', 'first_aid', 'camp_site']) {
      expect(POI_CATEGORY_IDS).toContain(id)
    }
  })
})

describe('isPoiCategory', () => {
  it.each(POI_CATEGORY_IDS)('accepts the known category %s', (id) => {
    expect(isPoiCategory(id)).toBe(true)
  })

  it.each(['', 'unknown', 'STAGE', 'first aid'])('rejects %s', (id) => {
    expect(isPoiCategory(id)).toBe(false)
  })
})

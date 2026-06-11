import { describe, it, expect } from 'vitest'
import {
  rallyTitleField,
  rallyDescriptionField,
  rallyLocationLabelField,
  rallyStatusField,
  rallyRsvpStatusField,
  CreateRallySchema,
  PatchRallySchema,
  RallyRsvpSchema,
} from './rally-validators.js'

describe('rallyTitleField', () => {
  it('accepts and trims a normal title', () => {
    expect(rallyTitleField.parse('  Main gate 6pm  ')).toBe('Main gate 6pm')
  })
  it('rejects empty / whitespace-only', () => {
    expect(rallyTitleField.safeParse('   ').success).toBe(false)
  })
  it('rejects over 200 chars', () => {
    expect(rallyTitleField.safeParse('x'.repeat(201)).success).toBe(false)
  })
})

describe('rallyDescriptionField', () => {
  it('normalises empty string to null', () => {
    expect(rallyDescriptionField.parse('')).toBeNull()
    expect(rallyDescriptionField.parse('   ')).toBeNull()
  })
  it('leaves absent as undefined', () => {
    expect(rallyDescriptionField.parse(undefined)).toBeUndefined()
  })
  it('rejects over 5000 chars', () => {
    expect(rallyDescriptionField.safeParse('x'.repeat(5001)).success).toBe(false)
  })
})

describe('rallyLocationLabelField', () => {
  it('normalises empty string to null', () => {
    expect(rallyLocationLabelField.parse('')).toBeNull()
  })
  it('rejects over 200 chars', () => {
    expect(rallyLocationLabelField.safeParse('x'.repeat(201)).success).toBe(false)
  })
})

describe('rallyStatusField', () => {
  it('accepts the three statuses', () => {
    expect(rallyStatusField.parse('proposed')).toBe('proposed')
    expect(rallyStatusField.parse('active')).toBe('active')
    expect(rallyStatusField.parse('cancelled')).toBe('cancelled')
  })
  it('rejects unknown status', () => {
    expect(rallyStatusField.safeParse('done').success).toBe(false)
  })
})

describe('rallyRsvpStatusField', () => {
  it('accepts going / maybe / out', () => {
    expect(rallyRsvpStatusField.parse('going')).toBe('going')
    expect(rallyRsvpStatusField.parse('maybe')).toBe('maybe')
    expect(rallyRsvpStatusField.parse('out')).toBe('out')
  })
  it('rejects unknown rsvp', () => {
    expect(rallyRsvpStatusField.safeParse('yes').success).toBe(false)
  })
})

describe('CreateRallySchema', () => {
  it('accepts a minimal title-only body', () => {
    const r = CreateRallySchema.safeParse({ title: 'Meet at the main stage' })
    expect(r.success).toBe(true)
  })

  it('accepts a fully-specified rally with a POI location', () => {
    const r = CreateRallySchema.safeParse({
      title: 'Pre-set huddle',
      description: 'By the bar',
      dayId: 'evd_01',
      startTime: '18:30',
      poiId: 'evp_01',
      status: 'active',
    })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.startTime).toBe('18:30')
      expect(r.data.status).toBe('active')
    }
  })

  it('accepts off-map lat+lng together', () => {
    const r = CreateRallySchema.safeParse({ title: 'Field spot', lat: 51.5, lng: -0.12 })
    expect(r.success).toBe(true)
  })

  it('rejects a lone latitude', () => {
    const r = CreateRallySchema.safeParse({ title: 'Field spot', lat: 51.5 })
    expect(r.success).toBe(false)
  })

  it('rejects a lone longitude', () => {
    const r = CreateRallySchema.safeParse({ title: 'Field spot', lng: -0.12 })
    expect(r.success).toBe(false)
  })

  it('rejects an out-of-range latitude', () => {
    const r = CreateRallySchema.safeParse({ title: 'Bad spot', lat: 200, lng: 0 })
    expect(r.success).toBe(false)
  })

  it('rejects a missing title', () => {
    const r = CreateRallySchema.safeParse({ description: 'no title' })
    expect(r.success).toBe(false)
  })

  it('rejects a malformed start time', () => {
    const r = CreateRallySchema.safeParse({ title: 'x', startTime: '25:99' })
    expect(r.success).toBe(false)
  })

  it('empties dayId to null', () => {
    const r = CreateRallySchema.safeParse({ title: 'x', dayId: '' })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.dayId).toBeNull()
  })
})

describe('PatchRallySchema', () => {
  it('rejects an empty patch', () => {
    expect(PatchRallySchema.safeParse({}).success).toBe(false)
  })

  it('accepts a single-field patch', () => {
    const r = PatchRallySchema.safeParse({ title: 'New title' })
    expect(r.success).toBe(true)
  })

  it('clears description with empty string → null', () => {
    const r = PatchRallySchema.safeParse({ description: '' })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.description).toBeNull()
  })

  it('still enforces lat/lng-together on patch', () => {
    const r = PatchRallySchema.safeParse({ lat: 51.5 })
    expect(r.success).toBe(false)
  })

  it('rejects clearing a lone coordinate (half-clear)', () => {
    expect(PatchRallySchema.safeParse({ lat: null }).success).toBe(false)
    expect(PatchRallySchema.safeParse({ lng: null }).success).toBe(false)
  })

  it('rejects setting one coordinate while clearing the other', () => {
    expect(PatchRallySchema.safeParse({ lat: 51.5, lng: null }).success).toBe(false)
  })

  it('accepts clearing both coordinates together', () => {
    const r = PatchRallySchema.safeParse({ lat: null, lng: null })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.lat).toBeNull()
      expect(r.data.lng).toBeNull()
    }
  })

  it('accepts a status-only patch', () => {
    const r = PatchRallySchema.safeParse({ status: 'cancelled' })
    expect(r.success).toBe(true)
  })
})

describe('RallyRsvpSchema', () => {
  it('accepts a valid rsvp', () => {
    expect(RallyRsvpSchema.safeParse({ status: 'going' }).success).toBe(true)
  })
  it('rejects a missing status', () => {
    expect(RallyRsvpSchema.safeParse({}).success).toBe(false)
  })
})

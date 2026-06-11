import { describe, expect, it } from 'vitest'
import { buildEventPatch, eventDetailsDraft } from './event-patch.js'
import type { EventDto } from './api.js'

function event(p: Partial<EventDto> = {}): EventDto {
  return {
    id: 'evt_1',
    slug: 'demo',
    name: 'Demo',
    description: null,
    start_date: null,
    end_date: null,
    timezone: 'UTC',
    location_label: null,
    location_lat: null,
    location_lng: null,
    privacy_mode: 'unlisted',
    public_page_config: null,
    owner_user_id: 'u',
    viewer_role: 'owner',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    deleted_at: null,
    ...p,
  }
}

describe('eventDetailsDraft', () => {
  it('seeds a flat draft from the event, mapping nulls to empty strings', () => {
    const d = eventDetailsDraft(event({ description: 'Hi', start_date: '2026-05-01' }))
    expect(d).toEqual({
      name: 'Demo',
      description: 'Hi',
      startDate: '2026-05-01',
      endDate: '',
      locationLabel: '',
      privacyMode: 'unlisted',
    })
  })
})

describe('buildEventPatch', () => {
  it('returns an empty patch when nothing changed', () => {
    const e = event({ start_date: '2026-05-01' })
    expect(buildEventPatch(e, eventDetailsDraft(e))).toEqual({})
  })

  it('sets dates that were previously empty', () => {
    const e = event()
    const patch = buildEventPatch(e, {
      ...eventDetailsDraft(e),
      startDate: '2026-05-01',
      endDate: '2026-05-03',
    })
    expect(patch).toEqual({ startDate: '2026-05-01', endDate: '2026-05-03' })
  })

  it('changes an existing date', () => {
    const e = event({ start_date: '2026-05-01' })
    const patch = buildEventPatch(e, { ...eventDetailsDraft(e), startDate: '2026-05-02' })
    expect(patch).toEqual({ startDate: '2026-05-02' })
  })

  it('ignores an emptied date (API has no null for dates)', () => {
    const e = event({ start_date: '2026-05-01' })
    const patch = buildEventPatch(e, { ...eventDetailsDraft(e), startDate: '' })
    expect(patch).toEqual({})
  })

  it('trims and clears text fields, and includes name/privacy changes', () => {
    const e = event({ name: 'Old', location_label: 'Hall A' })
    const patch = buildEventPatch(e, {
      ...eventDetailsDraft(e),
      name: '  New  ',
      locationLabel: '',
      privacyMode: 'public',
    })
    expect(patch).toEqual({ name: 'New', locationLabel: '', privacyMode: 'public' })
  })
})

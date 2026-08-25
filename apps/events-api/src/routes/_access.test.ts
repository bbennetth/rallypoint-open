import { describe, it, expect } from 'vitest'
import { SYSTEM_USER_ID } from '@rallypoint/shared'
import { isBrowsableEvent } from './_access.js'
import type { EventRecord, PrivacyMode } from '../repos/types.js'

function event(over: Partial<EventRecord>): EventRecord {
  return {
    id: 'event_1',
    tenantId: 'rallypoint',
    ownerUserId: 'user_owner',
    slug: 'fest',
    name: 'Fest',
    description: null,
    startDate: null,
    endDate: null,
    timezone: 'UTC',
    locationLabel: null,
    locationLat: null,
    locationLng: null,
    privacyMode: 'unlisted',
    publicPageConfig: null,
    features: null,
    scopeType: 'group',
    startAt: null,
    endAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    ticketCount: 0,
    ticketPlatform: null,
    ticketAccountEmail: null,
    allDay: null,
    ref: null,
    ...over,
  }
}

describe('isBrowsableEvent', () => {
  it('system-owned events are browsable under every privacy mode', () => {
    for (const privacyMode of ['public', 'unlisted', 'private'] as PrivacyMode[]) {
      expect(isBrowsableEvent(event({ ownerUserId: SYSTEM_USER_ID, privacyMode }))).toBe(true)
    }
  })

  it('user-owned events are browsable only when public', () => {
    expect(isBrowsableEvent(event({ privacyMode: 'public' }))).toBe(true)
    expect(isBrowsableEvent(event({ privacyMode: 'unlisted' }))).toBe(false)
    expect(isBrowsableEvent(event({ privacyMode: 'private' }))).toBe(false)
  })

  it('soft-deleted events are never browsable', () => {
    const deletedAt = new Date()
    expect(
      isBrowsableEvent(event({ ownerUserId: SYSTEM_USER_ID, deletedAt })),
    ).toBe(false)
    expect(isBrowsableEvent(event({ privacyMode: 'public', deletedAt }))).toBe(false)
  })
})

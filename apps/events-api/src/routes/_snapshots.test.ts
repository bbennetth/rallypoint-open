import { describe, expect, it } from 'vitest'
import { deserializeLineupSnapshot, deserializeSessionsSnapshot } from './_snapshots.js'

describe('deserializeLineupSnapshot', () => {
  it('round-trips lineup rows as pure strings', () => {
    const rows = [
      {
        eventId: 'evt_1',
        artistId: 'art_1',
        dayId: 'evd_1',
        stageId: 'stg_1',
        tier: 'headliner',
        genre: 'rock',
        startTime: '18:00:00',
        endTime: '19:00:00',
        displayName: 'The Band',
      },
    ]
    expect(deserializeLineupSnapshot(rows)).toEqual(rows)
  })

  it('coerces missing nullable fields to null', () => {
    const out = deserializeLineupSnapshot([
      { eventId: 'evt_1', artistId: 'art_1', dayId: 'evd_1' },
    ])
    expect(out[0]).toEqual({
      eventId: 'evt_1',
      artistId: 'art_1',
      dayId: 'evd_1',
      stageId: null,
      tier: null,
      genre: null,
      startTime: null,
      endTime: null,
      displayName: null,
    })
  })

  it('returns [] for non-array data', () => {
    expect(deserializeLineupSnapshot(null)).toEqual([])
    expect(deserializeLineupSnapshot({})).toEqual([])
  })
})

describe('deserializeSessionsSnapshot', () => {
  it('parses ISO date strings back into Date objects (pg jsonb path)', () => {
    const out = deserializeSessionsSnapshot([
      {
        id: 'evx_1',
        eventId: 'evt_1',
        title: 'Yoga',
        description: null,
        location: null,
        dayId: 'evd_1',
        startTime: '08:00:00',
        endTime: '09:00:00',
        category: null,
        host: null,
        approvalStatus: 'approved',
        visibility: 'admin',
        groupId: null,
        sharedWith: null,
        createdByUserId: 'usr_1',
        submittedByUserId: null,
        approvedByUserId: 'usr_1',
        approvedAt: '2026-05-01T12:00:00.000Z',
        createdAt: '2026-05-01T10:00:00.000Z',
        updatedAt: '2026-05-01T11:00:00.000Z',
        deletedAt: null,
      },
    ])
    const s = out[0]!
    expect(s.createdAt).toBeInstanceOf(Date)
    expect(s.createdAt.toISOString()).toBe('2026-05-01T10:00:00.000Z')
    expect(s.approvedAt?.toISOString()).toBe('2026-05-01T12:00:00.000Z')
    expect(s.deletedAt).toBeNull()
  })

  it('passes through Date instances (memory path)', () => {
    const created = new Date('2026-05-01T10:00:00.000Z')
    const out = deserializeSessionsSnapshot([
      {
        id: 'evx_1',
        eventId: 'evt_1',
        title: 'Yoga',
        approvalStatus: 'pending',
        visibility: 'admin',
        createdByUserId: 'usr_1',
        createdAt: created,
        updatedAt: created,
        deletedAt: null,
        approvedAt: null,
      },
    ])
    expect(out[0]!.createdAt.getTime()).toBe(created.getTime())
  })

  it('preserves sharedWith arrays', () => {
    const out = deserializeSessionsSnapshot([
      {
        id: 'evx_1',
        eventId: 'evt_1',
        title: 'Private',
        approvalStatus: 'approved',
        visibility: 'custom',
        sharedWith: ['usr_2', 'usr_3'],
        createdByUserId: 'usr_1',
        createdAt: '2026-05-01T10:00:00.000Z',
        updatedAt: '2026-05-01T10:00:00.000Z',
        deletedAt: null,
        approvedAt: null,
      },
    ])
    expect(out[0]!.sharedWith).toEqual(['usr_2', 'usr_3'])
  })

  it('returns [] for non-array data', () => {
    expect(deserializeSessionsSnapshot(undefined)).toEqual([])
  })
})

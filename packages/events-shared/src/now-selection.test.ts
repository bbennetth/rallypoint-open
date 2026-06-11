import { describe, it, expect } from 'vitest'
import {
  selectActiveSessions,
  selectCurrentLineup,
  selectUpcomingRallies,
  type LineupArtistSummary,
  type LineupDay,
  type LineupSlot,
  type LineupStage,
  type RallySlot,
  type SessionSlot,
} from './now-selection.js'

// All tests use a fixed `now` so the parsing + window math is
// deterministic. Times are local — the helper builds Dates via the
// device's tz, which matches what `combineDayTime` does internally.

const NOW = new Date(2026, 5, 15, 21, 30, 0) // 2026-06-15 21:30 local

const day = (id: string, date: string): LineupDay => ({ id, date })
const stage = (id: string, name: string, sortOrder = 0): LineupStage => ({
  id,
  name,
  sortOrder,
})
const artist = (id: string, name: string): LineupArtistSummary => ({ id, name })
const slot = (overrides: Partial<LineupSlot> & { artistId: string; dayId: string }): LineupSlot => ({
  stageId: null,
  startTime: null,
  endTime: null,
  ...overrides,
})

describe('selectCurrentLineup', () => {
  const stages = [stage('main', 'Main', 0), stage('side', 'Side', 1)]
  const days = [day('d1', '2026-06-15'), day('d2', '2026-06-16')]
  const artists = [artist('a1', 'A1'), artist('a2', 'A2'), artist('a3', 'A3')]

  it('returns nothing when no slots overlap or follow now', () => {
    const slots: LineupSlot[] = [
      slot({ artistId: 'a1', dayId: 'd1', stageId: 'main', startTime: '14:00', endTime: '15:00' }),
    ]
    const out = selectCurrentLineup({ slots, days, stages, artists, now: NOW })
    expect(out).toEqual([])
  })

  it('identifies the current set when now is mid-window', () => {
    const slots: LineupSlot[] = [
      slot({ artistId: 'a1', dayId: 'd1', stageId: 'main', startTime: '21:00', endTime: '22:00' }),
      slot({ artistId: 'a2', dayId: 'd1', stageId: 'main', startTime: '22:00', endTime: '23:00' }),
    ]
    const out = selectCurrentLineup({ slots, days, stages, artists, now: NOW })
    expect(out).toHaveLength(1)
    expect(out[0]!.stageName).toBe('Main')
    expect(out[0]!.current?.artistName).toBe('A1')
    expect(out[0]!.next?.artistName).toBe('A2')
  })

  it('finds only the next set when between sets', () => {
    const slots: LineupSlot[] = [
      slot({ artistId: 'a1', dayId: 'd1', stageId: 'main', startTime: '20:00', endTime: '21:00' }),
      slot({ artistId: 'a2', dayId: 'd1', stageId: 'main', startTime: '22:00', endTime: '23:00' }),
    ]
    const out = selectCurrentLineup({ slots, days, stages, artists, now: NOW })
    expect(out).toHaveLength(1)
    expect(out[0]!.current).toBeNull()
    expect(out[0]!.next?.artistName).toBe('A2')
  })

  it('defaults a 60-min window when endTime is null', () => {
    const slots: LineupSlot[] = [
      // Starts at 21:00, default block ends at 22:00 → covers 21:30.
      slot({ artistId: 'a1', dayId: 'd1', stageId: 'main', startTime: '21:00' }),
    ]
    const out = selectCurrentLineup({ slots, days, stages, artists, now: NOW })
    expect(out[0]!.current?.artistName).toBe('A1')
  })

  it('preserves displayName when set; falls back to artist name', () => {
    const slots: LineupSlot[] = [
      slot({
        artistId: 'a1',
        dayId: 'd1',
        stageId: 'main',
        startTime: '21:00',
        endTime: '22:00',
        displayName: 'A1 b2b A2',
      }),
    ]
    const out = selectCurrentLineup({ slots, days, stages, artists, now: NOW })
    expect(out[0]!.current?.artistName).toBe('A1 b2b A2')
  })

  it('skips slots whose day is missing from the day list', () => {
    const slots: LineupSlot[] = [
      slot({ artistId: 'a1', dayId: 'no-such-day', stageId: 'main', startTime: '21:00' }),
    ]
    const out = selectCurrentLineup({ slots, days, stages, artists, now: NOW })
    expect(out).toEqual([])
  })

  it('respects stage sortOrder; stageless rows last', () => {
    const slots: LineupSlot[] = [
      slot({ artistId: 'a1', dayId: 'd1', stageId: 'side', startTime: '21:00' }),
      slot({ artistId: 'a2', dayId: 'd1', stageId: 'main', startTime: '21:00' }),
      slot({ artistId: 'a3', dayId: 'd1', stageId: null, startTime: '21:00' }),
    ]
    const out = selectCurrentLineup({ slots, days, stages, artists, now: NOW })
    expect(out.map((r) => r.stageId)).toEqual(['main', 'side', null])
  })

  it('skips malformed times instead of throwing', () => {
    const slots: LineupSlot[] = [
      slot({ artistId: 'a1', dayId: 'd1', stageId: 'main', startTime: 'not-a-time' }),
    ]
    const out = selectCurrentLineup({ slots, days, stages, artists, now: NOW })
    expect(out).toEqual([])
  })
})

describe('selectUpcomingRallies', () => {
  const days = [day('d1', '2026-06-15')]
  const horizonMs = 3 * 60 * 60 * 1000 // 3h

  const r = (overrides: Partial<RallySlot> & { id: string }): RallySlot => ({
    title: overrides.id,
    dayId: 'd1',
    startTime: '22:00',
    status: 'active',
    ...overrides,
  })

  it('returns rallies whose start is in the horizon', () => {
    const out = selectUpcomingRallies({
      rallies: [r({ id: 'r1', startTime: '22:00' }), r({ id: 'r2', startTime: '23:00' })],
      days,
      now: NOW,
      horizonMs,
    })
    // Both are < 3h ahead of NOW=21:30 → both qualify.
    expect(out.map((x) => x.id)).toEqual(['r1', 'r2'])
  })

  it('excludes already-started rallies', () => {
    const out = selectUpcomingRallies({
      rallies: [r({ id: 'r1', startTime: '20:00' })],
      days,
      now: NOW,
      horizonMs,
    })
    expect(out).toEqual([])
  })

  it('excludes cancelled rallies', () => {
    const out = selectUpcomingRallies({
      rallies: [r({ id: 'r1', startTime: '22:00', status: 'cancelled' })],
      days,
      now: NOW,
      horizonMs,
    })
    expect(out).toEqual([])
  })

  it('excludes rallies with no day or no start time', () => {
    const out = selectUpcomingRallies({
      rallies: [
        r({ id: 'r1', dayId: null, startTime: '22:00' }),
        r({ id: 'r2', dayId: 'd1', startTime: null }),
      ],
      days,
      now: NOW,
      horizonMs,
    })
    expect(out).toEqual([])
  })

  it('sorts by startsAt then id', () => {
    const out = selectUpcomingRallies({
      rallies: [
        r({ id: 'r2', startTime: '22:00' }),
        r({ id: 'r1', startTime: '22:00' }),
        r({ id: 'r3', startTime: '23:00' }),
      ],
      days,
      now: NOW,
      horizonMs,
    })
    expect(out.map((x) => x.id)).toEqual(['r1', 'r2', 'r3'])
  })

  it('treats horizon boundary as inclusive', () => {
    const out = selectUpcomingRallies({
      // NOW + 3h = 00:30 next day. 00:30 != on the same day in our test
      // data, so test with a tight window where boundary matches.
      rallies: [r({ id: 'r1', startTime: '22:30' })],
      days,
      now: NOW,
      horizonMs: 60 * 60 * 1000, // exactly 1h → 22:30 boundary
    })
    expect(out).toHaveLength(1)
  })
})

describe('selectActiveSessions', () => {
  const days = [day('d1', '2026-06-15')]
  const s = (overrides: Partial<SessionSlot> & { id: string }): SessionSlot => ({
    title: overrides.id,
    dayId: 'd1',
    startTime: null,
    endTime: null,
    ...overrides,
  })

  it('finds sessions whose start..end covers now', () => {
    const out = selectActiveSessions({
      sessions: [s({ id: 'a', startTime: '21:00', endTime: '22:00' })],
      days,
      now: NOW,
    })
    expect(out.map((x) => x.id)).toEqual(['a'])
  })

  it('uses a 2h default window when endTime is null', () => {
    const out = selectActiveSessions({
      sessions: [s({ id: 'open', startTime: '20:00' })], // 20:00 + 2h covers 21:30
      days,
      now: NOW,
    })
    expect(out.map((x) => x.id)).toEqual(['open'])
  })

  it('excludes sessions that have already ended', () => {
    const out = selectActiveSessions({
      sessions: [s({ id: 'a', startTime: '19:00', endTime: '20:00' })],
      days,
      now: NOW,
    })
    expect(out).toEqual([])
  })

  it('excludes sessions without a day or start time', () => {
    const out = selectActiveSessions({
      sessions: [
        s({ id: 'a', dayId: null, startTime: '21:00' }),
        s({ id: 'b', startTime: null }),
      ],
      days,
      now: NOW,
    })
    expect(out).toEqual([])
  })

  it('sorts by startsAt', () => {
    const out = selectActiveSessions({
      sessions: [
        s({ id: 'late', startTime: '21:20', endTime: '22:00' }),
        s({ id: 'early', startTime: '21:00', endTime: '22:00' }),
      ],
      days,
      now: NOW,
    })
    expect(out.map((x) => x.id)).toEqual(['early', 'late'])
  })
})

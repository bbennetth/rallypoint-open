import { describe, expect, it } from 'vitest'
import type { DayDto, LineupSlotDto, StageDto } from './api.js'
import { artistLinks, artistSummaries, buildGroups, fmtTime, tierBadge } from './lineup-view.js'

const EVENT = 'evt-1'

function day(id: string, sortOrder: number, date = '2026-07-04'): DayDto {
  return {
    id,
    event_id: EVENT,
    day_label: id.toUpperCase(),
    date,
    start_time: null,
    end_time: null,
    sort_order: sortOrder,
  }
}

function stage(id: string, name: string): StageDto {
  return { id, event_id: EVENT, name, sort_order: 0 }
}

function slot(partial: Partial<LineupSlotDto> & { artist_id: string; day_id: string | null }): LineupSlotDto {
  return {
    event_id: EVENT,
    artist_name: null,
    stage_id: null,
    tier: null,
    genre: null,
    start_time: null,
    end_time: null,
    display_name: null,
    ...partial,
  }
}

describe('buildGroups', () => {
  it('orders days by sort_order and slots by start time within a day', () => {
    const groups = buildGroups(
      [
        slot({ artist_id: 'a2', day_id: 'd2', start_time: '20:00:00' }),
        slot({ artist_id: 'a1', day_id: 'd1', start_time: '22:00:00' }),
        slot({ artist_id: 'a3', day_id: 'd1', start_time: '18:00:00' }),
      ],
      [day('d2', 1), day('d1', 0)],
      [],
    )
    expect(groups.map((g) => g.day!.id)).toEqual(['d1', 'd2'])
    expect(groups[0]!.slots.map((s) => s.artistId)).toEqual(['a3', 'a1'])
  })

  it('drops days with no slots', () => {
    const groups = buildGroups(
      [slot({ artist_id: 'a1', day_id: 'd1' })],
      [day('d1', 0), day('d2', 1)],
      [],
    )
    expect(groups.map((g) => g.day!.id)).toEqual(['d1'])
  })

  it('returns nothing when no lineup is published', () => {
    expect(buildGroups([], [day('d1', 0)], [])).toEqual([])
  })

  it('prefers display_name, then artist_name, then the raw id', () => {
    const groups = buildGroups(
      [
        slot({ artist_id: 'a1', day_id: 'd1', display_name: 'Headliner', artist_name: 'Real Name' }),
        slot({ artist_id: 'a2', day_id: 'd1', artist_name: 'Support Act' }),
        slot({ artist_id: 'a3', day_id: 'd1' }),
      ],
      [day('d1', 0)],
      [],
    )
    expect(groups[0]!.slots.map((s) => s.artistName)).toEqual([
      'Headliner',
      'Support Act',
      'a3',
    ])
  })

  it('resolves stage names and leaves unknown stages null', () => {
    const groups = buildGroups(
      [
        slot({ artist_id: 'a1', day_id: 'd1', stage_id: 'st1' }),
        slot({ artist_id: 'a2', day_id: 'd1', stage_id: 'gone' }),
        slot({ artist_id: 'a3', day_id: 'd1' }),
      ],
      [day('d1', 0)],
      [stage('st1', 'Main Stage')],
    )
    expect(groups[0]!.slots.map((s) => s.stageName)).toEqual(['Main Stage', null, null])
  })

  it('does not mutate the caller arrays', () => {
    const days = [day('d2', 1), day('d1', 0)]
    buildGroups([slot({ artist_id: 'a1', day_id: 'd1' })], days, [])
    expect(days.map((d) => d.id)).toEqual(['d2', 'd1'])
  })
})

describe('artistSummaries', () => {
  it('lifts one summary per artist from the slots', () => {
    expect(
      artistSummaries([
        slot({ artist_id: 'a1', day_id: 'd1', artist_name: 'Neon Cathedral' }),
        slot({ artist_id: 'a2', day_id: 'd1', artist_name: 'Static Bloom' }),
      ]),
    ).toEqual([
      { id: 'a1', name: 'Neon Cathedral' },
      { id: 'a2', name: 'Static Bloom' },
    ])
  })

  it('dedupes an artist playing several days', () => {
    expect(
      artistSummaries([
        slot({ artist_id: 'a1', day_id: 'd1', artist_name: 'Neon Cathedral' }),
        slot({ artist_id: 'a1', day_id: 'd2', artist_name: 'Neon Cathedral' }),
      ]),
    ).toEqual([{ id: 'a1', name: 'Neon Cathedral' }])
  })

  it('keeps the first name when one artist id carries conflicting names', () => {
    // The API resolves each artist_id from one catalog row, so this shouldn't
    // happen — pinning first-wins so the tie-break is a decision, not an
    // accident of iteration order.
    expect(
      artistSummaries([
        slot({ artist_id: 'a1', day_id: 'd1', artist_name: 'Neon Cathedral' }),
        slot({ artist_id: 'a1', day_id: 'd2', artist_name: 'NEON CATHEDRAL' }),
      ]),
    ).toEqual([{ id: 'a1', name: 'Neon Cathedral' }])
  })

  it('takes the first named slot when an earlier slot has no name', () => {
    expect(
      artistSummaries([
        slot({ artist_id: 'a1', day_id: 'd1' }),
        slot({ artist_id: 'a1', day_id: 'd2', artist_name: 'Neon Cathedral' }),
      ]),
    ).toEqual([{ id: 'a1', name: 'Neon Cathedral' }])
  })

  it('skips slots with no artist name rather than inventing one', () => {
    expect(artistSummaries([slot({ artist_id: 'a1', day_id: 'd1' })])).toEqual([])
  })

  it('handles an empty lineup', () => {
    expect(artistSummaries([])).toEqual([])
  })
})

describe('fmtTime / tierBadge', () => {
  it('trims seconds and blanks a missing time', () => {
    expect(fmtTime('21:30:00')).toBe('21:30')
    expect(fmtTime(null)).toBe('')
  })

  it('upcases a tier and blanks a missing one', () => {
    expect(tierBadge('headliner')).toBe('HEADLINER')
    expect(tierBadge(null)).toBe('')
  })
})

describe('buildGroups — genre fallback', () => {
  it('prefers the per-slot genre over the catalog genre', () => {
    const groups = buildGroups(
      [slot({ artist_id: 'a1', day_id: 'd1', genre: 'techno', artist_genre: 'house' })],
      [day('d1', 0)],
      [],
    )
    expect(groups[0]!.slots[0]!.genre).toBe('techno')
  })

  it('falls back to the catalog genre when the slot has none', () => {
    const groups = buildGroups(
      [slot({ artist_id: 'a1', day_id: 'd1', artist_genre: 'house' })],
      [day('d1', 0)],
      [],
    )
    expect(groups[0]!.slots[0]!.genre).toBe('house')
  })

  it('is null when neither genre is set (older API omits artist_genre)', () => {
    const groups = buildGroups(
      [slot({ artist_id: 'a1', day_id: 'd1' })],
      [day('d1', 0)],
      [],
    )
    expect(groups[0]!.slots[0]!.genre).toBeNull()
  })
})

describe('artistLinks', () => {
  it('returns links in fixed service order, skipping missing ones', () => {
    expect(
      artistLinks({
        instagram: 'https://instagram.com/x',
        spotify: 'https://open.spotify.com/artist/x',
        soundcloud: null,
      }),
    ).toEqual([
      { kind: 'spotify', url: 'https://open.spotify.com/artist/x' },
      { kind: 'instagram', url: 'https://instagram.com/x' },
    ])
  })

  it('rejects non-http(s) and empty values', () => {
    expect(
      artistLinks({
        spotify: 'javascript:alert(1)',
        soundcloud: '',
        apple_music: 'ftp://nope',
        youtube_music: 'HTTPS://music.youtube.com/channel/x',
      }),
    ).toEqual([{ kind: 'youtube_music', url: 'HTTPS://music.youtube.com/channel/x' }])
  })

  it('is empty when an older API omits the fields entirely', () => {
    expect(artistLinks({})).toEqual([])
  })

  it('flows through buildGroups onto the slot view', () => {
    const groups = buildGroups(
      [slot({ artist_id: 'a1', day_id: 'd1', soundcloud: 'https://soundcloud.com/x' })],
      [day('d1', 0)],
      [],
    )
    expect(groups[0]!.slots[0]!.links).toEqual([
      { kind: 'soundcloud', url: 'https://soundcloud.com/x' },
    ])
  })
})

describe('buildGroups — unscheduled (TBA) slots', () => {
  it('collects null-day slots into a trailing TBA group', () => {
    const groups = buildGroups(
      [
        slot({ artist_id: 'a1', day_id: 'd1', start_time: '22:00:00' }),
        slot({ artist_id: 'a2', day_id: null, artist_name: 'TBA Act' }),
        slot({ artist_id: 'a3', day_id: null, artist_name: 'Another TBA' }),
      ],
      [day('d1', 0)],
      [],
    )
    expect(groups).toHaveLength(2)
    expect(groups[0]!.day!.id).toBe('d1')
    const tba = groups[1]!
    expect(tba.day).toBeNull()
    expect(tba.slots.map((s) => s.artistId).sort()).toEqual(['a2', 'a3'])
    expect(tba.slots.every((s) => s.dayId === null)).toBe(true)
  })

  it('omits the TBA group when every slot has a day', () => {
    const groups = buildGroups([slot({ artist_id: 'a1', day_id: 'd1' })], [day('d1', 0)], [])
    expect(groups).toHaveLength(1)
    expect(groups[0]!.day).not.toBeNull()
  })
})

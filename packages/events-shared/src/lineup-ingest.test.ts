import { describe, expect, it } from 'vitest'
import {
  ExtractedLineupSchema,
  buildLineupGuidedJson,
  guardAgainstHallucination,
  normalizeExtractedLineup,
} from './lineup-ingest.js'

describe('ExtractedLineupSchema', () => {
  it('accepts a minimal artists list and normalizes empty optionals to null', () => {
    const parsed = ExtractedLineupSchema.parse({
      artists: [{ name: '  Mochakk ', day: '', stage: null, tier: undefined }],
    })
    expect(parsed.artists[0]).toEqual({
      name: 'Mochakk',
      day: null,
      stage: null,
      tier: null,
      genre: null,
      start: null,
      end: null,
    })
  })

  it('rejects a missing artists array and over-long names', () => {
    expect(ExtractedLineupSchema.safeParse({}).success).toBe(false)
    expect(
      ExtractedLineupSchema.safeParse({ artists: [{ name: 'x'.repeat(201) }] }).success,
    ).toBe(false)
  })
})

describe('buildLineupGuidedJson', () => {
  it('pins day and stage enums to the event values', () => {
    const schema = buildLineupGuidedJson(
      ['Saturday', 'Sunday'],
      ['Ocean View', 'City Steps', 'The Palms'],
    ) as {
      properties: { artists: { items: { properties: Record<string, { enum?: string[] }> } } }
    }
    const props = schema.properties.artists.items.properties
    expect(props.day!.enum).toEqual(['Saturday', 'Sunday'])
    expect(props.stage!.enum).toEqual(['Ocean View', 'City Steps', 'The Palms'])
    expect(props.tier!.enum).toEqual(['headliner', 'support', 'opener'])
  })

  it('leaves day/stage unconstrained when the event has none yet', () => {
    const schema = buildLineupGuidedJson([], []) as {
      properties: { artists: { items: { properties: Record<string, { enum?: string[] }> } } }
    }
    expect(schema.properties.artists.items.properties.day!.enum).toBeUndefined()
  })
})

describe('normalizeExtractedLineup', () => {
  const extract = (artists: object[]) => ExtractedLineupSchema.parse({ artists })

  it('maps artists to planner rows with 1-based lines and lowercased tiers', () => {
    const { rows, errors } = normalizeExtractedLineup(
      extract([
        { name: 'Mochakk', day: 'Saturday', stage: 'Ocean View', tier: 'Headliner', start: '22:00' },
        { name: 'VTSS', day: 'Sunday' },
      ]),
    )
    expect(errors).toEqual([])
    expect(rows).toEqual([
      {
        line: 1,
        artist: 'Mochakk',
        day: 'Saturday',
        stage: 'Ocean View',
        tier: 'headliner',
        genre: null,
        start: '22:00',
        end: null,
      },
      { line: 2, artist: 'VTSS', day: 'Sunday', stage: null, tier: null, genre: null, start: null, end: null },
    ])
  })

  it('keeps day-less artists as unscheduled rows (day null) with no error', () => {
    const { rows, errors } = normalizeExtractedLineup(extract([{ name: 'salute' }]))
    expect(errors).toEqual([])
    expect(rows).toHaveLength(1)
    expect(rows[0]!.day).toBeNull()
  })
})

describe('guardAgainstHallucination', () => {
  const rows = (names: string[]) =>
    names.map((artist, i) => ({ line: i + 1, artist, day: 'Saturday' }))

  it('keeps names present in the source, drops absent ones', () => {
    const source = 'CRSSD FALL 26 — Mochakk · Chris Lake x Disclosure · KAS:ST'
    const { kept, dropped } = guardAgainstHallucination(
      rows(['Mochakk', 'KAS:ST', 'Totally Invented DJ']),
      source,
    )
    expect(kept.map((r) => r.artist)).toEqual(['Mochakk', 'KAS:ST'])
    expect(dropped[0]!.message).toContain('Totally Invented DJ')
  })

  it('matches through punctuation/case differences', () => {
    const source = 'CHRIS LAKE × DISCLOSURE\nBEN UFO'
    const { kept, dropped } = guardAgainstHallucination(
      rows(['Chris Lake x Disclosure', 'Ben UFO']),
      source,
    )
    expect(dropped).toEqual([])
    expect(kept).toHaveLength(2)
  })

  it('keeps pure-symbol names it cannot judge', () => {
    const { kept } = guardAgainstHallucination(rows(['✦✦✦']), 'nothing relevant')
    expect(kept).toHaveLength(1)
  })
})

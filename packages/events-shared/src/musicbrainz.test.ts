import { describe, it, expect } from 'vitest'
import {
  buildDisambiguationGuidedJson,
  buildDisambiguationPrompt,
  DisambiguationResultSchema,
  extractLinksFromUrlRels,
  parseMbSearch,
  pickTopGenre,
  validateDisambiguation,
  type DisambiguationEntry,
  type MbCandidate,
} from './musicbrainz.js'

const cand = (mbid: string, name: string, extra: Partial<MbCandidate> = {}): MbCandidate => ({
  mbid,
  name,
  disambiguation: null,
  score: 100,
  type: 'Person',
  tags: [],
  ...extra,
})

describe('parseMbSearch', () => {
  it('parses candidates and skips malformed entries', () => {
    const json = {
      created: '2026-01-01',
      artists: [
        {
          id: 'mb-1',
          name: 'Skrillex',
          score: 100,
          type: 'Person',
          disambiguation: 'US electronic producer',
          tags: [{ name: 'dubstep', count: 5 }, { name: '' }],
        },
        { id: 'mb-2', name: 'Skrillex Tribute' }, // minimal entry is fine
        { name: 'no id — malformed' },
        'not even an object',
      ],
    }
    const out = parseMbSearch(json, 5)
    expect(out).toHaveLength(2)
    expect(out[0]).toEqual({
      mbid: 'mb-1',
      name: 'Skrillex',
      disambiguation: 'US electronic producer',
      score: 100,
      type: 'Person',
      tags: ['dubstep'],
    })
    expect(out[1]!.score).toBe(0)
    expect(out[1]!.type).toBeNull()
  })

  it('respects the limit and tolerates junk input', () => {
    const artists = Array.from({ length: 10 }, (_, i) => ({ id: `mb-${i}`, name: `A${i}` }))
    expect(parseMbSearch({ artists }, 3)).toHaveLength(3)
    expect(parseMbSearch(null, 5)).toEqual([])
    expect(parseMbSearch({ error: 'rate limited' }, 5)).toEqual([])
  })
})

describe('extractLinksFromUrlRels', () => {
  it('maps each supported host onto its link field', () => {
    const json = {
      relations: [
        { type: 'streaming', url: { resource: 'https://open.spotify.com/artist/abc' } },
        { type: 'soundcloud', url: { resource: 'https://soundcloud.com/abc' } },
        { type: 'streaming', url: { resource: 'https://music.apple.com/us/artist/abc/1' } },
        { type: 'youtube', url: { resource: 'https://music.youtube.com/channel/xyz' } },
        { type: 'social network', url: { resource: 'https://www.instagram.com/abc/' } },
      ],
    }
    expect(extractLinksFromUrlRels(json)).toEqual({
      spotify: 'https://open.spotify.com/artist/abc',
      soundcloud: 'https://soundcloud.com/abc',
      appleMusic: 'https://music.apple.com/us/artist/abc/1',
      youtubeMusic: 'https://music.youtube.com/channel/xyz',
      instagram: 'https://www.instagram.com/abc/',
    })
  })

  it('keeps the first URL per field and ignores unknown or broken rels', () => {
    const json = {
      relations: [
        { type: 'streaming', url: { resource: 'https://open.spotify.com/artist/first' } },
        { type: 'streaming', url: { resource: 'https://open.spotify.com/artist/second' } },
        { type: 'official homepage', url: { resource: 'https://example.com' } },
        { type: 'wikidata', url: { resource: 'https://www.wikidata.org/wiki/Q1' } },
        { type: 'broken', url: { resource: 'not a url' } },
        { type: 'no url' },
      ],
    }
    const links = extractLinksFromUrlRels(json)
    expect(links.spotify).toBe('https://open.spotify.com/artist/first')
    expect(links.soundcloud).toBeNull()
  })

  it('returns all-null links for junk input', () => {
    expect(extractLinksFromUrlRels(undefined)).toEqual({
      spotify: null,
      soundcloud: null,
      appleMusic: null,
      youtubeMusic: null,
      instagram: null,
    })
  })
})

describe('pickTopGenre', () => {
  it('picks the highest-count genre', () => {
    const json = {
      genres: [
        { name: 'house', count: 3 },
        { name: 'techno', count: 9 },
        { name: 'electronic', count: 9 }, // tie → first max wins
      ],
    }
    expect(pickTopGenre(json)).toBe('techno')
  })

  it('falls back to tags when genres are absent, null when neither', () => {
    expect(pickTopGenre({ tags: [{ name: 'dnb', count: 2 }] })).toBe('dnb')
    expect(pickTopGenre({ genres: [], tags: [] })).toBeNull()
    expect(pickTopGenre('garbage')).toBeNull()
  })
})

describe('disambiguation prompt + guided_json', () => {
  const entries: DisambiguationEntry[] = [
    { name: 'Four Tet', candidates: [cand('mb-ft', 'Four Tet', { tags: ['electronica'] })] },
    {
      name: 'Peggy Gou',
      candidates: [cand('mb-pg', 'Peggy Gou'), cand('mb-pg2', 'Peggy Gou (tribute)')],
    },
  ]

  it('prompt lists every artist with its candidates verbatim', () => {
    const prompt = buildDisambiguationPrompt({ name: 'CRSSD' }, entries)
    expect(prompt).toContain('"CRSSD"')
    expect(prompt).toContain('Artist "Four Tet":')
    expect(prompt).toContain('mbid=mb-ft')
    expect(prompt).toContain('tags=electronica')
    expect(prompt).toContain('mbid=mb-pg2')
  })

  it('guided_json pins names to entries and mbids to candidates + none', () => {
    const schema = buildDisambiguationGuidedJson(entries) as {
      properties: {
        picks: {
          maxItems: number
          items: { properties: { name: { enum: string[] }; mbid: { enum: string[] } } }
        }
      }
    }
    expect(schema.properties.picks.maxItems).toBe(2)
    expect(schema.properties.picks.items.properties.name.enum).toEqual(['Four Tet', 'Peggy Gou'])
    expect(schema.properties.picks.items.properties.mbid.enum).toEqual([
      'mb-ft',
      'mb-pg',
      'mb-pg2',
      'none',
    ])
  })
})

describe('validateDisambiguation', () => {
  const entries: DisambiguationEntry[] = [
    { name: 'Four Tet', candidates: [cand('mb-ft', 'Four Tet')] },
    { name: 'Peggy Gou', candidates: [cand('mb-pg', 'Peggy Gou')] },
  ]

  it('keeps valid picks, honors none, drops invented/cross-artist mbids', () => {
    const result = DisambiguationResultSchema.parse({
      picks: [
        { name: 'Four Tet', mbid: 'mb-ft', confidence: 'high' },
        { name: 'Peggy Gou', mbid: 'mb-ft', confidence: 'high' }, // wrong artist's mbid
        { name: 'Unknown Act', mbid: 'mb-ft', confidence: 'low' }, // unknown name
      ],
    })
    const picks = validateDisambiguation(result, entries)
    expect(picks.get('four tet')).toEqual({ mbid: 'mb-ft', confidence: 'high' })
    expect(picks.has('peggy gou')).toBe(false)
    expect(picks.size).toBe(1)
  })

  it('none yields no pick; first pick per artist wins; case-insensitive names', () => {
    const result = DisambiguationResultSchema.parse({
      picks: [
        { name: 'PEGGY GOU', mbid: 'mb-pg', confidence: 'medium' },
        { name: 'Peggy Gou', mbid: 'none', confidence: 'high' },
        { name: 'Four Tet', mbid: 'none', confidence: 'low' },
      ],
    })
    const picks = validateDisambiguation(result, entries)
    expect(picks.get('peggy gou')).toEqual({ mbid: 'mb-pg', confidence: 'medium' })
    expect(picks.has('four tet')).toBe(false)
  })
})

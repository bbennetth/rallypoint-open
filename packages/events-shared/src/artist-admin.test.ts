import { describe, expect, it } from 'vitest'
import {
  pickProposedFields,
  pickStrictMatch,
} from './artist-admin.js'
import { EMPTY_ENRICHMENT_LINKS, type MbCandidate } from './musicbrainz.js'

function candidate(over: Partial<MbCandidate>): MbCandidate {
  return {
    mbid: 'mb-1',
    name: 'Skrillex',
    disambiguation: null,
    score: 100,
    type: 'Person',
    tags: [],
    ...over,
  }
}

describe('pickStrictMatch', () => {
  it('accepts an exact case-insensitive name match at score 100', () => {
    const best = pickStrictMatch('skrillex', [candidate({ name: 'Skrillex', score: 100 })])
    expect(best?.mbid).toBe('mb-1')
  })

  it('trims surrounding whitespace on both sides', () => {
    const best = pickStrictMatch(' Skrillex ', [candidate({ name: 'Skrillex ', score: 100 })])
    expect(best?.mbid).toBe('mb-1')
  })

  it('rejects when no candidate name matches', () => {
    expect(pickStrictMatch('Skrillex', [candidate({ name: 'Skrillex Tribute Band' })])).toBeNull()
  })

  it('rejects a name match below the score threshold', () => {
    expect(pickStrictMatch('Skrillex', [candidate({ score: 97 })])).toBeNull()
  })

  it('accepts at exactly the threshold', () => {
    expect(pickStrictMatch('Skrillex', [candidate({ score: 98 })])?.mbid).toBe('mb-1')
  })

  it('rejects when a second name-matching candidate scores within the gap', () => {
    const result = pickStrictMatch('Skrillex', [
      candidate({ mbid: 'mb-1', score: 100 }),
      candidate({ mbid: 'mb-2', score: 96 }),
    ])
    expect(result).toBeNull()
  })

  it('ignores non-name-matching runners-up', () => {
    const result = pickStrictMatch('Skrillex', [
      candidate({ mbid: 'mb-1', score: 100 }),
      candidate({ mbid: 'mb-2', name: 'Skrillex II', score: 99 }),
    ])
    expect(result?.mbid).toBe('mb-1')
  })

  it('accepts when the same-named runner-up is clearly worse', () => {
    const result = pickStrictMatch('Skrillex', [
      candidate({ mbid: 'mb-1', score: 100 }),
      candidate({ mbid: 'mb-2', score: 60 }),
    ])
    expect(result?.mbid).toBe('mb-1')
  })

  it('returns null for an empty or blank artist name', () => {
    expect(pickStrictMatch('  ', [candidate({ name: '  ' })])).toBeNull()
    expect(pickStrictMatch('Skrillex', [])).toBeNull()
  })
})

describe('pickProposedFields', () => {
  const empty = {
    genre: null,
    soundcloud: null,
    spotify: null,
    appleMusic: null,
    youtubeMusic: null,
    instagram: null,
  }

  it('fills every null field MB has a value for', () => {
    const out = pickProposedFields(
      empty,
      { ...EMPTY_ENRICHMENT_LINKS, spotify: 'https://open.spotify.com/artist/x' },
      'dubstep',
    )
    expect(out).toEqual({ genre: 'dubstep', spotify: 'https://open.spotify.com/artist/x' })
  })

  it('never proposes over an existing value', () => {
    const out = pickProposedFields(
      { ...empty, genre: 'house', spotify: 'existing' },
      { ...EMPTY_ENRICHMENT_LINKS, spotify: 'new', soundcloud: 'https://soundcloud.com/x' },
      'dubstep',
    )
    expect(out).toEqual({ soundcloud: 'https://soundcloud.com/x' })
  })

  it('returns an empty object when MB adds nothing', () => {
    expect(pickProposedFields(empty, EMPTY_ENRICHMENT_LINKS, null)).toEqual({})
  })
})

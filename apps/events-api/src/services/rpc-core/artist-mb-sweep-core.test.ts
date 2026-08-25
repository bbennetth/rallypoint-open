import { describe, expect, it } from 'vitest'
import { EMPTY_ENRICHMENT_LINKS, type EnrichmentLinks, type MbCandidate } from '@rallypoint/events-shared'
import { buildMemoryRepos } from '../../repos/memory.js'
import type { Repos } from '../../repos/types.js'
import type { MusicBrainzClient } from './musicbrainz-client.js'
import {
  applyArtistMbReview,
  bulkDecideArtistMbReviews,
  dismissArtistMbReview,
  runArtistMbReview,
  runArtistMbSweepBatch,
} from './artist-mb-sweep-core.js'

// Memory-fake tier for the MB catalog sweep. The MB client is scripted
// per test; repo semantics (pending-unique index, null-fill update) are
// the same fakes the D1 suite mirrors.

function candidate(over: Partial<MbCandidate>): MbCandidate {
  return {
    mbid: 'mb-1',
    name: 'Nova Act',
    disambiguation: null,
    score: 100,
    type: 'Person',
    tags: [],
    ...over,
  }
}

function fakeMb(script: {
  search?: (name: string) => MbCandidate[] | null
  lookup?: (mbid: string) => { links: EnrichmentLinks; genre: string | null } | null
}): MusicBrainzClient & { searches: string[]; lookups: string[] } {
  const calls = { searches: [] as string[], lookups: [] as string[] }
  return {
    ...calls,
    async search(name) {
      calls.searches.push(name)
      return script.search ? script.search(name) : [candidate({ name })]
    },
    async lookup(mbid) {
      calls.lookups.push(mbid)
      return script.lookup
        ? script.lookup(mbid)
        : { links: { ...EMPTY_ENRICHMENT_LINKS }, genre: null }
    },
  }
}

async function seedArtist(
  repos: Repos,
  id: string,
  name: string,
  over: Partial<{ genre: string; spotify: string; mbid: string }> = {},
) {
  return repos.artists.create({ id, name, ...over })
}

describe('runArtistMbReview', () => {
  it('auto-matches strictly, proposes null fills, and records the mbid', async () => {
    const repos = buildMemoryRepos()
    await seedArtist(repos, 'art_1', 'Nova Act')
    const mb = fakeMb({
      lookup: () => ({
        links: { ...EMPTY_ENRICHMENT_LINKS, spotify: 'https://open.spotify.com/artist/x' },
        genre: 'techno',
      }),
    })
    const res = await runArtistMbReview(repos, mb, 'art_1')
    expect(res.outcome).toBe('proposed')
    if (res.outcome !== 'proposed') return
    expect(res.review.matchKind).toBe('auto')
    expect(res.review.mbid).toBe('mb-1')
    expect(res.review.proposedFields).toEqual({
      genre: 'techno',
      spotify: 'https://open.spotify.com/artist/x',
    })
    // Catalog untouched until apply.
    expect((await repos.artists.findById('art_1'))?.genre).toBeNull()
  })

  it('uses the pinned mbid without searching', async () => {
    const repos = buildMemoryRepos()
    await seedArtist(repos, 'art_1', 'Nova Act', { mbid: 'mb-stored' })
    const mb = fakeMb({
      search: () => {
        throw new Error('search must not be called for pinned artists')
      },
      lookup: () => ({ links: { ...EMPTY_ENRICHMENT_LINKS }, genre: 'house' }),
    })
    const res = await runArtistMbReview(repos, mb, 'art_1')
    expect(res.outcome).toBe('proposed')
    if (res.outcome !== 'proposed') return
    expect(res.review.matchKind).toBe('stored')
    expect(res.review.mbid).toBe('mb-stored')
    expect(mb.lookups).toEqual(['mb-stored'])
  })

  it('skips ambiguous and no-candidate artists without lookup', async () => {
    const repos = buildMemoryRepos()
    await seedArtist(repos, 'art_1', 'Nova Act')
    await seedArtist(repos, 'art_2', 'Other Act')
    const ambiguous = fakeMb({
      search: () => [candidate({ mbid: 'a', score: 100 }), candidate({ mbid: 'b', score: 99 })],
    })
    expect((await runArtistMbReview(repos, ambiguous, 'art_1')).outcome).toBe('ambiguous')
    const empty = fakeMb({ search: () => [] })
    expect((await runArtistMbReview(repos, empty, 'art_2')).outcome).toBe('no_candidates')
    expect(ambiguous.lookups).toEqual([])
  })

  it('maps MB failures to mb_unavailable', async () => {
    const repos = buildMemoryRepos()
    await seedArtist(repos, 'art_1', 'Nova Act')
    await seedArtist(repos, 'art_2', 'Nova Act 2', { mbid: 'mb-x' })
    expect((await runArtistMbReview(repos, fakeMb({ search: () => null }), 'art_1')).outcome).toBe(
      'mb_unavailable',
    )
    expect((await runArtistMbReview(repos, fakeMb({ lookup: () => null }), 'art_2')).outcome).toBe(
      'mb_unavailable',
    )
  })

  it('is unchanged for a pinned artist with nothing fillable, but proposes an mbid-pin-only row for a fresh match', async () => {
    const repos = buildMemoryRepos()
    await seedArtist(repos, 'art_pinned', 'Pinned', { mbid: 'mb-p' })
    await seedArtist(repos, 'art_fresh', 'Fresh')
    const dry = fakeMb({ lookup: () => ({ links: { ...EMPTY_ENRICHMENT_LINKS }, genre: null }) })
    expect((await runArtistMbReview(repos, dry, 'art_pinned')).outcome).toBe('unchanged')
    const fresh = await runArtistMbReview(
      repos,
      fakeMb({
        search: (name) => [candidate({ name })],
        lookup: () => ({ links: { ...EMPTY_ENRICHMENT_LINKS }, genre: null }),
      }),
      'art_fresh',
    )
    expect(fresh.outcome).toBe('proposed')
    if (fresh.outcome !== 'proposed') return
    expect(fresh.review.proposedFields).toEqual({})
  })

  it('reports already_pending and not_found', async () => {
    const repos = buildMemoryRepos()
    await seedArtist(repos, 'art_1', 'Nova Act')
    const mb = fakeMb({
      lookup: () => ({ links: { ...EMPTY_ENRICHMENT_LINKS }, genre: 'techno' }),
    })
    expect((await runArtistMbReview(repos, mb, 'art_1')).outcome).toBe('proposed')
    expect((await runArtistMbReview(repos, mb, 'art_1')).outcome).toBe('already_pending')
    expect((await runArtistMbReview(repos, mb, 'art_missing')).outcome).toBe('not_found')
  })
})

describe('runArtistMbSweepBatch', () => {
  it('pages qualifying artists by cursor and signals exhaustion', async () => {
    const repos = buildMemoryRepos()
    for (const n of [1, 2, 3]) await seedArtist(repos, `art_${n}`, `Act ${n}`)
    const mb = fakeMb({
      lookup: () => ({ links: { ...EMPTY_ENRICHMENT_LINKS }, genre: 'techno' }),
    })
    const page1 = await runArtistMbSweepBatch(repos, mb, { limit: 2 })
    expect(page1).toMatchObject({ processed: 2, proposed: 2, nextCursor: 'art_2' })
    const page2 = await runArtistMbSweepBatch(repos, mb, { cursor: page1.nextCursor, limit: 2 })
    expect(page2).toMatchObject({ processed: 1, proposed: 1, nextCursor: null })
  })

  it('counts unchanged and skipped outcomes separately', async () => {
    const repos = buildMemoryRepos()
    await seedArtist(repos, 'art_1', 'Pinned Dry', { mbid: 'mb-p' }) // unchanged
    await seedArtist(repos, 'art_2', 'No Match') // skipped (no candidates)
    const mb = fakeMb({
      search: () => [],
      lookup: () => ({ links: { ...EMPTY_ENRICHMENT_LINKS }, genre: null }),
    })
    const res = await runArtistMbSweepBatch(repos, mb, { limit: 5 })
    expect(res).toMatchObject({ processed: 2, proposed: 0, unchanged: 1, skipped: 1, nextCursor: null })
  })
})

describe('applyArtistMbReview', () => {
  async function propose(repos: Repos, artistId: string) {
    const res = await runArtistMbReview(
      repos,
      fakeMb({
        lookup: () => ({
          links: { ...EMPTY_ENRICHMENT_LINKS, spotify: 'https://open.spotify.com/artist/x' },
          genre: 'techno',
        }),
      }),
      artistId,
    )
    if (res.outcome !== 'proposed') throw new Error(`expected proposed, got ${res.outcome}`)
    return res.review
  }

  it('fills null fields, pins the mbid, and marks applied', async () => {
    const repos = buildMemoryRepos()
    await seedArtist(repos, 'art_1', 'Nova Act')
    const review = await propose(repos, 'art_1')
    const res = await applyArtistMbReview(repos, review.id)
    expect(res.outcome).toBe('applied')
    const artist = await repos.artists.findById('art_1')
    expect(artist?.genre).toBe('techno')
    expect(artist?.spotify).toBe('https://open.spotify.com/artist/x')
    expect(artist?.mbid).toBe('mb-1')
  })

  it('never overwrites a field filled manually between propose and apply', async () => {
    const repos = buildMemoryRepos()
    await seedArtist(repos, 'art_1', 'Nova Act')
    const review = await propose(repos, 'art_1')
    await repos.artists.update('art_1', { genre: 'hand-curated' })
    const res = await applyArtistMbReview(repos, review.id)
    expect(res.outcome).toBe('applied')
    const artist = await repos.artists.findById('art_1')
    expect(artist?.genre).toBe('hand-curated')
    expect(artist?.spotify).toBe('https://open.spotify.com/artist/x')
  })

  it('is one-shot and handles stale ids', async () => {
    const repos = buildMemoryRepos()
    await seedArtist(repos, 'art_1', 'Nova Act')
    const review = await propose(repos, 'art_1')
    expect((await applyArtistMbReview(repos, review.id)).outcome).toBe('applied')
    expect((await applyArtistMbReview(repos, review.id)).outcome).toBe('not_pending')
    expect((await applyArtistMbReview(repos, 'amr_missing')).outcome).toBe('not_found')
  })
})

describe('dismiss + bulk decide', () => {
  it('dismisses pending only', async () => {
    const repos = buildMemoryRepos()
    await seedArtist(repos, 'art_1', 'Nova Act')
    const res = await runArtistMbReview(
      repos,
      fakeMb({ lookup: () => ({ links: { ...EMPTY_ENRICHMENT_LINKS }, genre: 'techno' }) }),
      'art_1',
    )
    if (res.outcome !== 'proposed') throw new Error('setup')
    const dismissed = await dismissArtistMbReview(repos, res.review.id)
    expect(dismissed).not.toBe('not_pending')
    expect(await dismissArtistMbReview(repos, res.review.id)).toBe('not_pending')
    expect(await dismissArtistMbReview(repos, 'amr_missing')).toBeNull()
    // Catalog untouched by dismiss.
    expect((await repos.artists.findById('art_1'))?.genre).toBeNull()
  })

  it('bulk apply records per-id outcomes without aborting on stale ids', async () => {
    const repos = buildMemoryRepos()
    await seedArtist(repos, 'art_1', 'Act One')
    await seedArtist(repos, 'art_2', 'Act Two')
    const mb = fakeMb({ lookup: () => ({ links: { ...EMPTY_ENRICHMENT_LINKS }, genre: 'g' }) })
    const r1 = await runArtistMbReview(repos, mb, 'art_1')
    const r2 = await runArtistMbReview(repos, mb, 'art_2')
    if (r1.outcome !== 'proposed' || r2.outcome !== 'proposed') throw new Error('setup')
    await dismissArtistMbReview(repos, r2.review.id)
    const result = await bulkDecideArtistMbReviews(
      repos,
      [r1.review.id, r2.review.id, 'amr_missing'],
      'apply',
    )
    expect(result.applied).toBe(1)
    expect(result.failed).toBe(2)
    expect(result.items).toEqual([
      { id: r1.review.id, outcome: 'applied' },
      { id: r2.review.id, outcome: 'not_pending' },
      { id: 'amr_missing', outcome: 'not_found' },
    ])
  })
})

import { env } from 'cloudflare:test'
import { describe, it, expect, beforeEach } from 'vitest'
import { UniqueConstraintError } from '@rallypoint/api-kit'
import { buildD1Repos, createDb } from './index.js'
import type { Repos } from '../types.js'

// D1 coverage for migration 0010: the artists.mbid column and the
// artist_mb_reviews proposal queue (partial unique pending index,
// atomic setReviewed transitions, JSON proposed_fields round-trip).

describe('events D1 artists repo — mbid + enrichment candidates', () => {
  let repos: Repos

  beforeEach(async () => {
    await env.DB.exec('DELETE FROM artists')
    repos = buildD1Repos(createDb(env.DB))
  })

  it('round-trips mbid through create/update', async () => {
    const created = await repos.artists.create({ id: 'art_mb1', name: 'Pinned Act', mbid: 'mb-x' })
    expect(created.mbid).toBe('mb-x')
    const cleared = await repos.artists.update('art_mb1', { mbid: null })
    expect(cleared?.mbid).toBeNull()
    const set = await repos.artists.update('art_mb1', { mbid: 'mb-y' })
    expect(set?.mbid).toBe('mb-y')
  })

  it('listPage orders by lower(name),id with tuple keyset + q filter', async () => {
    await repos.artists.create({ id: 'art_3', name: 'charli xcx' })
    await repos.artists.create({ id: 'art_1', name: 'Aphex Twin' })
    await repos.artists.create({ id: 'art_2', name: 'Bicep', mbid: 'mb-b' })
    const page1 = await repos.artists.listPage({ limit: 2 })
    expect(page1.items.map((a) => a.name)).toEqual(['Aphex Twin', 'Bicep'])
    expect(page1.items[1]!.mbid).toBe('mb-b')
    expect(page1.nextCursor).toEqual({ name: 'Bicep', id: 'art_2' })
    const page2 = await repos.artists.listPage({ cursor: page1.nextCursor, limit: 2 })
    expect(page2.items.map((a) => a.name)).toEqual(['charli xcx'])
    expect(page2.nextCursor).toBeNull()
    expect((await repos.artists.listPage({ q: 'PHEX', limit: 10 })).items.map((a) => a.id)).toEqual(
      ['art_1'],
    )
  })

  it('listEnrichmentCandidates pages under-enriched artists in id order', async () => {
    const full = {
      genre: 'g',
      soundcloud: 's',
      spotify: 'sp',
      appleMusic: 'am',
      youtubeMusic: 'ym',
      instagram: 'ig',
    }
    // a: missing a link → qualifies. b: fully enriched, no mbid → excluded.
    // c: fully enriched WITH mbid → excluded (null-fill sweep can add
    // nothing). d: empty → qualifies.
    await repos.artists.create({ id: 'art_a', name: 'A', ...full, instagram: null })
    await repos.artists.create({ id: 'art_b', name: 'B', ...full })
    await repos.artists.create({ id: 'art_c', name: 'C', ...full, mbid: 'mb-c' })
    await repos.artists.create({ id: 'art_d', name: 'D' })

    const page1 = await repos.artists.listEnrichmentCandidates({ limit: 1 })
    expect(page1.map((a) => a.id)).toEqual(['art_a'])
    const page2 = await repos.artists.listEnrichmentCandidates({ afterId: 'art_a', limit: 2 })
    expect(page2.map((a) => a.id)).toEqual(['art_d'])
  })
})

describe('events D1 artist_mb_reviews repo', () => {
  let repos: Repos

  beforeEach(async () => {
    await env.DB.exec('DELETE FROM artist_mb_reviews')
    repos = buildD1Repos(createDb(env.DB))
  })

  it('creates a pending row and round-trips proposed_fields JSON', async () => {
    const created = await repos.artistMbReviews.create({
      id: 'amr_1',
      artistId: 'art_1',
      mbid: 'mb-1',
      matchKind: 'auto',
      proposedFields: { genre: 'techno', spotify: 'https://open.spotify.com/artist/x' },
    })
    expect(created.status).toBe('pending')
    expect(created.proposedFields).toEqual({
      genre: 'techno',
      spotify: 'https://open.spotify.com/artist/x',
    })
    expect((await repos.artistMbReviews.getPendingByArtist('art_1'))?.id).toBe('amr_1')
  })

  it('enforces one pending review per artist (partial unique index)', async () => {
    await repos.artistMbReviews.create({
      id: 'amr_1',
      artistId: 'art_1',
      mbid: 'mb-1',
      matchKind: 'auto',
      proposedFields: {},
    })
    await expect(
      repos.artistMbReviews.create({
        id: 'amr_2',
        artistId: 'art_1',
        mbid: 'mb-1',
        matchKind: 'auto',
        proposedFields: {},
      }),
    ).rejects.toBeInstanceOf(UniqueConstraintError)

    // A decided row frees the slot for a fresh pending one.
    await repos.artistMbReviews.setReviewed('amr_1', 'dismissed')
    const again = await repos.artistMbReviews.create({
      id: 'amr_3',
      artistId: 'art_1',
      mbid: 'mb-1',
      matchKind: 'stored',
      proposedFields: {},
    })
    expect(again.matchKind).toBe('stored')
  })

  it('setReviewed flips pending only, once', async () => {
    await repos.artistMbReviews.create({
      id: 'amr_1',
      artistId: 'art_1',
      mbid: 'mb-1',
      matchKind: 'auto',
      proposedFields: {},
    })
    const applied = await repos.artistMbReviews.setReviewed('amr_1', 'applied')
    expect(applied?.status).toBe('applied')
    expect(applied?.reviewedAt).not.toBeNull()
    expect(await repos.artistMbReviews.setReviewed('amr_1', 'dismissed')).toBeNull()
    expect(await repos.artistMbReviews.setReviewed('amr_missing', 'applied')).toBeNull()
  })

  it('listByStatus filters and lists newest first', async () => {
    await repos.artistMbReviews.create({
      id: 'amr_1',
      artistId: 'art_1',
      mbid: 'mb-1',
      matchKind: 'auto',
      proposedFields: {},
    })
    await repos.artistMbReviews.create({
      id: 'amr_2',
      artistId: 'art_2',
      mbid: 'mb-2',
      matchKind: 'auto',
      proposedFields: {},
    })
    await repos.artistMbReviews.setReviewed('amr_1', 'applied')
    expect((await repos.artistMbReviews.listByStatus('pending')).map((r) => r.id)).toEqual([
      'amr_2',
    ])
    expect((await repos.artistMbReviews.listByStatus()).length).toBe(2)
  })
})

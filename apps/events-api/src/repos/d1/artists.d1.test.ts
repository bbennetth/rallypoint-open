import { env } from 'cloudflare:test'
import { describe, it, expect, beforeEach } from 'vitest'
import { buildD1Repos, createDb } from './index.js'
import type { Repos } from '../types.js'

// D1 coverage for the artists catalog's genre column (migration 0009) —
// create/update round-trips through the real schema, and the null-only
// semantics the enrichment apply path relies on (update({genre}) never
// touches link columns, and vice versa).

describe('events D1 artists repo — genre', () => {
  let repos: Repos

  beforeEach(async () => {
    await env.DB.exec('DELETE FROM artists')
    repos = buildD1Repos(createDb(env.DB))
  })

  it('creates with genre + links and round-trips them', async () => {
    const created = await repos.artists.create({
      id: 'art_genre1',
      name: 'Test Act',
      genre: 'techno',
      spotify: 'https://open.spotify.com/artist/x',
    })
    expect(created.genre).toBe('techno')
    expect(created.spotify).toBe('https://open.spotify.com/artist/x')
    const found = await repos.artists.findByName('test act')
    expect(found?.genre).toBe('techno')
  })

  it('defaults genre to null when omitted', async () => {
    const created = await repos.artists.create({ id: 'art_genre2', name: 'No Genre' })
    expect(created.genre).toBeNull()
    expect((await repos.artists.findById('art_genre2'))?.genre).toBeNull()
  })

  it('update sets genre without touching links, and clears with null', async () => {
    await repos.artists.create({
      id: 'art_genre3',
      name: 'Linked Act',
      soundcloud: 'https://soundcloud.com/linked',
    })
    const updated = await repos.artists.update('art_genre3', { genre: 'house' })
    expect(updated?.genre).toBe('house')
    expect(updated?.soundcloud).toBe('https://soundcloud.com/linked')

    const cleared = await repos.artists.update('art_genre3', { genre: null })
    expect(cleared?.genre).toBeNull()
    expect(cleared?.soundcloud).toBe('https://soundcloud.com/linked')

    // Link-only update leaves genre alone.
    await repos.artists.update('art_genre3', { genre: 'dnb' })
    const linkOnly = await repos.artists.update('art_genre3', {
      instagram: 'https://instagram.com/linked',
    })
    expect(linkOnly?.genre).toBe('dnb')
  })
})

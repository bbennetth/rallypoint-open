import { describe, expect, it } from 'vitest'
import { buildMemoryRepos } from '../../repos/memory.js'
import type { EventsRpcDeps } from './deps.js'
import { adminListArtistsCore, adminPatchArtistCore } from './artist-admin-core.js'

// Memory-fake tier for the admin artist table surface. Deps are stubbed
// to the minimum the cores read: repos + the ADMIN_USER_IDS env gate.

function makeDeps() {
  const repos = buildMemoryRepos()
  const deps = {
    repos,
    env: { ADMIN_USER_IDS: 'user_admin' },
    logger: { warn() {}, info() {}, error() {}, debug() {} },
  } as unknown as EventsRpcDeps
  return { repos, deps }
}

describe('adminListArtistsCore', () => {
  it('rejects non-admins', async () => {
    const { deps } = makeDeps()
    expect((await adminListArtistsCore('user_nope', {}, deps)).kind).toBe('forbidden')
  })

  it('pages alphabetically with a (name, id) keyset cursor and q filter', async () => {
    const { repos, deps } = makeDeps()
    await repos.artists.create({ id: 'art_3', name: 'charli xcx' })
    await repos.artists.create({ id: 'art_1', name: 'Aphex Twin' })
    await repos.artists.create({ id: 'art_2', name: 'Bicep', mbid: 'mb-b' })

    const page1 = await adminListArtistsCore('user_admin', { limit: 2 }, deps)
    if (page1.kind !== 'ok') throw new Error('forbidden')
    expect(page1.data.items.map((a) => a.name)).toEqual(['Aphex Twin', 'Bicep'])
    expect(page1.data.items[1]!.mbid).toBe('mb-b')
    expect(page1.data.nextCursor).toEqual({ name: 'Bicep', id: 'art_2' })

    const page2 = await adminListArtistsCore(
      'user_admin',
      { cursor: page1.data.nextCursor, limit: 2 },
      deps,
    )
    if (page2.kind !== 'ok') throw new Error('forbidden')
    expect(page2.data.items.map((a) => a.name)).toEqual(['charli xcx'])
    expect(page2.data.nextCursor).toBeNull()

    const filtered = await adminListArtistsCore('user_admin', { q: 'bice' }, deps)
    if (filtered.kind !== 'ok') throw new Error('forbidden')
    expect(filtered.data.items.map((a) => a.name)).toEqual(['Bicep'])
  })
})

describe('adminPatchArtistCore', () => {
  it('patches fields, clears with null, and round-trips the DTO', async () => {
    const { repos, deps } = makeDeps()
    await repos.artists.create({ id: 'art_1', name: 'Bicep', genre: 'electronic' })
    const res = await adminPatchArtistCore(
      'user_admin',
      'art_1',
      { genre: null, spotify: 'https://open.spotify.com/artist/x', mbid: 'mb-b' },
      deps,
    )
    if (res.kind !== 'ok') throw new Error(res.kind)
    expect(res.data.genre).toBeNull()
    expect(res.data.spotify).toBe('https://open.spotify.com/artist/x')
    expect(res.data.mbid).toBe('mb-b')
  })

  it('maps bad input, unknown id, and duplicate name', async () => {
    const { repos, deps } = makeDeps()
    await repos.artists.create({ id: 'art_1', name: 'Bicep' })
    await repos.artists.create({ id: 'art_2', name: 'Overmono' })

    expect((await adminPatchArtistCore('user_nope', 'art_1', {}, deps)).kind).toBe('forbidden')
    expect((await adminPatchArtistCore('user_admin', 'art_1', {}, deps)).kind).toBe('invalid')
    expect(
      (await adminPatchArtistCore('user_admin', 'art_1', { spotify: 'not-a-url' }, deps)).kind,
    ).toBe('invalid')
    expect(
      (await adminPatchArtistCore('user_admin', 'art_1', { unknown: 'x' }, deps)).kind,
    ).toBe('invalid')
    expect(
      (await adminPatchArtistCore('user_admin', 'art_missing', { genre: 'g' }, deps)).kind,
    ).toBe('not_found')
    const conflict = await adminPatchArtistCore('user_admin', 'art_1', { name: 'OVERMONO' }, deps)
    expect(conflict).toEqual({ kind: 'conflict', code: 'artist_name_taken' })
  })
})

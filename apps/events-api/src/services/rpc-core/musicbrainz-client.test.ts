import { describe, it, expect, vi } from 'vitest'
import { createMusicBrainzClient } from './musicbrainz-client.js'

// Unit tests for the MB HTTP client's request shaping + soft-fail
// behavior — response *parsing* is covered in events-shared's
// musicbrainz.test.ts; here the fetch is stubbed.

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

describe('createMusicBrainzClient', () => {
  it('search sends the MB User-Agent and a Lucene-escaped quoted query', async () => {
    const fetchImpl = vi.fn(async () => okJson({ artists: [{ id: 'mb-1', name: 'AC/DC' }] }))
    const client = createMusicBrainzClient({ fetchImpl: fetchImpl as never, minIntervalMs: 0 })
    const out = await client.search('AC/DC (live)')
    expect(out).toHaveLength(1)
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('https://musicbrainz.org/ws/2/artist?query=')
    expect(url).toContain('&fmt=json')
    expect(decodeURIComponent(url.split('query=')[1]!.split('&')[0]!)).toBe(
      'artist:"AC\\/DC \\(live\\)"',
    )
    expect((init.headers as Record<string, string>)['user-agent']).toContain('rallypoint-events')
  })

  it('lookup requests url-rels + genres and maps the response', async () => {
    const fetchImpl = vi.fn(async () =>
      okJson({
        relations: [{ type: 'streaming', url: { resource: 'https://open.spotify.com/artist/a' } }],
        genres: [{ name: 'techno', count: 4 }],
      }),
    )
    const client = createMusicBrainzClient({ fetchImpl: fetchImpl as never, minIntervalMs: 0 })
    const out = await client.lookup('mb-1')
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toContain(
      '/artist/mb-1?inc=url-rels+genres&fmt=json',
    )
    expect(out?.links.spotify).toBe('https://open.spotify.com/artist/a')
    expect(out?.genre).toBe('techno')
  })

  it('spaces consecutive requests by the throttle interval', async () => {
    const fetchImpl = vi.fn(async () => okJson({ artists: [] }))
    const client = createMusicBrainzClient({ fetchImpl: fetchImpl as never, minIntervalMs: 80 })
    const start = Date.now()
    await client.search('one')
    await client.search('two')
    expect(Date.now() - start).toBeGreaterThanOrEqual(75)
  })

  it('soft-fails to null on non-2xx, network error, and bad JSON', async () => {
    const rateLimited = createMusicBrainzClient({
      fetchImpl: (async () => new Response('slow down', { status: 503 })) as never,
      minIntervalMs: 0,
    })
    expect(await rateLimited.search('x')).toBeNull()
    expect(await rateLimited.lookup('mb-1')).toBeNull()

    const throwing = createMusicBrainzClient({
      fetchImpl: (async () => {
        throw new TypeError('network down')
      }) as never,
      minIntervalMs: 0,
    })
    expect(await throwing.search('x')).toBeNull()

    const badJson = createMusicBrainzClient({
      fetchImpl: (async () => new Response('<html>', { status: 200 })) as never,
      minIntervalMs: 0,
    })
    expect(await badJson.search('x')).toBeNull()
  })
})

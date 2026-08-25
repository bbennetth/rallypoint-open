import {
  MB_CANDIDATES_PER_ARTIST,
  parseMbSearch,
  extractLinksFromUrlRels,
  pickTopGenre,
  type EnrichmentLinks,
  type MbCandidate,
} from '@rallypoint/events-shared'

// Thin MusicBrainz web-service client for lineup-ingest enrichment.
// I/O only — all response parsing lives in events-shared/musicbrainz.ts.
// MB is keyless but requires a meaningful User-Agent and ~1 req/s; the
// instance throttle enforces the spacing (ingest calls it sequentially,
// so one client instance == one request lane). Failures never throw:
// search → null (distinct from [] = "no match"), lookup → null; the
// ingest core turns them into proposal warnings.

const MB_BASE = 'https://musicbrainz.org/ws/2'
const MB_USER_AGENT = 'rallypoint-events/1.0 (hello@byronhowell.me)'
const REQUEST_TIMEOUT_MS = 8_000
// MB's public rate limit is 1 req/s; a little headroom avoids 503s.
const MIN_INTERVAL_MS = 1_100

export interface MusicBrainzClient {
  /** Search artists by name. null = request failed, [] = no candidates. */
  search(name: string): Promise<MbCandidate[] | null>
  /** Fetch url-relationships + genres for one artist. null = failed. */
  lookup(mbid: string): Promise<{ links: EnrichmentLinks; genre: string | null } | null>
}

// Lucene special characters in the artist-name query — MB's search is
// Lucene-backed, so an unescaped name like "AC/DC (live)" breaks the
// query instead of matching it.
function escapeLucene(s: string): string {
  return s.replace(/[+\-!(){}[\]^"~*?:\\/&|]/g, (ch) => `\\${ch}`)
}

export function createMusicBrainzClient(opts?: {
  fetchImpl?: typeof fetch | undefined
  minIntervalMs?: number | undefined
}): MusicBrainzClient {
  const fetchImpl = opts?.fetchImpl ?? fetch
  const minInterval = opts?.minIntervalMs ?? MIN_INTERVAL_MS
  let lastRequestAt = 0

  const get = async (url: string): Promise<unknown | null> => {
    const wait = lastRequestAt + minInterval - Date.now()
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    lastRequestAt = Date.now()
    try {
      const res = await fetchImpl(url, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { 'user-agent': MB_USER_AGENT, accept: 'application/json' },
      })
      if (!res.ok) return null
      return await res.json()
    } catch {
      return null
    }
  }

  return {
    async search(name: string): Promise<MbCandidate[] | null> {
      const query = encodeURIComponent(`artist:"${escapeLucene(name)}"`)
      const json = await get(
        `${MB_BASE}/artist?query=${query}&limit=${MB_CANDIDATES_PER_ARTIST}&fmt=json`,
      )
      if (json === null) return null
      return parseMbSearch(json, MB_CANDIDATES_PER_ARTIST)
    },

    async lookup(mbid: string): Promise<{ links: EnrichmentLinks; genre: string | null } | null> {
      const json = await get(
        `${MB_BASE}/artist/${encodeURIComponent(mbid)}?inc=url-rels+genres&fmt=json`,
      )
      if (json === null) return null
      return { links: extractLinksFromUrlRels(json), genre: pickTopGenre(json) }
    },
  }
}

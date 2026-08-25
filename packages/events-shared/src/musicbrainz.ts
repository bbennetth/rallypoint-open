import { z } from 'zod'

// MusicBrainz artist enrichment: pure parsing/mapping between the MB
// web-service JSON and the ingest proposal's enrichment blocks, plus the
// AI disambiguation prompt/schema. Deterministic and unit-tested; the
// HTTP client and the model call live in events-api's ingest core (same
// split as lineup-ingest.ts).

export const MB_CANDIDATES_PER_ARTIST = 5

// --- search: candidates ---------------------------------------------

export interface MbCandidate {
  mbid: string
  name: string
  disambiguation: string | null
  // MB search relevance 0–100 (100 = exact match).
  score: number
  type: string | null
  tags: string[]
}

// Tolerant of MB's loose JSON — zod strips unknown keys, optional
// blocks may be absent, malformed entries are skipped rather than
// failing the whole response.
const MbSearchArtistSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  score: z.number().optional(),
  disambiguation: z.string().optional(),
  type: z.string().optional(),
  tags: z.array(z.object({ name: z.string() })).optional(),
})

const MbSearchResponseSchema = z.object({ artists: z.array(z.unknown()) })

/** Parse a MusicBrainz artist-search response into candidates, skipping
 * malformed entries. Returns [] for anything that isn't a search
 * response at all. */
export function parseMbSearch(json: unknown, limit: number = MB_CANDIDATES_PER_ARTIST): MbCandidate[] {
  const parsed = MbSearchResponseSchema.safeParse(json)
  if (!parsed.success) return []
  const out: MbCandidate[] = []
  for (const raw of parsed.data.artists) {
    if (out.length >= limit) break
    const a = MbSearchArtistSchema.safeParse(raw)
    if (!a.success) continue
    out.push({
      mbid: a.data.id,
      name: a.data.name,
      disambiguation: a.data.disambiguation || null,
      score: a.data.score ?? 0,
      type: a.data.type ?? null,
      tags: (a.data.tags ?? []).map((t) => t.name).filter((n) => n.length > 0),
    })
  }
  return out
}

// --- lookup: url-relations → link fields + genre --------------------

export interface EnrichmentLinks {
  spotify: string | null
  soundcloud: string | null
  appleMusic: string | null
  youtubeMusic: string | null
  instagram: string | null
}

export const EMPTY_ENRICHMENT_LINKS: EnrichmentLinks = {
  spotify: null,
  soundcloud: null,
  appleMusic: null,
  youtubeMusic: null,
  instagram: null,
}

const MbLookupResponseSchema = z.object({
  relations: z
    .array(
      z.object({
        type: z.string().optional(),
        url: z.object({ resource: z.string() }).optional(),
      }),
    )
    .optional(),
  genres: z.array(z.object({ name: z.string(), count: z.number().optional() })).optional(),
  tags: z.array(z.object({ name: z.string(), count: z.number().optional() })).optional(),
})

/** Map a url-rel resource onto one of the five catalog link fields by
 * hostname (the rel `type` is too loose to trust — MB files Spotify
 * under 'streaming'/'free streaming' and Instagram under 'social
 * network'). Returns null for hosts we don't catalog. */
function linkFieldForUrl(resource: string): keyof EnrichmentLinks | null {
  let host: string
  try {
    host = new URL(resource).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return null
  }
  if (host === 'open.spotify.com') return 'spotify'
  if (host === 'soundcloud.com') return 'soundcloud'
  if (host === 'music.apple.com' || host === 'itunes.apple.com') return 'appleMusic'
  if (host === 'music.youtube.com' || host === 'youtube.com') return 'youtubeMusic'
  if (host === 'instagram.com') return 'instagram'
  return null
}

/** Extract the five catalog links from an MB artist lookup
 * (`inc=url-rels`). First URL per field wins (MB occasionally carries
 * duplicates); anything unparseable is ignored. */
export function extractLinksFromUrlRels(json: unknown): EnrichmentLinks {
  const parsed = MbLookupResponseSchema.safeParse(json)
  const links: EnrichmentLinks = { ...EMPTY_ENRICHMENT_LINKS }
  if (!parsed.success) return links
  for (const rel of parsed.data.relations ?? []) {
    const resource = rel.url?.resource
    if (!resource) continue
    const field = linkFieldForUrl(resource)
    if (field && links[field] === null) links[field] = resource
  }
  return links
}

/** Highest-count genre from an MB lookup (`inc=genres`), falling back to
 * the highest-count tag when MB has no curated genre. Null when neither
 * exists. */
export function pickTopGenre(json: unknown): string | null {
  const parsed = MbLookupResponseSchema.safeParse(json)
  if (!parsed.success) return null
  const top = (rows: { name: string; count?: number | undefined }[] | undefined): string | null => {
    let best: { name: string; count: number } | null = null
    for (const r of rows ?? []) {
      const count = r.count ?? 0
      if (r.name && (!best || count > best.count)) best = { name: r.name, count }
    }
    return best ? best.name : null
  }
  return top(parsed.data.genres) ?? top(parsed.data.tags)
}

// --- AI disambiguation (one batched call) ---------------------------

export interface DisambiguationEntry {
  name: string
  candidates: MbCandidate[]
}

export type DisambiguationConfidence = 'high' | 'medium' | 'low'

export interface DisambiguationPick {
  mbid: string
  confidence: DisambiguationConfidence
}

/** System prompt for the batched pick-the-right-candidate call. The
 * model sees every unknown artist with its MB candidates and must
 * choose one MBID (or "none") per artist, using the event as context.
 * Names/MBIDs are echoed verbatim; validateDisambiguation is the real
 * guard against invented MBIDs. */
export function buildDisambiguationPrompt(
  event: { name: string },
  entries: DisambiguationEntry[],
): string {
  const blocks = entries
    .map((e) => {
      const cands = e.candidates
        .map((c) => {
          const parts = [
            `mbid=${c.mbid}`,
            `name=${JSON.stringify(c.name)}`,
            `score=${c.score}`,
          ]
          if (c.type) parts.push(`type=${c.type}`)
          if (c.disambiguation) parts.push(`note=${JSON.stringify(c.disambiguation)}`)
          if (c.tags.length > 0) parts.push(`tags=${c.tags.slice(0, 6).join(', ')}`)
          return `  - ${parts.join(' | ')}`
        })
        .join('\n')
      return `Artist ${JSON.stringify(e.name)}:\n${cands}`
    })
    .join('\n')
  return `You match festival lineup artists to MusicBrainz entries. The artists below perform at the music event "${event.name}". For each artist, pick the MusicBrainz candidate that is that performer, or "none" if no candidate is them.
Judge by name similarity, artist type, disambiguation notes, and tags (music genres fit a festival act; non-musicians usually do not). A slightly different spelling can still be the same act; a same-named non-musician is not.
Confidence: "high" = certain, "medium" = probably, "low" = plausible guess.
${blocks}
Reply with ONLY this JSON object (no prose, no markdown):
{"picks":[{"name":"<artist name exactly as listed>","mbid":"<candidate mbid or none>","confidence":"high" | "medium" | "low"}]}
Include every artist exactly once. Use only mbids listed for that artist.`
}

/** guided_json mirror — pins pick names to the entry list and mbids to
 * the union of candidate mbids + "none" (per-artist scoping is enforced
 * by validateDisambiguation, not the grammar). */
export function buildDisambiguationGuidedJson(entries: DisambiguationEntry[]): Record<string, unknown> {
  const names = entries.map((e) => e.name)
  const mbids = [...new Set(entries.flatMap((e) => e.candidates.map((c) => c.mbid)))]
  return {
    type: 'object',
    properties: {
      picks: {
        type: 'array',
        maxItems: entries.length,
        items: {
          type: 'object',
          properties: {
            name: names.length > 0 ? { type: 'string', enum: names } : { type: 'string' },
            mbid: { type: 'string', enum: [...mbids, 'none'] },
            confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          },
          required: ['name', 'mbid', 'confidence'],
        },
      },
    },
    required: ['picks'],
  }
}

export const DisambiguationResultSchema = z.object({
  picks: z
    .array(
      z.object({
        name: z.string(),
        mbid: z.string(),
        confidence: z.enum(['high', 'medium', 'low']),
      }),
    )
    .max(500),
})

export type DisambiguationResult = z.infer<typeof DisambiguationResultSchema>

/** Validate the model's picks against the entries: a pick counts only if
 * its mbid is one of THAT artist's candidates ("none" and unknown names
 * are dropped; first pick per artist wins). Same philosophy as the
 * extraction hallucination guard — the grammar narrows, this verifies. */
export function validateDisambiguation(
  result: DisambiguationResult,
  entries: DisambiguationEntry[],
): Map<string, DisambiguationPick> {
  const candidatesByName = new Map<string, Set<string>>(
    entries.map((e) => [e.name.toLowerCase(), new Set(e.candidates.map((c) => c.mbid))]),
  )
  const picks = new Map<string, DisambiguationPick>()
  for (const p of result.picks) {
    const key = p.name.toLowerCase()
    if (picks.has(key)) continue
    if (p.mbid === 'none') continue
    const allowed = candidatesByName.get(key)
    if (!allowed || !allowed.has(p.mbid)) continue
    picks.set(key, { mbid: p.mbid, confidence: p.confidence })
  }
  return picks
}

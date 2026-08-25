import { ulid } from 'ulid'
import { z } from 'zod'
import {
  ExtractedLineupSchema,
  buildDisambiguationGuidedJson,
  buildDisambiguationPrompt,
  buildLineupGuidedJson,
  DisambiguationResultSchema,
  guardAgainstHallucination,
  htmlToText,
  normalizeExtractedLineup,
  planLineupChanges,
  validateDisambiguation,
  type DisambiguationConfidence,
  type DisambiguationEntry,
  type EnrichmentLinks,
  type LineupChangePlan,
  type LineupChangeRowInput,
} from '@rallypoint/events-shared'
import { runAiJson, type AiRunResult, type AiRunner, type AiTracesRpc, type AiWarnLogger } from '@rallypoint/ai'
import { UniqueConstraintError } from '@rallypoint/api-kit'
import type {
  EventArtistRecord,
  EventRecord,
  LineupIngestionRecord,
  Repos,
} from '../../repos/types.js'
import { captureSnapshot } from '../../routes/_snapshots.js'
import {
  isAdmin,
  loadSystemEvent,
  publishUpdate,
  recordAdminActivity,
  type AdminConflict,
  type AdminForbidden,
  type AdminInvalid,
  type AdminNotFound,
  type AdminOk,
} from './admin-events-core.js'
import type { EventsRpcDeps } from './deps.js'
import type { MusicBrainzClient } from './musicbrainz-client.js'

// AI lineup ingestion for system-owned festivals: fetch (or take pasted)
// lineup-page text, extract artists with Workers AI, diff against the
// event's current lineup with the shared planner, and persist the result
// as a PENDING lineup_ingestions proposal. Nothing mutates the lineup
// until an admin approves — apply then goes through the same artist
// find-or-create + event_artists bulkApply path the lineup editor uses.

// Same model policy as fitness's vision passes (vision-chat.ts): Mistral
// Small 3.1 — Apache-2.0, ungated on Workers AI; Meta/Llama models are
// off the table (license gate).
export const LINEUP_INGEST_MODEL = '@cf/mistralai/mistral-small-3.1-24b-instruct'

export const LINEUP_INGEST_FEATURE = 'lineup-ingest'
export const LINEUP_ENRICH_FEATURE = 'lineup-enrich'

// Enrichment budget: MusicBrainz allows ~1 req/s, and the whole pipeline
// runs inline in the ingest RPC — 30 unknown artists is ~30 searches +
// up to 30 lookups ≈ a minute of wall clock, the accepted worst case.
// Unknowns beyond the cap are skipped with a warning.
export const ENRICHMENT_MAX_ARTISTS = 30

// Source-text budget for one extraction call. CRSSD-scale artist pages
// land well under this; a page that blows past it is truncated with a
// warning on the proposal (chunked multi-call extraction is a known
// follow-up, not v1).
export const MAX_SOURCE_CHARS = 24_000

const FETCH_TIMEOUT_MS = 15_000
// Raw-body cap ahead of htmlToText — a festival page is a few hundred KB
// at worst; anything bigger is not a lineup page.
const MAX_FETCH_BYTES = 4_000_000
const MAX_PASTED_CHARS = 500_000
const EXTRACTION_MAX_TOKENS = 6_000

const IngestLineupSchema = z
  .object({
    sourceUrl: z
      .string()
      .trim()
      .url('Source must be a valid URL.')
      .max(2000)
      .refine((u) => u.startsWith('https://') || u.startsWith('http://'), 'Source must be http(s).')
      .optional(),
    pastedText: z.string().min(1).max(MAX_PASTED_CHARS).optional(),
    replace: z.boolean().optional(),
  })
  .superRefine((v, ctx) => {
    if (!v.sourceUrl && !v.pastedText) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [],
        message: 'Provide a source URL or pasted text.',
      })
    }
  })

// Per-artist catalog/enrichment info attached to the proposal. `name`
// joins back to plan rows case-insensitively. `matched` = the artist
// already exists in the global catalog; `enrichment` = MusicBrainz
// lookup (AI-disambiguated) for an unknown artist — approve persists it
// onto the created row. Neither present = unknown artist, no MB match.
export interface ProposalArtistInfo {
  name: string
  matched?: {
    artistId: string
    genre: string | null
    links: EnrichmentLinks
  }
  enrichment?: {
    mbid: string
    confidence: DisambiguationConfidence
    genre: string | null
    links: EnrichmentLinks
  }
}

export interface LineupIngestionProposal {
  // The diff the admin reviews (and the one re-checked at approve time).
  plan: LineupChangePlan
  // The normalized planner inputs — kept so approve can re-plan against
  // the event's CURRENT days/stages/lineup and detect staleness.
  inputRows: LineupChangeRowInput[]
  // Extraction-level problems: day-less artists, hallucination drops,
  // enrichment failures (line 0 = not tied to an extraction row).
  warnings: { line: number; message: string }[]
  truncated: boolean
  replace: boolean
  // Optional (additive): proposals stored before enrichment shipped
  // lack it, and approve must keep working for them. Deliberately NOT
  // part of the approve-time staleness key — catalog/MB drift must not
  // invalidate a reviewed lineup diff.
  artists?: ProposalArtistInfo[]
}

export interface LineupIngestionDto {
  id: string
  event_id: string
  source_kind: 'url' | 'pasted'
  source_url: string | null
  source_excerpt: string
  model: string
  status: string
  error: string | null
  proposal: LineupIngestionProposal | null
  created_by: string
  reviewed_by: string | null
  created_at: string
  reviewed_at: string | null
}

export type AdminIngestFailed = {
  kind: 'failed'
  code: 'fetch_failed' | 'ai_invalid'
  data: LineupIngestionDto
}

export interface LineupIngestApplied {
  upserted: number
  deleted: number
  artistsCreated: number
  // Existing catalog rows whose null link/genre fields were backfilled
  // from proposal enrichment at approve time.
  artistsEnriched: number
}

/** Runtime context for the extraction model call — same shape as
 * fitness's AiReviewRunOpts. All parts optional so D1 tests and dev
 * deployments without AI_TRACES keep working. */
export interface LineupIngestRunOpts {
  gatewayId?: string | undefined
  logger?: AiWarnLogger | undefined
  trace?:
    | {
        aiRpc: AiTracesRpc | undefined
        waitUntil: (p: Promise<unknown>) => void
        userId: string
      }
    | undefined
  // MusicBrainz client for unknown-artist enrichment. Absent (D1 tests,
  // harnesses that don't wire it) → enrichment is silently skipped;
  // catalog matching still runs.
  musicbrainz?: MusicBrainzClient | undefined
}

function isProposal(v: unknown): v is LineupIngestionProposal {
  return typeof v === 'object' && v !== null && 'plan' in v && 'inputRows' in v
}

/** Tolerant reader for the additive `artists` proposal field — legacy
 * proposals (stored before enrichment shipped) simply yield []. */
function proposalArtistInfo(p: LineupIngestionProposal): ProposalArtistInfo[] {
  return Array.isArray(p.artists) ? p.artists : []
}

export function serializeLineupIngestion(r: LineupIngestionRecord): LineupIngestionDto {
  return {
    id: r.id,
    event_id: r.eventId,
    source_kind: r.sourceKind,
    source_url: r.sourceUrl,
    source_excerpt: r.sourceExcerpt,
    model: r.model,
    status: r.status,
    error: r.error,
    proposal: isProposal(r.proposal) ? r.proposal : null,
    created_by: r.createdBy,
    reviewed_by: r.reviewedBy,
    created_at: r.createdAt.toISOString(),
    reviewed_at: r.reviewedAt ? r.reviewedAt.toISOString() : null,
  }
}

export function buildExtractionSystemPrompt(
  event: EventRecord,
  days: { day_label: string; date: string }[],
  stages: { name: string }[],
): string {
  const dayLines =
    days.length > 0
      ? `Allowed day values (use the quoted label exactly; omit the day when the text does not state one):\n${days
          .map((d) => `- "${d.day_label}" (${d.date})`)
          .join('\n')}`
      : 'The event has no day schedule yet — omit the day field for every artist.'
  const stageLines =
    stages.length > 0 ? stages.map((s) => `- "${s.name}"`).join('\n') : '(none defined yet)'
  return `You extract festival lineups from web-page text for the event "${event.name}".
Return every performing artist you find. For each artist include the day, stage, set times, and billing tier ONLY when the text states them — never guess or invent values. An artist without a stated day is fine — just omit the day.
${dayLines}
Allowed stage values (use the quoted name exactly; omit the stage if it is not one of these):
${stageLines}
Allowed tier values: headliner, support, opener. Omit tier unless the billing clearly implies it.
Times are 24-hour HH:MM. Artist names must be copied character-for-character from the text — do not add artists that are not in the text, do not expand abbreviations, do not translate.
Reply with ONLY this JSON object (no prose, no markdown):
{"artists":[{"name":"<artist>","day":"<allowed day label>","stage":"<allowed stage>","tier":"headliner" | "support" | "opener","genre":"<genre>","start":"HH:MM","end":"HH:MM"}]}
Every field except "name" is optional — omit unknown fields entirely.`
}

// Fetch the source page. SSRF posture, documented: the caller is an
// allowlisted admin (double-checked here AND in admin-api), the URL is
// scheme-restricted to http(s), and a Workers `fetch` has no private
// network to reach — internal services are service bindings, not URLs —
// so no resolver-level IP blocklist is attempted. Redirects follow
// (festival sites love www/apex hops); the size cap below bounds what a
// hostile or misconfigured target can make us buffer.
async function fetchSourceText(url: string): Promise<
  { ok: true; body: string } | { ok: false; error: string }
> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5' },
    })
    if (!res.ok) return { ok: false, error: `Source responded ${res.status}.` }
    // Reject oversized bodies BEFORE buffering them: trust Content-Length
    // when present, otherwise stream with a running cap and bail the
    // moment it's crossed.
    const declared = Number(res.headers.get('content-length') ?? '')
    if (Number.isFinite(declared) && declared > MAX_FETCH_BYTES) {
      await res.body?.cancel()
      return { ok: false, error: `Source page too large (${declared} bytes).` }
    }
    if (!res.body) return { ok: true, body: await res.text() }
    const reader = res.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_FETCH_BYTES) {
        await reader.cancel()
        return { ok: false, error: `Source page too large (>${MAX_FETCH_BYTES} bytes).` }
      }
      chunks.push(value)
    }
    const joined = new Uint8Array(total)
    let offset = 0
    for (const c of chunks) {
      joined.set(c, offset)
      offset += c.byteLength
    }
    return { ok: true, body: new TextDecoder().decode(joined) }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, error: `Fetch failed: ${msg.slice(0, 300)}` }
  }
}

// Resolve catalog names for the event's current slots so the planner can
// key them by artist name (same dedupe slotArtistMeta does in routes).
async function currentSlotsWithNames(
  repos: Repos,
  eventId: string,
): Promise<{ artist_id: string; artist_name: string | null; display_name: string | null; day_id: string | null }[]> {
  const slots = await repos.eventArtists.listForEvent(eventId)
  const ids = [...new Set(slots.map((s) => s.artistId))]
  const names = new Map<string, string>()
  await Promise.all(
    ids.map(async (id) => {
      const a = await repos.artists.findById(id)
      if (a) names.set(id, a.name)
    }),
  )
  return slots.map((s) => ({
    artist_id: s.artistId,
    artist_name: names.get(s.artistId) ?? null,
    display_name: s.displayName,
    day_id: s.dayId,
  }))
}

async function planAgainstCurrent(
  repos: Repos,
  eventId: string,
  inputRows: LineupChangeRowInput[],
  replace: boolean,
): Promise<LineupChangePlan> {
  const [days, stages, currentSlots] = await Promise.all([
    repos.days.listForEvent(eventId),
    repos.stages.listForEvent(eventId),
    currentSlotsWithNames(repos, eventId),
  ])
  return planLineupChanges({
    rows: inputRows,
    days: days.map((d) => ({ id: d.id, day_label: d.dayLabel, date: d.date })),
    stages: stages.map((s) => ({ id: s.id, name: s.name })),
    currentSlots,
    replace,
  })
}

// Catalog-match every extracted artist and enrich the unknowns via
// MusicBrainz + one batched AI disambiguation call. Purely additive to
// the proposal: every failure path degrades to a warning (line 0 — not
// tied to an extraction row) and the proposal is produced regardless.
async function buildProposalArtistInfos(
  repos: Repos,
  event: EventRecord,
  rows: LineupChangeRowInput[],
  ai: AiRunner<AiRunResult>,
  opts: LineupIngestRunOpts | undefined,
): Promise<{ artists: ProposalArtistInfo[]; warnings: { line: number; message: string }[] }> {
  const warnings: { line: number; message: string }[] = []
  const warn = (message: string) => warnings.push({ line: 0, message })

  // Unique names, first-occurrence order (rows may repeat an artist
  // across days).
  const names: string[] = []
  const seen = new Set<string>()
  for (const r of rows) {
    const key = r.artist.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    names.push(r.artist)
  }

  const infoByKey = new Map<string, ProposalArtistInfo>()
  const unknowns: string[] = []
  for (const name of names) {
    const existing = await repos.artists.findByName(name)
    if (existing) {
      infoByKey.set(name.toLowerCase(), {
        name,
        matched: {
          artistId: existing.id,
          genre: existing.genre,
          links: {
            spotify: existing.spotify,
            soundcloud: existing.soundcloud,
            appleMusic: existing.appleMusic,
            youtubeMusic: existing.youtubeMusic,
            instagram: existing.instagram,
          },
        },
      })
    } else {
      infoByKey.set(name.toLowerCase(), { name })
      unknowns.push(name)
    }
  }

  // No client (D1 tests, unwired harnesses) → catalog matching only;
  // production wiring (rpc.ts ingestRunOpts) always provides one.
  const mb = opts?.musicbrainz
  if (mb && unknowns.length > 0) {
    const skipped = unknowns.slice(ENRICHMENT_MAX_ARTISTS)
    if (skipped.length > 0) {
      warn(
        `Artist enrichment skipped for ${skipped.length} artist(s) beyond the ` +
          `${ENRICHMENT_MAX_ARTISTS}-artist cap: ${skipped.join(', ')}`,
      )
    }

    // Phase A — sequential MB searches (the client throttles to ~1/s).
    const entries: DisambiguationEntry[] = []
    for (const name of unknowns.slice(0, ENRICHMENT_MAX_ARTISTS)) {
      const candidates = await mb.search(name)
      if (candidates === null) {
        warn(`MusicBrainz search failed for "${name}".`)
      } else if (candidates.length === 0) {
        warn(`No MusicBrainz match found for "${name}".`)
      } else {
        entries.push({ name, candidates })
      }
    }

    if (entries.length > 0) {
      // Phase B — one batched disambiguation call.
      const run = await runAiJson(
        ai,
        LINEUP_INGEST_MODEL,
        {
          messages: [{ role: 'system', content: buildDisambiguationPrompt(event, entries) }],
          max_tokens: EXTRACTION_MAX_TOKENS,
          guided_json: buildDisambiguationGuidedJson(entries),
        },
        {
          gatewayId: opts?.gatewayId,
          logger: opts?.logger,
          ...(opts?.trace
            ? {
                trace: {
                  aiRpc: opts.trace.aiRpc,
                  waitUntil: opts.trace.waitUntil,
                  userId: opts.trace.userId,
                  app: 'events',
                  feature: LINEUP_ENRICH_FEATURE,
                  // Artist names + MusicBrainz catalog data only.
                  contentOptOut: false,
                },
              }
            : {}),
        },
      )
      const parsed = run.ok ? DisambiguationResultSchema.safeParse(run.object) : null
      if (!parsed?.success) {
        warn('Artist enrichment unavailable (AI disambiguation failed) — proposal created without it.')
      } else {
        // Phase C — lookups for the validated picks.
        const picks = validateDisambiguation(parsed.data, entries)
        for (const entry of entries) {
          const pick = picks.get(entry.name.toLowerCase())
          if (!pick) continue
          const detail = await mb.lookup(pick.mbid)
          if (detail === null) {
            warn(`MusicBrainz lookup failed for "${entry.name}".`)
            continue
          }
          const info = infoByKey.get(entry.name.toLowerCase())
          if (info) {
            info.enrichment = {
              mbid: pick.mbid,
              confidence: pick.confidence,
              genre: detail.genre,
              links: detail.links,
            }
          }
        }
      }
    }
  }

  return { artists: names.map((n) => infoByKey.get(n.toLowerCase())!), warnings }
}

export type AdminIngestLineupResult =
  | AdminOk<LineupIngestionDto>
  | AdminForbidden
  | AdminNotFound
  | AdminInvalid
  | AdminConflict
  | AdminIngestFailed

export async function adminIngestLineupCore(
  actor: string,
  eventId: string,
  input: unknown,
  deps: EventsRpcDeps,
  ai: AiRunner<AiRunResult> | undefined,
  opts?: LineupIngestRunOpts,
): Promise<AdminIngestLineupResult> {
  if (!isAdmin(actor, deps)) return { kind: 'forbidden' }
  const event = await loadSystemEvent(eventId, deps)
  if (!event || event.deletedAt) return { kind: 'not_found' }
  const parsed = IngestLineupSchema.safeParse(input)
  if (!parsed.success) {
    return {
      kind: 'invalid',
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    }
  }
  if (!ai) return { kind: 'conflict', code: 'ai_unavailable' }

  // Zero days is fine now: day-less artists land as unscheduled (TBA)
  // slots, so a festival can ingest its lineup before any schedule
  // exists at all.
  const days = await deps.repos.days.listForEvent(event.id)
  const stages = await deps.repos.stages.listForEvent(event.id)

  const body = parsed.data
  const sourceKind: 'url' | 'pasted' = body.pastedText ? 'pasted' : 'url'
  const replace = body.replace ?? false

  // Persist a lineup_ingestions row for every path below — failures land
  // as terminal 'failed' rows so the review surface shows what happened.
  // Deliberately NO supersede here: a failed re-ingest (fetch timeout,
  // unusable AI output) must not discard a good pending proposal — the
  // partial unique index only guards 'pending', so a failed row can
  // coexist with it.
  const insertFailed = async (error: string): Promise<LineupIngestionDto> => {
    const row = await deps.repos.lineupIngestions.create({
      id: `lin_${ulid()}`,
      eventId: event.id,
      sourceKind,
      sourceUrl: body.sourceUrl ?? null,
      sourceExcerpt: '',
      model: LINEUP_INGEST_MODEL,
      extracted: null,
      proposal: null,
      status: 'failed',
      error,
      createdBy: actor,
    })
    return serializeLineupIngestion(row)
  }

  let raw: string
  if (body.pastedText) {
    raw = body.pastedText
  } else {
    const fetched = await fetchSourceText(body.sourceUrl!)
    if (!fetched.ok) {
      return { kind: 'failed', code: 'fetch_failed', data: await insertFailed(fetched.error) }
    }
    raw = fetched.body
  }

  const { text: sourceText, truncated } = htmlToText(raw, MAX_SOURCE_CHARS)
  if (sourceText.length === 0) {
    return {
      kind: 'failed',
      code: 'fetch_failed',
      data: await insertFailed('Source contained no readable text.'),
    }
  }

  const systemPrompt = buildExtractionSystemPrompt(
    event,
    days.map((d) => ({ day_label: d.dayLabel, date: d.date })),
    stages.map((s) => ({ name: s.name })),
  )
  const run = await runAiJson(
    ai,
    LINEUP_INGEST_MODEL,
    {
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: sourceText },
      ],
      max_tokens: EXTRACTION_MAX_TOKENS,
      guided_json: buildLineupGuidedJson(
        days.map((d) => d.dayLabel),
        stages.map((s) => s.name),
      ),
    },
    {
      gatewayId: opts?.gatewayId,
      logger: opts?.logger,
      ...(opts?.trace
        ? {
            trace: {
              aiRpc: opts.trace.aiRpc,
              waitUntil: opts.trace.waitUntil,
              userId: opts.trace.userId,
              app: 'events',
              feature: LINEUP_INGEST_FEATURE,
              // Public festival-page text + catalog data, never user
              // content — keep the raw response in ai_traces for QA.
              contentOptOut: false,
            },
          }
        : {}),
    },
  )
  if (!run.ok) {
    // runAiJson already warn-logged shape diagnostics.
    return {
      kind: 'failed',
      code: 'ai_invalid',
      data: await insertFailed(`AI response unusable (${run.failure}).`),
    }
  }

  const extracted = ExtractedLineupSchema.safeParse(run.object)
  if (!extracted.success) {
    return {
      kind: 'failed',
      code: 'ai_invalid',
      data: await insertFailed('AI response did not match the extraction schema.'),
    }
  }

  const normalized = normalizeExtractedLineup(extracted.data)
  const guarded = guardAgainstHallucination(normalized.rows, sourceText)
  const plan = await planAgainstCurrent(deps.repos, event.id, guarded.kept, replace)
  const enriched = await buildProposalArtistInfos(deps.repos, event, guarded.kept, ai, opts)

  const proposal: LineupIngestionProposal = {
    plan,
    inputRows: guarded.kept,
    warnings: [...normalized.errors, ...guarded.dropped, ...enriched.warnings],
    truncated,
    replace,
    artists: enriched.artists,
  }

  await deps.repos.lineupIngestions.markSuperseded(event.id, actor)
  const row = await deps.repos.lineupIngestions.create({
    id: `lin_${ulid()}`,
    eventId: event.id,
    sourceKind,
    sourceUrl: body.sourceUrl ?? null,
    sourceExcerpt: sourceText,
    model: LINEUP_INGEST_MODEL,
    extracted: extracted.data,
    proposal,
    ...(run.responseId !== undefined ? { aiResponseId: run.responseId } : {}),
    createdBy: actor,
  })
  await recordAdminActivity(deps, event.id, actor, 'event.lineup_ingestion_created', {
    ingestion_id: row.id,
    source_kind: sourceKind,
    create: plan.summary.create,
    update: plan.summary.update,
    delete: plan.summary.delete,
    error: plan.summary.error,
  })
  return { kind: 'ok', data: serializeLineupIngestion(row) }
}

export async function adminListLineupIngestionsCore(
  actor: string,
  eventId: string,
  opts: { status?: string | undefined },
  deps: EventsRpcDeps,
): Promise<AdminOk<LineupIngestionDto[]> | AdminForbidden | AdminNotFound> {
  if (!isAdmin(actor, deps)) return { kind: 'forbidden' }
  const event = await loadSystemEvent(eventId, deps)
  if (!event) return { kind: 'not_found' }
  const status =
    opts.status === 'pending' ||
    opts.status === 'approved' ||
    opts.status === 'rejected' ||
    opts.status === 'superseded' ||
    opts.status === 'failed'
      ? opts.status
      : undefined
  const rows = await deps.repos.lineupIngestions.listForEvent(event.id, { status })
  return { kind: 'ok', data: rows.map(serializeLineupIngestion) }
}

export async function adminGetLineupIngestionCore(
  actor: string,
  ingestionId: string,
  deps: EventsRpcDeps,
): Promise<AdminOk<LineupIngestionDto> | AdminForbidden | AdminNotFound> {
  if (!isAdmin(actor, deps)) return { kind: 'forbidden' }
  const row = await deps.repos.lineupIngestions.findById(ingestionId)
  if (!row) return { kind: 'not_found' }
  return { kind: 'ok', data: serializeLineupIngestion(row) }
}

export type AdminApproveLineupIngestionResult =
  | AdminOk<{ ingestion: LineupIngestionDto; applied: LineupIngestApplied }>
  | AdminForbidden
  | AdminNotFound
  | AdminConflict

export async function adminApproveLineupIngestionCore(
  actor: string,
  ingestionId: string,
  deps: EventsRpcDeps,
): Promise<AdminApproveLineupIngestionResult> {
  if (!isAdmin(actor, deps)) return { kind: 'forbidden' }
  const row = await deps.repos.lineupIngestions.findById(ingestionId)
  if (!row) return { kind: 'not_found' }
  const event = await loadSystemEvent(row.eventId, deps)
  if (!event || event.deletedAt) return { kind: 'not_found' }
  if (row.status !== 'pending') return { kind: 'conflict', code: 'not_pending' }
  const proposal = isProposal(row.proposal) ? row.proposal : null
  if (!proposal) return { kind: 'conflict', code: 'proposal_missing' }

  // Stale guard: re-plan the stored inputs against the event's CURRENT
  // days/stages/lineup. If the fresh plan no longer matches what the
  // admin reviewed (days renamed, stages deleted, lineup edited since
  // ingest), refuse — re-ingest to get a truthful diff. The key projects
  // ONLY the fields that drive apply (never presentational ones like
  // stageName/dayLabel), so adding a display field to PlannedLineupRow
  // can't spuriously invalidate proposals persisted under the old shape.
  const fresh = await planAgainstCurrent(deps.repos, event.id, proposal.inputRows, proposal.replace)
  const key = (p: LineupChangePlan) =>
    JSON.stringify({
      rows: p.rows.map((r) => ({
        action: r.action,
        artistName: r.artistName,
        artistId: r.artistId,
        dayId: r.dayId,
        stageId: r.stageId,
        tier: r.tier,
        genre: r.genre,
        startTime: r.startTime,
        endTime: r.endTime,
        displayName: r.displayName,
      })),
      // Same projection principle: deletes drop the presentational
      // `label`; errors compare by line (wording tweaks across deploys
      // must not read as staleness — a changed error SET still does).
      deletes: p.deletes.map((d) => ({ artistId: d.artistId, dayId: d.dayId })),
      errors: p.errors.map((e) => e.line),
    })
  if (key(fresh) !== key(proposal.plan)) {
    return { kind: 'conflict', code: 'stale_proposal' }
  }
  if (fresh.rows.length === 0 && fresh.deletes.length === 0) {
    return { kind: 'conflict', code: 'empty_proposal' }
  }

  // Transition pending → approved FIRST so a concurrent approve can't
  // double-apply; a failure after this point leaves the row approved
  // with the lineup unchanged, which a re-ingest surfaces truthfully.
  const decided = await deps.repos.lineupIngestions.decide(ingestionId, 'approved', actor)
  if (!decided) return { kind: 'conflict', code: 'not_pending' }

  // Resolve artist ids: rows that matched an existing slot carry the id;
  // new names go through the same find-or-create (+ unique-race
  // fallback) as POST /api/v1/ui/artists. Proposal enrichment (MB links
  // + genre for unknown artists) is persisted here: on the created row,
  // or as a null-only backfill when the artist appeared in the catalog
  // between ingest and approve (findByName hit / lost create race) —
  // existing non-null fields are never overwritten.
  const infoByName = new Map(
    proposalArtistInfo(proposal).map((i) => [i.name.toLowerCase(), i]),
  )
  const enrichmentFor = (artistName: string) => infoByName.get(artistName.toLowerCase())?.enrichment
  const profileFieldsFor = (artistName: string): Record<string, string> => {
    const e = enrichmentFor(artistName)
    if (!e) return {}
    const fields: Record<string, string> = {}
    // mbid included: approve pins the AI-disambiguated MusicBrainz id so
    // the admin catalog sweep can re-look this artist up deterministically.
    for (const [k, v] of Object.entries({ ...e.links, genre: e.genre, mbid: e.mbid })) {
      if (v) fields[k] = v
    }
    return fields
  }
  let artistsCreated = 0
  let artistsEnriched = 0
  const backfilled = new Set<string>()
  const backfillNullFields = async (artist: {
    id: string
    soundcloud: string | null
    spotify: string | null
    appleMusic: string | null
    youtubeMusic: string | null
    instagram: string | null
    genre: string | null
    mbid: string | null
  }, artistName: string): Promise<void> => {
    if (backfilled.has(artist.id)) return
    backfilled.add(artist.id)
    const fill: Record<string, string> = {}
    for (const [k, v] of Object.entries(profileFieldsFor(artistName))) {
      if (artist[k as keyof typeof artist] === null) fill[k] = v
    }
    if (Object.keys(fill).length > 0) {
      await deps.repos.artists.update(artist.id, fill)
      artistsEnriched++
    }
  }
  const upserts: EventArtistRecord[] = []
  for (const r of fresh.rows) {
    let artistId = r.artistId
    if (!artistId) {
      const existing = await deps.repos.artists.findByName(r.artistName)
      if (existing) {
        artistId = existing.id
        await backfillNullFields(existing, r.artistName)
      } else {
        try {
          const created = await deps.repos.artists.create({
            id: `art_${ulid()}`,
            name: r.artistName,
            ...profileFieldsFor(r.artistName),
          })
          artistId = created.id
          artistsCreated++
        } catch (err) {
          if (err instanceof UniqueConstraintError) {
            const raced = await deps.repos.artists.findByName(r.artistName)
            if (!raced) throw err
            artistId = raced.id
            await backfillNullFields(raced, r.artistName)
          } else {
            throw err
          }
        }
      }
    }
    upserts.push({
      eventId: event.id,
      artistId,
      dayId: r.dayId,
      stageId: r.stageId,
      tier: r.tier,
      genre: r.genre,
      startTime: r.startTime,
      endTime: r.endTime,
      displayName: r.displayName,
    })
  }

  // Same pre-apply snapshot the bulk lineup editor takes, so a bad
  // ingest can be reverted from the snapshot history.
  await captureSnapshot(deps.repos, event.id, 'lineup', 'before AI lineup ingest apply', actor)
  const { upserted, deleted } = await deps.repos.eventArtists.bulkApply(event.id, {
    upserts,
    deletes: fresh.deletes.map((d) => ({ artistId: d.artistId, dayId: d.dayId })),
  })
  await recordAdminActivity(deps, event.id, actor, 'event.lineup_ingested', {
    ingestion_id: row.id,
    upserted: upserted.length,
    deleted,
    artists_created: artistsCreated,
    artists_enriched: artistsEnriched,
  })
  publishUpdate(deps, event.id, actor, 'update')
  return {
    kind: 'ok',
    data: {
      ingestion: serializeLineupIngestion(decided),
      applied: { upserted: upserted.length, deleted, artistsCreated, artistsEnriched },
    },
  }
}

export async function adminRejectLineupIngestionCore(
  actor: string,
  ingestionId: string,
  deps: EventsRpcDeps,
): Promise<AdminOk<LineupIngestionDto> | AdminForbidden | AdminNotFound | AdminConflict> {
  if (!isAdmin(actor, deps)) return { kind: 'forbidden' }
  const row = await deps.repos.lineupIngestions.findById(ingestionId)
  if (!row) return { kind: 'not_found' }
  if (row.status !== 'pending') return { kind: 'conflict', code: 'not_pending' }
  const decided = await deps.repos.lineupIngestions.decide(ingestionId, 'rejected', actor)
  if (!decided) return { kind: 'conflict', code: 'not_pending' }
  await recordAdminActivity(deps, row.eventId, actor, 'event.lineup_ingestion_rejected', {
    ingestion_id: row.id,
  })
  return { kind: 'ok', data: serializeLineupIngestion(decided) }
}

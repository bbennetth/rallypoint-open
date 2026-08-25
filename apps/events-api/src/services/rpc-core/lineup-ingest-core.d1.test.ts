import { env } from 'cloudflare:test'
import { describe, it, expect, beforeAll } from 'vitest'
import { ulid } from 'ulid'
import { noopRealtimeBus } from '@rallypoint/realtime'
import { UniqueConstraintError } from '@rallypoint/api-kit'
import type { AiRunResult, AiRunner } from '@rallypoint/ai'
import { buildD1Repos, createDb } from '../../repos/d1/index.js'
import { parseEnv, type Env } from '../../env.js'
import type { Repos } from '../../repos/types.js'
import type { Logger } from '../../logger.js'
import type { Services } from '../types.js'
import { CRSSD_ARTISTS_HTML } from '../../fixtures/crssd-artists.js'
import { adminCreateSystemEventCore } from './admin-events-core.js'
import {
  adminApproveLineupIngestionCore,
  adminGetLineupIngestionCore,
  adminIngestLineupCore,
  adminListLineupIngestionsCore,
  adminRejectLineupIngestionCore,
  type LineupIngestionProposal,
} from './lineup-ingest-core.js'
import type { MusicBrainzClient } from './musicbrainz-client.js'
import type { EventsRpcDeps } from './deps.js'

// D1 integration tests for the AI lineup-ingestion pipeline (CRSSD-shaped
// fixtures): ingest → pending proposal → approve applies artists +
// event_artists through the same paths the lineup editor uses; re-ingest
// supersedes and diffs instead of duplicating. The model call is stubbed
// (injectable AiRunner) — extraction quality is not under test here, the
// persistence + diff + apply machinery is.

const ADMIN = 'user_admin_lineup'
const logger = { info() {}, warn() {}, error() {} } as unknown as Logger

// Extraction stub: returns the given object through the guided_json
// happy path (`response` already parsed).
function aiStub(payload: unknown): AiRunner<AiRunResult> {
  return { run: async () => ({ response: payload as Record<string, unknown> }) }
}

const CRSSD_EXTRACTION = {
  artists: [
    { name: 'MOCHAKK', day: 'Saturday', stage: 'Ocean View' },
    { name: 'CHRIS LAKE x DISCLOSURE', day: 'Saturday', stage: 'Ocean View' },
    { name: 'KETTAMA', day: 'Saturday', stage: 'Ocean View' },
    { name: 'VTSS', day: 'Sunday', stage: 'City Steps' },
    { name: 'HELENA HAUFF', day: 'Sunday', stage: 'City Steps' },
    { name: 'KAS:ST', day: 'Sunday', stage: 'City Steps' },
  ],
}

describe('D1 integration — AI lineup ingestion', () => {
  let repos: Repos
  let deps: EventsRpcDeps

  beforeAll(() => {
    repos = buildD1Repos(createDb(env.DB))
    const envVars: Env = parseEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'fatal',
      ADMIN_USER_IDS: `${ADMIN}, user_admin_other`,
    })
    deps = {
      env: envVars,
      logger,
      repos,
      services: {} as unknown as Services,
      realtime: noopRealtimeBus(),
    }
  })

  // Fresh CRSSD-shaped system event per test: two days, three stages.
  async function newFestival(): Promise<{ eventId: string; dayIds: Map<string, string> }> {
    const created = await adminCreateSystemEventCore(
      ADMIN,
      {
        name: `CRSSD Fall ${ulid().slice(-6)}`,
        timezone: 'America/Los_Angeles',
        startDate: '2026-09-26',
        endDate: '2026-09-27',
        privacyMode: 'public',
      },
      deps,
    )
    if (created.kind !== 'ok') throw new Error(`festival create failed: ${created.kind}`)
    const eventId = created.data.id
    const dayIds = new Map<string, string>()
    for (const [label, date] of [
      ['Saturday', '2026-09-26'],
      ['Sunday', '2026-09-27'],
    ] as const) {
      const day = await repos.days.create({
        id: `evd_${ulid()}`,
        eventId,
        dayLabel: label,
        date,
        sortOrder: dayIds.size,
      })
      dayIds.set(label, day.id)
    }
    let sort = 0
    for (const name of ['Ocean View', 'City Steps', 'The Palms']) {
      await repos.stages.create({ id: `evs_${ulid()}`, eventId, name, sortOrder: sort++ })
    }
    return { eventId, dayIds }
  }

  function ingest(eventId: string, ai: AiRunner<AiRunResult>, extra: Record<string, unknown> = {}) {
    return adminIngestLineupCore(
      ADMIN,
      eventId,
      { pastedText: CRSSD_ARTISTS_HTML, ...extra },
      deps,
      ai,
    )
  }

  it('rejects non-admin actors', async () => {
    const { eventId } = await newFestival()
    const res = await adminIngestLineupCore(
      'user_not_admin',
      eventId,
      { pastedText: 'x' },
      deps,
      aiStub(CRSSD_EXTRACTION),
    )
    expect(res.kind).toBe('forbidden')
  })

  it('reports not_found for non-system events (no probing)', async () => {
    const res = await ingest('event_does_not_exist', aiStub(CRSSD_EXTRACTION))
    expect(res.kind).toBe('not_found')
  })

  it('an event with zero days ingests a fully-unscheduled (TBA) lineup', async () => {
    const created = await adminCreateSystemEventCore(
      ADMIN,
      { name: `Dayless ${ulid().slice(-6)}`, timezone: 'UTC' },
      deps,
    )
    if (created.kind !== 'ok') throw new Error('create failed')
    const res = await ingest(
      created.data.id,
      aiStub({ artists: [{ name: 'MOCHAKK' }, { name: 'VTSS' }] }),
    )
    expect(res.kind).toBe('ok')
    if (res.kind !== 'ok') return
    expect(res.data.proposal!.plan.rows.every((r) => r.dayId === null)).toBe(true)
    const approved = await adminApproveLineupIngestionCore(ADMIN, res.data.id, deps)
    expect(approved.kind).toBe('ok')
    const slots = await repos.eventArtists.listForEvent(created.data.id)
    expect(slots).toHaveLength(2)
    expect(slots.every((sl) => sl.dayId === null)).toBe(true)
  })

  it('reports ai_unavailable without an AI binding', async () => {
    const { eventId } = await newFestival()
    const res = await adminIngestLineupCore(
      ADMIN,
      eventId,
      { pastedText: 'x' },
      deps,
      undefined,
    )
    expect(res).toMatchObject({ kind: 'conflict', code: 'ai_unavailable' })
  })

  it('validates the body (url or pasted text required)', async () => {
    const { eventId } = await newFestival()
    const res = await adminIngestLineupCore(ADMIN, eventId, {}, deps, aiStub(CRSSD_EXTRACTION))
    expect(res.kind).toBe('invalid')
  })

  it('ingests the CRSSD fixture into a pending proposal with a create diff', async () => {
    const { eventId } = await newFestival()
    const res = await ingest(eventId, aiStub(CRSSD_EXTRACTION))
    expect(res.kind).toBe('ok')
    if (res.kind !== 'ok') return
    expect(res.data.status).toBe('pending')
    expect(res.data.source_kind).toBe('pasted')
    const proposal = res.data.proposal!
    expect(proposal.plan.summary).toEqual({ create: 6, update: 0, delete: 0, error: 0 })
    expect(proposal.plan.rows.map((r) => r.artistName)).toContain('CHRIS LAKE x DISCLOSURE')
    // Stage tokens resolved to real stage ids.
    expect(proposal.plan.rows.every((r) => r.stageId !== null)).toBe(true)
    // Nothing applied yet.
    expect(await repos.eventArtists.listForEvent(eventId)).toHaveLength(0)
    // The stripped page text was persisted for audit.
    expect(res.data.source_excerpt).toContain('MOCHAKK')
    expect(res.data.source_excerpt).not.toContain('window.__NUXT__')
  })

  it('drops hallucinated artists into warnings instead of the plan', async () => {
    const { eventId } = await newFestival()
    const res = await ingest(
      eventId,
      aiStub({
        artists: [
          { name: 'MOCHAKK', day: 'Saturday' },
          { name: 'Totally Invented DJ', day: 'Saturday' },
        ],
      }),
    )
    expect(res.kind).toBe('ok')
    if (res.kind !== 'ok') return
    const proposal = res.data.proposal!
    expect(proposal.plan.rows.map((r) => r.artistName)).toEqual(['MOCHAKK'])
    expect(proposal.warnings.some((w) => w.message.includes('Totally Invented DJ'))).toBe(true)
  })

  it('records unusable AI output as a terminal failed row', async () => {
    const { eventId } = await newFestival()
    const res = await ingest(eventId, aiStub({ nonsense: true }))
    expect(res).toMatchObject({ kind: 'failed', code: 'ai_invalid' })
    if (res.kind !== 'failed') return
    expect(res.data.status).toBe('failed')
    const listed = await adminListLineupIngestionsCore(ADMIN, eventId, { status: 'failed' }, deps)
    expect(listed.kind).toBe('ok')
    if (listed.kind === 'ok') expect(listed.data).toHaveLength(1)
  })

  it('day-less artists on a multi-day event plan as unscheduled (TBA) rows — no warnings (live-CRSSD regression)', async () => {
    const { eventId } = await newFestival()
    // A flat artists page: no day info at all (CRSSD pre-schedule state).
    const dayless = {
      artists: [{ name: 'MOCHAKK' }, { name: 'VTSS' }, { name: 'KETTAMA' }],
    }

    const res = await ingest(eventId, aiStub(dayless))
    expect(res.kind).toBe('ok')
    if (res.kind !== 'ok') return
    const proposal = res.data.proposal!
    expect(proposal.warnings).toHaveLength(0)
    expect(proposal.plan.rows).toHaveLength(3)
    expect(proposal.plan.rows.every((r) => r.dayId === null && r.dayLabel === 'TBA')).toBe(true)
    expect(proposal.plan.summary).toMatchObject({ create: 3, error: 0 })
  })

  it('TBA import → day-split re-ingest in replace mode migrates artists to real days', async () => {
    const { eventId, dayIds } = await newFestival()
    // Phase 1: artists announced, no day info — import everyone as TBA.
    const first = await ingest(
      eventId,
      aiStub({ artists: [{ name: 'MOCHAKK' }, { name: 'VTSS' }] }),
    )
    if (first.kind !== 'ok') throw new Error('TBA ingest failed')
    const applied1 = await adminApproveLineupIngestionCore(ADMIN, first.data.id, deps)
    expect(applied1.kind).toBe('ok')

    // Phase 2: day splits announced — VTSS actually plays Sunday.
    const second = await ingest(
      eventId,
      aiStub({
        artists: [
          { name: 'MOCHAKK', day: 'Saturday', stage: 'Ocean View' },
          { name: 'VTSS', day: 'Sunday', stage: 'City Steps' },
        ],
      }),
      { replace: true },
    )
    expect(second.kind).toBe('ok')
    if (second.kind !== 'ok') return
    // Both artists move TBA → real day: two creates on real days plus two
    // replace-mode deletes of the TBA slots.
    expect(second.data.proposal!.plan.summary).toMatchObject({ create: 2, update: 0, delete: 2 })
    const applied2 = await adminApproveLineupIngestionCore(ADMIN, second.data.id, deps)
    expect(applied2.kind).toBe('ok')
    const slots = await repos.eventArtists.listForEvent(eventId)
    expect(slots).toHaveLength(2)
    expect(slots.every((sl) => sl.dayId !== null)).toBe(true)
    const vtss = await repos.artists.findByName('VTSS')
    expect(slots.find((s) => s.artistId === vtss!.id)!.dayId).toBe(dayIds.get('Sunday'))
  })

  it('non-replace re-ingest after a TBA import never duplicates a slot', async () => {
    const { eventId, dayIds } = await newFestival()
    const first = await ingest(eventId, aiStub({ artists: [{ name: 'MOCHAKK' }] }))
    if (first.kind !== 'ok') throw new Error('TBA ingest failed')
    await adminApproveLineupIngestionCore(ADMIN, first.data.id, deps)

    // Same artist re-ingested WITHOUT replace, now on their real day:
    // that's a create on Sunday; the TBA slot stays (documented
    // non-replace semantics — nothing is deleted), but no bucket ever
    // gets a duplicate row for the artist.
    const second = await ingest(
      eventId,
      aiStub({ artists: [{ name: 'MOCHAKK', day: 'Sunday' }] }),
    )
    if (second.kind !== 'ok') throw new Error('re-ingest failed')
    expect(second.data.proposal!.plan.summary).toMatchObject({ create: 1, update: 0, delete: 0 })
    const applied = await adminApproveLineupIngestionCore(ADMIN, second.data.id, deps)
    expect(applied.kind).toBe('ok')

    const slots = await repos.eventArtists.listForEvent(eventId)
    const mochakk = await repos.artists.findByName('MOCHAKK')
    const mine = slots.filter((s) => s.artistId === mochakk!.id)
    expect(mine).toHaveLength(2)
    expect(new Set(mine.map((s) => s.dayId))).toEqual(new Set([null, dayIds.get('Sunday')]))
  })

  it('repo: one unscheduled slot per artist — TBA upsert updates in place; scheduled + TBA coexist', async () => {
    const { eventId, dayIds } = await newFestival()
    const artist =
      (await repos.artists.findByName('KETTAMA')) ??
      (await repos.artists.create({ id: `art_${ulid()}`, name: 'KETTAMA' }))
    const base = {
      eventId,
      artistId: artist.id,
      stageId: null,
      tier: null,
      genre: null,
      startTime: null,
      endTime: null,
      displayName: null,
    }

    // Two TBA upserts for the same artist: the second must UPDATE the
    // first (partial unique index conflict target), not duplicate it.
    await repos.eventArtists.upsert({ ...base, dayId: null })
    await repos.eventArtists.upsert({ ...base, dayId: null, tier: 'headliner' })
    let mine = (await repos.eventArtists.listForEvent(eventId)).filter(
      (s) => s.artistId === artist.id,
    )
    expect(mine).toHaveLength(1)
    expect(mine[0]).toMatchObject({ dayId: null, tier: 'headliner' })

    // A scheduled slot coexists with the TBA one.
    await repos.eventArtists.upsert({ ...base, dayId: dayIds.get('Saturday')! })
    mine = (await repos.eventArtists.listForEvent(eventId)).filter(
      (s) => s.artistId === artist.id,
    )
    expect(mine).toHaveLength(2)

    // find/delete address the TBA slot with dayId null.
    expect(await repos.eventArtists.find(eventId, artist.id, null)).not.toBeNull()
    expect(await repos.eventArtists.delete(eventId, artist.id, null)).toBe(true)
    expect(await repos.eventArtists.find(eventId, artist.id, null)).toBeNull()
  })

  it('a failed re-ingest does NOT discard an existing good pending proposal', async () => {
    const { eventId } = await newFestival()
    const good = await ingest(eventId, aiStub(CRSSD_EXTRACTION))
    expect(good.kind).toBe('ok')
    if (good.kind !== 'ok') return

    const bad = await ingest(eventId, aiStub({ nonsense: true }))
    expect(bad).toMatchObject({ kind: 'failed', code: 'ai_invalid' })

    // The good proposal is still pending and approvable.
    const stillPending = await adminGetLineupIngestionCore(ADMIN, good.data.id, deps)
    if (stillPending.kind !== 'ok') throw new Error('get failed')
    expect(stillPending.data.status).toBe('pending')
    const approved = await adminApproveLineupIngestionCore(ADMIN, good.data.id, deps)
    expect(approved.kind).toBe('ok')
  })

  it('approve applies the plan: artists find-or-created, slots bulk-applied, snapshot taken', async () => {
    const { eventId, dayIds } = await newFestival()
    // Pre-existing catalog artist with different casing — must be reused,
    // not duplicated. (Artists are a global catalog shared across tests,
    // so find-or-create here and compute the created-count expectation
    // from what actually pre-exists.)
    if (!(await repos.artists.findByName('Mochakk'))) {
      await repos.artists.create({ id: `art_${ulid()}`, name: 'Mochakk' })
    }
    let preExisting = 0
    for (const a of CRSSD_EXTRACTION.artists) {
      if (await repos.artists.findByName(a.name)) preExisting++
    }
    // Canonical stored casing before approve — reuse must not overwrite
    // it with the extraction's different casing.
    const casingBefore = (await repos.artists.findByName('Mochakk'))!.name

    const ingested = await ingest(eventId, aiStub(CRSSD_EXTRACTION))
    expect(ingested.kind).toBe('ok')
    if (ingested.kind !== 'ok') return

    const approved = await adminApproveLineupIngestionCore(ADMIN, ingested.data.id, deps)
    expect(approved.kind).toBe('ok')
    if (approved.kind !== 'ok') return
    expect(approved.data.applied).toMatchObject({
      upserted: 6,
      deleted: 0,
      artistsCreated: 6 - preExisting,
    })
    expect(approved.data.ingestion.status).toBe('approved')
    expect(approved.data.ingestion.reviewed_by).toBe(ADMIN)

    const slots = await repos.eventArtists.listForEvent(eventId)
    expect(slots).toHaveLength(6)
    expect(slots.filter((s) => s.dayId === dayIds.get('Saturday'))).toHaveLength(3)
    // Case-insensitive reuse: the slot references the one catalog row
    // findByName resolves regardless of stored casing — no duplicate row
    // was created for the different-cased extraction name.
    const mochakk = await repos.artists.findByName('MOCHAKK')
    expect(mochakk).not.toBeNull()
    expect(mochakk!.name).toBe(casingBefore)
    expect(slots.some((s) => s.artistId === mochakk!.id)).toBe(true)
    // Pre-apply snapshot captured for revert.
    const snapshots = await repos.eventSnapshots.listForEvent(eventId, 'lineup')
    expect(snapshots).toHaveLength(1)

    // Double-approve is a conflict, not a double-apply.
    const again = await adminApproveLineupIngestionCore(ADMIN, ingested.data.id, deps)
    expect(again).toMatchObject({ kind: 'conflict', code: 'not_pending' })
  })

  it('re-ingest supersedes the open proposal and diffs as updates, not duplicates', async () => {
    const { eventId } = await newFestival()
    const first = await ingest(eventId, aiStub(CRSSD_EXTRACTION))
    expect(first.kind).toBe('ok')
    if (first.kind !== 'ok') return
    const approved = await adminApproveLineupIngestionCore(ADMIN, first.data.id, deps)
    expect(approved.kind).toBe('ok')

    // Set times announced later — same artists, now with schedule detail.
    const second = await ingest(
      eventId,
      aiStub({
        artists: [
          { name: 'MOCHAKK', day: 'Saturday', stage: 'Ocean View', start: '21:30', end: '23:00', tier: 'headliner' },
          { name: 'VTSS', day: 'Sunday', stage: 'City Steps', start: '22:00', end: '23:30' },
        ],
      }),
    )
    expect(second.kind).toBe('ok')
    if (second.kind !== 'ok') return
    const proposal = second.data.proposal!
    expect(proposal.plan.summary).toMatchObject({ create: 0, update: 2 })

    const applied = await adminApproveLineupIngestionCore(ADMIN, second.data.id, deps)
    expect(applied.kind).toBe('ok')
    const slots = await repos.eventArtists.listForEvent(eventId)
    // Still 6 slots — updates hit the composite PK, no duplicates.
    expect(slots).toHaveLength(6)
    const mochakk = await repos.artists.findByName('MOCHAKK')
    const updated = slots.find((s) => s.artistId === mochakk!.id)
    expect(updated).toMatchObject({ startTime: '21:30', endTime: '23:00', tier: 'headliner' })
  })

  it('replace mode plans deletes for slots missing from the extraction', async () => {
    const { eventId } = await newFestival()
    const first = await ingest(eventId, aiStub(CRSSD_EXTRACTION))
    if (first.kind !== 'ok') throw new Error('ingest failed')
    await adminApproveLineupIngestionCore(ADMIN, first.data.id, deps)

    const second = await ingest(
      eventId,
      aiStub({ artists: [{ name: 'MOCHAKK', day: 'Saturday', stage: 'Ocean View' }] }),
      { replace: true },
    )
    expect(second.kind).toBe('ok')
    if (second.kind !== 'ok') return
    expect(second.data.proposal!.plan.summary).toMatchObject({ update: 1, delete: 5 })
    const applied = await adminApproveLineupIngestionCore(ADMIN, second.data.id, deps)
    expect(applied.kind).toBe('ok')
    expect(await repos.eventArtists.listForEvent(eventId)).toHaveLength(1)
  })

  it('supersede keeps one pending per event; the unique index backstops races', async () => {
    const { eventId } = await newFestival()
    const first = await ingest(eventId, aiStub(CRSSD_EXTRACTION))
    if (first.kind !== 'ok') throw new Error('ingest failed')
    const second = await ingest(eventId, aiStub(CRSSD_EXTRACTION))
    expect(second.kind).toBe('ok')
    if (second.kind !== 'ok') return

    const firstNow = await adminGetLineupIngestionCore(ADMIN, first.data.id, deps)
    if (firstNow.kind !== 'ok') throw new Error('get failed')
    expect(firstNow.data.status).toBe('superseded')
    const pending = await repos.lineupIngestions.listForEvent(eventId, { status: 'pending' })
    expect(pending).toHaveLength(1)

    // Direct second pending insert (the race the app-level supersede
    // can't see) trips the partial unique index as UniqueConstraintError.
    await expect(
      repos.lineupIngestions.create({
        id: `lin_${ulid()}`,
        eventId,
        sourceKind: 'pasted',
        sourceExcerpt: 'x',
        model: 'test',
        extracted: {},
        proposal: {},
        createdBy: ADMIN,
      }),
    ).rejects.toBeInstanceOf(UniqueConstraintError)
  })

  it('refuses to apply a stale proposal after the lineup changed underneath it', async () => {
    const { eventId } = await newFestival()
    const ingested = await ingest(eventId, aiStub(CRSSD_EXTRACTION))
    if (ingested.kind !== 'ok') throw new Error('ingest failed')

    // Someone edits the lineup while the proposal sits in review: the
    // proposal's creates should now be updates → plan mismatch.
    // Artists are a global catalog shared across tests — find-or-create.
    const artist =
      (await repos.artists.findByName('VTSS')) ??
      (await repos.artists.create({ id: `art_${ulid()}`, name: 'VTSS' }))
    const days = await repos.days.listForEvent(eventId)
    await repos.eventArtists.upsert({
      eventId,
      artistId: artist.id,
      dayId: days.find((d) => d.dayLabel === 'Sunday')!.id,
      stageId: null,
      tier: null,
      genre: null,
      startTime: null,
      endTime: null,
      displayName: null,
    })

    const approved = await adminApproveLineupIngestionCore(ADMIN, ingested.data.id, deps)
    expect(approved).toMatchObject({ kind: 'conflict', code: 'stale_proposal' })
    // Proposal stays pending for an explicit reject/re-ingest.
    const now = await adminGetLineupIngestionCore(ADMIN, ingested.data.id, deps)
    if (now.kind !== 'ok') throw new Error('get failed')
    expect(now.data.status).toBe('pending')
  })

  it('rejects an empty proposal at approve time', async () => {
    const { eventId } = await newFestival()
    const ingested = await ingest(eventId, aiStub({ artists: [] }))
    expect(ingested.kind).toBe('ok')
    if (ingested.kind !== 'ok') return
    const approved = await adminApproveLineupIngestionCore(ADMIN, ingested.data.id, deps)
    expect(approved).toMatchObject({ kind: 'conflict', code: 'empty_proposal' })
  })

  it('reject closes the proposal without touching the lineup', async () => {
    const { eventId } = await newFestival()
    const ingested = await ingest(eventId, aiStub(CRSSD_EXTRACTION))
    if (ingested.kind !== 'ok') throw new Error('ingest failed')
    const rejected = await adminRejectLineupIngestionCore(ADMIN, ingested.data.id, deps)
    expect(rejected.kind).toBe('ok')
    if (rejected.kind !== 'ok') return
    expect(rejected.data.status).toBe('rejected')
    expect(await repos.eventArtists.listForEvent(eventId)).toHaveLength(0)
    // Re-reject conflicts.
    const again = await adminRejectLineupIngestionCore(ADMIN, ingested.data.id, deps)
    expect(again).toMatchObject({ kind: 'conflict', code: 'not_pending' })
  })

  it('round-trips the proposal JSON through D1 intact', async () => {
    const { eventId } = await newFestival()
    const ingested = await ingest(eventId, aiStub(CRSSD_EXTRACTION))
    if (ingested.kind !== 'ok') throw new Error('ingest failed')
    const fetched = await repos.lineupIngestions.findById(ingested.data.id)
    const proposal = fetched!.proposal as LineupIngestionProposal
    expect(proposal.plan.summary.create).toBe(6)
    expect(proposal.inputRows).toHaveLength(6)
    expect(proposal.replace).toBe(false)
  })

  // --- catalog matching + MusicBrainz enrichment ---------------------

  describe('artist catalog matching + MusicBrainz enrichment', () => {
    // Sequence stub: first run() call = extraction, second = the batched
    // disambiguation. Payloads are already-parsed guided_json objects.
    function aiStubSeq(payloads: unknown[]): AiRunner<AiRunResult> {
      const queue = [...payloads]
      return { run: async () => ({ response: (queue.shift() ?? {}) as Record<string, unknown> }) }
    }

    const MB_LINKS = {
      spotify: 'https://open.spotify.com/artist/enr',
      soundcloud: 'https://soundcloud.com/enr',
      appleMusic: null,
      youtubeMusic: null,
      instagram: 'https://instagram.com/enr',
    }

    // Fake MB client keyed by artist name; search failures/misses are
    // modeled per-name. Records calls so tests can assert who was (not)
    // looked up.
    function fakeMb(byName: Record<string, { mbid: string; genre?: string | null }>) {
      const searched: string[] = []
      const client: MusicBrainzClient = {
        async search(name) {
          searched.push(name)
          const hit = byName[name]
          if (hit === undefined) return []
          return [
            { mbid: hit.mbid, name, disambiguation: null, score: 100, type: 'Person', tags: [] },
          ]
        },
        async lookup(mbid) {
          const entry = Object.values(byName).find((v) => v.mbid === mbid)
          if (!entry) return null
          return { links: { ...MB_LINKS }, genre: entry.genre ?? 'techno' }
        },
      }
      return { client, searched }
    }

    const picksFor = (byName: Record<string, { mbid: string }>) => ({
      picks: Object.entries(byName).map(([name, v]) => ({
        name,
        mbid: v.mbid,
        confidence: 'high',
      })),
    })

    // Unique names per test — the artists catalog is a global table
    // shared across this suite.
    const uniqueNames = (n: number) =>
      Array.from({ length: n }, (_, i) => `ENRICH ${ulid().slice(-8)} NO${i}`)

    function ingestNames(
      eventId: string,
      names: string[],
      ai: AiRunner<AiRunResult>,
      mb: MusicBrainzClient | undefined,
    ) {
      return adminIngestLineupCore(
        ADMIN,
        eventId,
        { pastedText: names.join('\n') },
        deps,
        ai,
        mb ? { musicbrainz: mb } : {},
      )
    }

    it('known catalog artists get a matched block and are never sent to MB', async () => {
      const { eventId } = await newFestival()
      const [known, unknown] = uniqueNames(2) as [string, string]
      await repos.artists.create({
        id: `art_${ulid()}`,
        name: known,
        spotify: 'https://open.spotify.com/artist/known',
        genre: 'house',
      })
      const { client, searched } = fakeMb({ [unknown]: { mbid: 'mb-u1' } })
      const res = await ingestNames(
        eventId,
        [known, unknown],
        aiStubSeq([
          { artists: [{ name: known }, { name: unknown }] },
          picksFor({ [unknown]: { mbid: 'mb-u1' } }),
        ]),
        client,
      )
      expect(res.kind).toBe('ok')
      if (res.kind !== 'ok') return
      const infos = res.data.proposal!.artists!
      expect(infos).toHaveLength(2)
      const matched = infos.find((i) => i.name === known)!
      expect(matched.matched).toMatchObject({
        genre: 'house',
        links: { spotify: 'https://open.spotify.com/artist/known' },
      })
      expect(matched.enrichment).toBeUndefined()
      const enriched = infos.find((i) => i.name === unknown)!
      expect(enriched.matched).toBeUndefined()
      expect(enriched.enrichment).toMatchObject({
        mbid: 'mb-u1',
        confidence: 'high',
        genre: 'techno',
        links: { spotify: MB_LINKS.spotify, instagram: MB_LINKS.instagram },
      })
      expect(searched).toEqual([unknown])
    })

    it('approve persists enrichment links + genre on the created artist', async () => {
      const { eventId } = await newFestival()
      const [name] = uniqueNames(1) as [string]
      const { client } = fakeMb({ [name]: { mbid: 'mb-a1', genre: 'dnb' } })
      const res = await ingestNames(
        eventId,
        [name],
        aiStubSeq([{ artists: [{ name }] }, picksFor({ [name]: { mbid: 'mb-a1' } })]),
        client,
      )
      if (res.kind !== 'ok') throw new Error('ingest failed')
      const approved = await adminApproveLineupIngestionCore(ADMIN, res.data.id, deps)
      expect(approved.kind).toBe('ok')
      if (approved.kind !== 'ok') return
      expect(approved.data.applied).toMatchObject({ artistsCreated: 1, artistsEnriched: 0 })
      const artist = await repos.artists.findByName(name)
      expect(artist).toMatchObject({
        genre: 'dnb',
        spotify: MB_LINKS.spotify,
        soundcloud: MB_LINKS.soundcloud,
        instagram: MB_LINKS.instagram,
        appleMusic: null,
        youtubeMusic: null,
      })
    })

    it('backfills only null fields when the artist appeared between ingest and approve', async () => {
      const { eventId } = await newFestival()
      const [name] = uniqueNames(1) as [string]
      const { client } = fakeMb({ [name]: { mbid: 'mb-b1', genre: 'dnb' } })
      const res = await ingestNames(
        eventId,
        [name],
        aiStubSeq([{ artists: [{ name }] }, picksFor({ [name]: { mbid: 'mb-b1' } })]),
        client,
      )
      if (res.kind !== 'ok') throw new Error('ingest failed')
      // The artist gets created out-of-band before approve, with one
      // link already set — that field must survive, the nulls fill.
      await repos.artists.create({
        id: `art_${ulid()}`,
        name,
        spotify: 'https://open.spotify.com/artist/manual',
      })
      const approved = await adminApproveLineupIngestionCore(ADMIN, res.data.id, deps)
      expect(approved.kind).toBe('ok')
      if (approved.kind !== 'ok') return
      expect(approved.data.applied).toMatchObject({ artistsCreated: 0, artistsEnriched: 1 })
      const artist = await repos.artists.findByName(name)
      expect(artist).toMatchObject({
        spotify: 'https://open.spotify.com/artist/manual',
        soundcloud: MB_LINKS.soundcloud,
        instagram: MB_LINKS.instagram,
        genre: 'dnb',
      })
    })

    it('search misses/failures and AI disambiguation failure degrade to warnings', async () => {
      const { eventId } = await newFestival()
      const [miss, fail] = uniqueNames(2) as [string, string]
      const { client } = fakeMb({}) // every search returns []
      client.search = async (n) => (n === fail ? null : [])
      const res = await ingestNames(
        eventId,
        [miss, fail],
        aiStubSeq([{ artists: [{ name: miss }, { name: fail }] }]),
        client,
      )
      expect(res.kind).toBe('ok')
      if (res.kind !== 'ok') return
      const proposal = res.data.proposal!
      expect(proposal.warnings.some((w) => w.message.includes(`No MusicBrainz match found for "${miss}"`))).toBe(true)
      expect(proposal.warnings.some((w) => w.message.includes(`MusicBrainz search failed for "${fail}"`))).toBe(true)
      expect(proposal.artists!.every((i) => !i.enrichment && !i.matched)).toBe(true)

      // Disambiguation failure: candidates exist but the model output is
      // unusable — proposal still lands, with a warning.
      const { eventId: eventId2 } = await newFestival()
      const [name2] = uniqueNames(1) as [string]
      const { client: client2 } = fakeMb({ [name2]: { mbid: 'mb-c1' } })
      const res2 = await ingestNames(
        eventId2,
        [name2],
        aiStubSeq([{ artists: [{ name: name2 }] }, { nonsense: true }]),
        client2,
      )
      expect(res2.kind).toBe('ok')
      if (res2.kind !== 'ok') return
      expect(
        res2.data.proposal!.warnings.some((w) => w.message.includes('AI disambiguation failed')),
      ).toBe(true)
      expect(res2.data.proposal!.artists!.find((i) => i.name === name2)!.enrichment).toBeUndefined()
    })

    it('caps enrichment at 30 unknown artists with a skip warning', async () => {
      const { eventId } = await newFestival()
      const names = uniqueNames(32)
      const { client, searched } = fakeMb({})
      const res = await ingestNames(
        eventId,
        names,
        aiStubSeq([{ artists: names.map((name) => ({ name })) }]),
        client,
      )
      expect(res.kind).toBe('ok')
      if (res.kind !== 'ok') return
      expect(searched).toHaveLength(30)
      const cap = res.data.proposal!.warnings.find((w) =>
        w.message.includes('beyond the 30-artist cap'),
      )
      expect(cap).toBeDefined()
      expect(cap!.message).toContain(names[31]!)
    })

    it('a proposal with enrichment info still passes the staleness guard, and legacy proposals without it approve', async () => {
      const { eventId } = await newFestival()
      const [name] = uniqueNames(1) as [string]
      const { client } = fakeMb({ [name]: { mbid: 'mb-d1' } })
      const res = await ingestNames(
        eventId,
        [name],
        aiStubSeq([{ artists: [{ name }] }, picksFor({ [name]: { mbid: 'mb-d1' } })]),
        client,
      )
      if (res.kind !== 'ok') throw new Error('ingest failed')
      expect(res.data.proposal!.artists).toBeDefined()

      // Simulate a legacy (pre-enrichment) stored proposal: same plan,
      // no `artists` field. Reject the live one to free the pending
      // slot, then insert the stripped shape directly and approve it.
      await adminRejectLineupIngestionCore(ADMIN, res.data.id, deps)
      const { artists: _dropped, ...legacyProposal } = res.data.proposal!
      const legacyRow = await repos.lineupIngestions.create({
        id: `lin_${ulid()}`,
        eventId,
        sourceKind: 'pasted',
        sourceExcerpt: name,
        model: 'test',
        extracted: {},
        proposal: legacyProposal,
        createdBy: ADMIN,
      })
      const approved = await adminApproveLineupIngestionCore(ADMIN, legacyRow.id, deps)
      expect(approved.kind).toBe('ok')
      if (approved.kind !== 'ok') return
      // No enrichment info → created bare, exactly the pre-feature path.
      expect(approved.data.applied).toMatchObject({ artistsCreated: 1, artistsEnriched: 0 })
      const artist = await repos.artists.findByName(name)
      expect(artist!.spotify).toBeNull()
      expect(artist!.genre).toBeNull()
    })
  })
})

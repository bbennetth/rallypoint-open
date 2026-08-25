import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { env as testEnv } from 'cloudflare:test'
import type { Hono } from 'hono'
import { unzipSync, zipSync } from 'fflate'
import type { ImportSummary } from '@rallypoint/api-kit'
import {
  ListsClientError,
  type GroupDto,
  type ListDto,
  type ListsClient,
} from '@rallypoint/lists-client'
import type { ListBundle, ListImportResult } from '@rallypoint/lists-shared'
import {
  EventsClientError,
  type EventsClient,
  type PersonalEventDto,
  type PersonalTicketDto,
} from '@rallypoint/events-client'
import { generateRawToken, hashToken } from '@rallypoint/crypto'
import { parseEnv, type Env } from '../env.js'
import { buildApp } from '../build-app.js'
import { buildD1Repos, createDb } from '../repos/d1/index.js'
import type { HonoApp } from '../context.js'
import type { Repos } from '../repos/types.js'
import type { Services } from '../services/types.js'
import { encryptBearer } from '../crypto/encryption.js'
import { PLANNER_SESSION_BEARER_PREFIX } from '../middleware/session.js'
import { PERSONAL_GROUP_NAME } from '../lib/personal-scope.js'
import {
  PLANNER_EXPORT_SCHEMA_VERSION,
  PLANNER_MANIFEST_ENTRY,
  ticketBlobPath,
  type PlannerManifest,
} from '../lib/export-manifest.js'

// D1 integration tests for the whole-account Planner data export/import
// (backup–restore). Unlike the Fitness version of this suite (which
// round-trips through real D1 rows), planner-api owns NO domain data — every
// row comes from the Lists and Events SDKs — so the load-bearing behaviour
// here is the BFF's ORCHESTRATION: which SDK calls it makes, in what order,
// with what arguments, and how it staples the two SDKs' results into one
// manifest on export / one ImportSummary on import. Both SDKs are in-memory
// fakes injected at the services layer, matching every other planner-api
// route suite (see lists.d1.test.ts, events.d1.test.ts).

type ApiErrorBody = { error: { code: string; message: string } }

const CSRF = 'csrf_token_value_data_transfer_aaaaaaaaaaaa'
const TICKET_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x01, 0x02, 0x03, 0x04])

function isoNow(): string {
  return new Date().toISOString()
}

// Zero-arg stub that throws if a route ever starts calling a method this
// suite didn't expect — a missing fake behaviour fails loudly instead of
// silently resolving to `undefined`. Mirrors events.d1.test.ts's
// `getEvent: async () => { throw new Error('unused') }` stubs.
function unused(method: string) {
  return async (): Promise<never> => {
    throw new Error(`unused in data-transfer tests: ${method}`)
  }
}

// --- Fake Lists SDK ------------------------------------------------------
//
// Only the personal-scope helpers (listGroups/createGroup/listLists) and the
// two transfer methods are real; everything else is a throwing stub since
// data-export/data-import never touch the rest of the surface.

interface FakeLists {
  client: ListsClient
  calls: { method: string; actor?: string; args: unknown[] }[]
  // TEST SETUP ONLY (not the createGroup SDK method): find-or-create the
  // actor's Planner personal group and seed a list_group-scoped list in it
  // whose exportListBundle result is exactly `bundle`. Returns the listId.
  seedList(actor: string, bundle: ListBundle): string
  // Make exportListBundle throw for an already-seeded listId — models a list
  // that vanished (or the SDK refused) mid-export.
  failExport(listId: string): void
  // Override the ListImportResult importListBundle returns for a bundle
  // with this NAME (a bundle carries no row id, so import-side behaviour is
  // configured by name).
  setImportResult(bundleName: string, result: ListImportResult): void
  // Make importListBundle throw for a bundle with this name.
  failImport(bundleName: string): void
}

function makeFakeLists(): FakeLists {
  const groups: GroupDto[] = []
  const lists: ListDto[] = []
  const exportBehavior = new Map<string, ListBundle | 'throw'>()
  const importBehavior = new Map<string, ListImportResult | 'throw'>()
  const calls: FakeLists['calls'] = []
  let groupSeq = 0
  let listSeq = 0
  let importSeq = 0

  // TEST-SETUP find-or-create, separate from the createGroup SDK method
  // below (which always inserts a fresh row, matching real lists-api).
  function testGroupFor(actor: string): GroupDto {
    let g = groups.find((x) => x.createdBy === actor && x.name === PERSONAL_GROUP_NAME)
    if (!g) {
      groupSeq += 1
      g = {
        id: `lgr_${groupSeq}`,
        name: PERSONAL_GROUP_NAME,
        description: null,
        origin: 'planner',
        createdBy: actor,
        createdAt: isoNow(),
        updatedAt: isoNow(),
      }
      groups.push(g)
    }
    return g
  }

  const client: ListsClient = {
    health: async () => ({ status: 'ok' }),
    listGroups: async (actor) => {
      calls.push({ method: 'listGroups', actor, args: [] })
      return groups.filter((g) => g.createdBy === actor)
    },
    createGroup: async (input, actor) => {
      calls.push({ method: 'createGroup', actor, args: [input] })
      groupSeq += 1
      const g: GroupDto = {
        id: `lgr_${groupSeq}`,
        name: input.name,
        description: input.description ?? null,
        origin: input.origin ?? null,
        createdBy: actor,
        createdAt: isoNow(),
        updatedAt: isoNow(),
      }
      groups.push(g)
      return g
    },
    listLists: async (scope) => {
      calls.push({ method: 'listLists', args: [scope] })
      return lists.filter((l) => l.scopeType === scope.scopeType && l.scopeId === scope.scopeId)
    },
    exportListBundle: async (listId, actor) => {
      calls.push({ method: 'exportListBundle', actor, args: [listId] })
      const behavior = exportBehavior.get(listId)
      if (behavior === 'throw') throw new Error('export_failed')
      if (!behavior) throw new ListsClientError(404, 'not_found', 'List not found.')
      return behavior
    },
    importListBundle: async (scope, bundle, actor) => {
      calls.push({ method: 'importListBundle', actor, args: [scope, bundle] })
      const behavior = importBehavior.get(bundle.name)
      if (behavior === 'throw') throw new Error('import_failed')
      if (behavior) return behavior
      importSeq += 1
      // Sensible default: the list + every item/series it carries is "new".
      return {
        listId: `lst_imported_${importSeq}`,
        listCreated: true,
        fieldDefs: { created: 0, skipped: 0 },
        statuses: { created: 0, skipped: 0 },
        labels: { created: 0, skipped: 0 },
        series: { created: bundle.series.length, skipped: 0 },
        items: { created: bundle.items.length, skipped: 0 },
        comments: { created: 0, skipped: 0 },
        warnings: [],
      }
    },
    listItems: unused('listItems'),
    listItemsPage: unused('listItemsPage'),
    listDeletedItems: unused('listDeletedItems'),
    getItem: unused('getItem'),
    listFieldDefs: unused('listFieldDefs'),
    listStatuses: unused('listStatuses'),
    listLabels: unused('listLabels'),
    createFieldDef: unused('createFieldDef'),
    updateFieldDef: unused('updateFieldDef'),
    deleteFieldDef: unused('deleteFieldDef'),
    createList: unused('createList'),
    deleteList: unused('deleteList'),
    createListItem: unused('createListItem'),
    updateListItem: unused('updateListItem'),
    deleteListItem: unused('deleteListItem'),
    restoreListItem: unused('restoreListItem'),
    moveListItem: unused('moveListItem'),
    findItemInScope: unused('findItemInScope'),
    createListItemSeries: unused('createListItemSeries'),
    listSeries: unused('listSeries'),
    updateSeries: unused('updateSeries'),
    deleteSeries: unused('deleteSeries'),
    listComments: unused('listComments'),
    createComment: unused('createComment'),
    mergeLists: unused('mergeLists'),
  }

  return {
    client,
    calls,
    seedList(actor, bundle) {
      const g = testGroupFor(actor)
      listSeq += 1
      const id = `lst_${listSeq}`
      lists.push({
        id,
        scopeType: 'list_group',
        scopeId: g.id,
        listType: bundle.listType as ListDto['listType'],
        name: bundle.name,
        visibility: bundle.visibility as ListDto['visibility'],
        color: bundle.color ?? null,
        createdBy: actor,
        incompleteCount: 0,
        createdAt: isoNow(),
        updatedAt: isoNow(),
      })
      exportBehavior.set(id, bundle)
      return id
    },
    failExport(listId) {
      exportBehavior.set(listId, 'throw')
    },
    setImportResult(bundleName, result) {
      importBehavior.set(bundleName, result)
    },
    failImport(bundleName) {
      importBehavior.set(bundleName, 'throw')
    },
  }
}

// --- Fake Events SDK -------------------------------------------------------
//
// createPersonalEvent is ref-idempotent — dedupes on (owner, ref) and REPLAYS
// the same event object rather than re-applying the incoming fields — which
// mirrors events-api and is the load-bearing assumption data-import.ts's
// importEvent makes: replaying the same ref on a second import must return
// an id that was already in preExistingEventIds.

interface FakeEvents {
  client: EventsClient
  calls: { method: string; actor?: string; args: unknown[] }[]
}

function makeFakeEvents(): FakeEvents {
  const events: PersonalEventDto[] = []
  const tickets: PersonalTicketDto[] = []
  const ticketBytes = new Map<string, Uint8Array>()
  const refIndex = new Map<string, string>() // `${actor}::${ref}` -> event id
  const calls: FakeEvents['calls'] = []
  let evtSeq = 0
  let tktSeq = 0

  const client: EventsClient = {
    getEvent: unused('getEvent'),
    getLineup: unused('getLineup'),
    getSessions: unused('getSessions'),
    createPersonalEvent: async (opts) => {
      calls.push({ method: 'createPersonalEvent', actor: opts.actor, args: [opts] })
      if (opts.ref) {
        const existingId = refIndex.get(`${opts.actor}::${opts.ref}`)
        const existing = existingId ? events.find((e) => e.id === existingId) : undefined
        if (existing) return existing
      }
      evtSeq += 1
      const e: PersonalEventDto = {
        id: `event_${evtSeq}`,
        scopeType: 'personal',
        ownerUserId: opts.actor,
        slug: `personal-${evtSeq}`,
        name: opts.name,
        description: opts.description ?? null,
        startAt: opts.startAt ?? null,
        endAt: opts.endAt ?? null,
        allDay: opts.allDay ?? false,
        timezone: 'UTC',
        locationLabel: opts.locationLabel ?? null,
        privacyMode: 'private',
        ticketCount: 0,
        ticketPlatform: opts.ticketPlatform ?? null,
        ticketAccountEmail: opts.ticketAccountEmail ?? null,
        createdAt: isoNow(),
        updatedAt: isoNow(),
      }
      events.push(e)
      if (opts.ref) refIndex.set(`${opts.actor}::${opts.ref}`, e.id)
      return e
    },
    listPersonalEvents: async (opts) => {
      calls.push({ method: 'listPersonalEvents', actor: opts.actor, args: [opts] })
      return events.filter((e) => e.ownerUserId === opts.actor)
    },
    getPersonalEvent: unused('getPersonalEvent'),
    patchPersonalEvent: unused('patchPersonalEvent'),
    deletePersonalEvent: unused('deletePersonalEvent'),
    listUserEvents: unused('listUserEvents'),
    setGroupEventPlannerPref: unused('setGroupEventPlannerPref'),
    listPlannerGroupEvents: unused('listPlannerGroupEvents'),
    listHolidays: unused('listHolidays'),
    getForecast: unused('getForecast'),
    uploadTicket: async (opts) => {
      calls.push({ method: 'uploadTicket', actor: opts.actor, args: [opts] })
      tktSeq += 1
      const id = `pkt_${tktSeq}`
      const bytes = new Uint8Array(await opts.file.arrayBuffer())
      ticketBytes.set(id, bytes)
      const t: PersonalTicketDto = {
        id,
        eventId: opts.eventId,
        contentType: opts.contentType,
        bytes: bytes.length,
        fileName: opts.fileName ?? null,
        uploadedByUserId: opts.actor,
        uploadedAt: isoNow(),
      }
      tickets.push(t)
      return t
    },
    listTickets: async (opts) => {
      calls.push({ method: 'listTickets', actor: opts.actor, args: [opts] })
      return tickets.filter((t) => t.eventId === opts.eventId)
    },
    downloadTicket: async (opts) => {
      calls.push({ method: 'downloadTicket', actor: opts.actor, args: [opts] })
      const bytes = ticketBytes.get(opts.ticketId)
      if (!bytes) throw new EventsClientError(404, 'not_found', 'Ticket not found.')
      const t = tickets.find((x) => x.id === opts.ticketId)
      return new Response(bytes, {
        status: 200,
        headers: { 'content-type': t?.contentType ?? 'application/octet-stream' },
      })
    },
  }

  return { client, calls }
}

// --- manifest / archive builders -------------------------------------------

function makeBundle(name: string, itemCount = 1): ListBundle {
  const slug = name.replace(/\s+/g, '_')
  return {
    listType: 'tasks',
    name,
    visibility: 'all',
    color: null,
    fieldDefs: [],
    statuses: [],
    labels: [],
    series: [],
    items: Array.from({ length: itemCount }, (_, i) => ({
      ref: `ref_${slug}_${i}`,
      title: `${name} item ${i + 1}`,
    })),
  }
}

function buildManifest(overrides: Partial<PlannerManifest> = {}): PlannerManifest {
  return {
    schemaVersion: PLANNER_EXPORT_SCHEMA_VERSION,
    app: 'planner',
    exportedAt: Date.now(),
    lists: [],
    events: [],
    ...overrides,
  }
}

function zipManifest(manifest: PlannerManifest, blobs: Record<string, Uint8Array> = {}): Uint8Array {
  return zipSync({
    [PLANNER_MANIFEST_ENTRY]: new TextEncoder().encode(JSON.stringify(manifest)),
    ...blobs,
  })
}

describe('D1 integration — Planner data export/import', () => {
  let repos: Repos
  let env: Env
  let app: Hono<HonoApp>
  let fakeLists: FakeLists
  let fakeEvents: FakeEvents

  const baseServices = (listsClient: ListsClient, eventsClient: EventsClient): Services => ({
    idClient: {
      verifyRpidBearer: async (bearer: string) => ({ ok: true as const, userId: bearer }),
      signoutRpidBearer: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    },
    rpidSso: {
      exchange: vi.fn().mockResolvedValue({ ok: false, reason: 'invalid' }),
    },
    listsClient,
    eventsClient,
    settings: {
      get: async () => ({}),
      patch: async () => ({}),
    },
  })

  beforeAll(() => {
    repos = buildD1Repos(createDb(testEnv.DB))
    env = parseEnv({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' })
  })

  beforeEach(() => {
    fakeLists = makeFakeLists()
    fakeEvents = makeFakeEvents()
    app = buildApp({
      env,
      logger: undefined,
      repos,
      services: baseServices(fakeLists.client, fakeEvents.client),
    })
  })

  async function loginAs(userId: string): Promise<string> {
    const rawBearer = generateRawToken(PLANNER_SESSION_BEARER_PREFIX)
    const idHash = hashToken(rawBearer)
    const sealed = encryptBearer({
      plaintext: userId,
      aad: idHash,
      env: { PLANNER_SESSION_KEY_V1: env.PLANNER_SESSION_KEY_V1 },
      keyVersion: env.PLANNER_SESSION_KEY_VERSION,
    })
    await repos.sessions.create({
      idHash,
      userId,
      rpidBearerCiphertext: sealed.ciphertext,
      rpidBearerNonce: sealed.nonce,
      rpidBearerKeyVersion: sealed.keyVersion,
      absoluteExpiresAt: new Date(Date.now() + 3_600_000),
      ipHash: '',
      uaHash: '',
    })
    return rawBearer
  }

  function headers(bearer: string, extra?: Record<string, string>): Record<string, string> {
    return {
      cookie: `${env.PLANNER_SESSION_COOKIE_NAME}=${bearer}; ${env.PLANNER_CSRF_COOKIE_NAME}=${CSRF}`,
      'x-rp-csrf': CSRF,
      origin: env.PLANNER_UI_ORIGIN,
      ...extra,
    }
  }

  // Session cookie deliberately omitted; CSRF + Origin are still well-formed
  // so a "requires a session" assertion can't accidentally pass for the
  // wrong (CSRF/origin-rejection) reason.
  function noSessionHeaders(extra?: Record<string, string>): Record<string, string> {
    return {
      cookie: `${env.PLANNER_CSRF_COOKIE_NAME}=${CSRF}`,
      'x-rp-csrf': CSRF,
      origin: env.PLANNER_UI_ORIGIN,
      ...extra,
    }
  }

  async function exportArchive(bearer: string): Promise<Uint8Array> {
    const res = await app.request('http://localhost/api/v1/ui/data-export', {
      headers: headers(bearer),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/zip')
    return new Uint8Array(await res.arrayBuffer())
  }

  async function importArchive(
    bearer: string,
    archive: Uint8Array,
  ): Promise<{ status: number; body: ImportSummary }> {
    const res = await app.request('http://localhost/api/v1/ui/data-import', {
      method: 'POST',
      headers: headers(bearer, { 'content-type': 'application/zip' }),
      body: archive.slice().buffer as ArrayBuffer,
    })
    return { status: res.status, body: (await res.json()) as ImportSummary }
  }

  function manifestOf(archive: Uint8Array): PlannerManifest {
    const files = unzipSync(archive)
    return JSON.parse(new TextDecoder().decode(files[PLANNER_MANIFEST_ENTRY]!)) as PlannerManifest
  }

  // --- export --------------------------------------------------------------

  it('exports one bundle per personal list plus the actor personal events, manifest first', async () => {
    const actor = 'user_exp_basic'
    const bearer = await loginAs(actor)
    const listA = fakeLists.seedList(actor, makeBundle('Errands', 2))
    const listB = fakeLists.seedList(actor, makeBundle('Groceries', 1))
    const created = await fakeEvents.client.createPersonalEvent({ actor, name: 'Road trip' })

    const archive = await exportArchive(bearer)
    const files = unzipSync(archive)

    // manifest.json must be the FIRST entry — the importer plans off it
    // before any blob bytes have arrived.
    expect(Object.keys(files)[0]).toBe('manifest.json')

    const manifest = manifestOf(archive)
    expect(manifest.schemaVersion).toBe(1)
    expect(manifest.app).toBe('planner')
    expect(manifest.lists.map((l) => l.name)).toEqual(['Errands', 'Groceries'])
    expect(manifest.lists[0]!.items).toHaveLength(2)
    expect(manifest.events).toHaveLength(1)
    expect(manifest.events[0]!.name).toBe('Road trip')
    // The dedupe key a re-import will replay is the SOURCE event's own id.
    expect(manifest.events[0]!.ref).toBe(created.id)

    expect(
      fakeLists.calls.filter((c) => c.method === 'exportListBundle').map((c) => c.args[0]),
    ).toEqual([listA, listB])
  })

  it('rides ticket attachments as blobs/... entries matching the downloaded bytes', async () => {
    const actor = 'user_exp_ticket'
    const bearer = await loginAs(actor)
    const ev = await fakeEvents.client.createPersonalEvent({ actor, name: 'Concert' })
    await fakeEvents.client.uploadTicket({
      actor,
      eventId: ev.id,
      file: new Blob([TICKET_BYTES]),
      contentType: 'application/pdf',
      fileName: 'ticket.pdf',
    })

    const archive = await exportArchive(bearer)
    const manifest = manifestOf(archive)
    const files = unzipSync(archive)

    expect(manifest.events[0]!.tickets).toHaveLength(1)
    const ticket = manifest.events[0]!.tickets[0]!
    expect(ticket.blob).toBe(ticketBlobPath(ev.id, 0, 'ticket.pdf'))
    // The manifest's promised blob path must be a real archive entry, and its
    // bytes must be exactly what downloadTicket returned — not re-encoded,
    // truncated, or swapped for a placeholder.
    expect(files[ticket.blob]).toBeDefined()
    expect(files[ticket.blob]).toEqual(TICKET_BYTES)
    expect(fakeEvents.calls.some((c) => c.method === 'downloadTicket')).toBe(true)
  })

  it('skips a list whose exportListBundle throws rather than failing the whole export', async () => {
    const actor = 'user_exp_partial'
    const bearer = await loginAs(actor)
    const goodId = fakeLists.seedList(actor, makeBundle('Good list'))
    const badId = fakeLists.seedList(actor, makeBundle('Bad list'))
    fakeLists.failExport(badId)

    const manifest = manifestOf(await exportArchive(bearer))
    expect(manifest.lists.map((l) => l.name)).toEqual(['Good list'])

    // Both lists were attempted — the failure is caught per-list at export
    // time, not detected upfront and silently excluded.
    const attempted = fakeLists.calls
      .filter((c) => c.method === 'exportListBundle')
      .map((c) => c.args[0])
    expect(attempted).toEqual(expect.arrayContaining([goodId, badId]))
  })

  it('requires a session for export', async () => {
    const res = await app.request('http://localhost/api/v1/ui/data-export', {
      headers: noSessionHeaders(),
    })
    expect(res.status).toBe(401)
  })

  // --- import: happy path + idempotency -------------------------------------

  it('imports an exported archive: importListBundle per list, ref-keyed createPersonalEvent, sensible counts', async () => {
    const actor = 'user_imp_happy'
    const bearer = await loginAs(actor)
    fakeLists.seedList(actor, makeBundle('Errands', 2))
    fakeLists.seedList(actor, makeBundle('Groceries', 3))
    const sourceEvent = await fakeEvents.client.createPersonalEvent({ actor, name: 'Road trip' })

    const archive = await exportArchive(bearer)
    const listCallsBefore = fakeLists.calls.length
    const eventCallsBefore = fakeEvents.calls.length

    const { status, body } = await importArchive(bearer, archive)
    expect(status).toBe(200)

    const importCalls = fakeLists.calls
      .slice(listCallsBefore)
      .filter((c) => c.method === 'importListBundle')
    expect(importCalls).toHaveLength(2)
    for (const c of importCalls) {
      expect(c.args[0]).toMatchObject({ scopeType: 'list_group' })
    }
    // Every bundle imports into the SAME scope: the actor's own resolved
    // personal group (planner-api owns no domain data, so there is nowhere
    // else it could put them).
    const scopeIds = new Set(importCalls.map((c) => (c.args[0] as { scopeId: string }).scopeId))
    expect(scopeIds.size).toBe(1)
    const groupsAfter = await fakeLists.client.listGroups(actor)
    expect(groupsAfter).toHaveLength(1)
    expect(scopeIds).toEqual(new Set([groupsAfter[0]!.id]))

    const createEventCall = fakeEvents.calls
      .slice(eventCallsBefore)
      .find((c) => c.method === 'createPersonalEvent')
    expect(createEventCall?.args[0]).toMatchObject({ ref: sourceEvent.id, name: 'Road trip' })

    // Sensible counts: 2 lists (both "created" per the fake's default
    // result), 2+3=5 items across them, 1 event.
    expect(body.counts['lists']).toEqual({ created: 2, skipped: 0 })
    expect(body.counts['listItems']).toEqual({ created: 5, skipped: 0 })
    expect(body.counts['events']).toEqual({ created: 1, skipped: 0 })
  })

  it('is idempotent: importing the same archive twice skips the event the second time', async () => {
    const actor = 'user_imp_idem'
    const bearer = await loginAs(actor)
    // Events only — list-side idempotency is the Lists SDK's own contract
    // (covered by lists-api's suite); this isolates the BFF's OWN dedupe
    // mechanism, the preExistingEventIds snapshot taken before the loop.
    await fakeEvents.client.createPersonalEvent({ actor, name: 'Anniversary' })
    const archive = await exportArchive(bearer)

    const first = await importArchive(bearer, archive)
    expect(first.status).toBe(200)
    expect(first.body.counts['events']).toEqual({ created: 1, skipped: 0 })

    const second = await importArchive(bearer, archive)
    expect(second.status).toBe(200)
    expect(second.body.counts['events']).toEqual({ created: 0, skipped: 1 })

    // Exactly 2 personal events exist in total: the original + the one the
    // first import created. The re-run created no third copy.
    const all = await fakeEvents.client.listPersonalEvents({ actor })
    expect(all).toHaveLength(2)
  })

  it('does not re-upload a ticket that already matches by fileName + contentType + bytes', async () => {
    const actor = 'user_imp_dedupe'
    const bearer = await loginAs(actor)
    const sourceRef = 'evt_source_dedupe'
    // The target event already exists (as if a previous import, or the
    // regular app, already created it) and already carries the exact ticket
    // the archive is about to (re)offer.
    const existingEvent = await fakeEvents.client.createPersonalEvent({
      actor,
      name: 'Show',
      ref: sourceRef,
    })
    await fakeEvents.client.uploadTicket({
      actor,
      eventId: existingEvent.id,
      file: new Blob([TICKET_BYTES]),
      contentType: 'application/pdf',
      fileName: 'ticket.pdf',
    })

    const blobPath = ticketBlobPath(sourceRef, 0, 'ticket.pdf')
    const manifest = buildManifest({
      events: [
        {
          ref: sourceRef,
          name: 'Show',
          tickets: [
            {
              fileName: 'ticket.pdf',
              contentType: 'application/pdf',
              bytes: TICKET_BYTES.length,
              blob: blobPath,
            },
          ],
        },
      ],
    })
    const archive = zipManifest(manifest, { [blobPath]: TICKET_BYTES })

    const uploadCallsBefore = fakeEvents.calls.filter((c) => c.method === 'uploadTicket').length
    const { status, body } = await importArchive(bearer, archive)
    expect(status).toBe(200)

    const uploadCallsAfter = fakeEvents.calls.filter((c) => c.method === 'uploadTicket').length
    expect(uploadCallsAfter).toBe(uploadCallsBefore) // no new upload happened

    expect(body.counts['eventTickets']).toEqual({ created: 0, skipped: 1 })
    // The event itself replays via the ref collision, so it's a skip too.
    expect(body.counts['events']).toEqual({ created: 0, skipped: 1 })
  })

  it('ignores a blob entry the manifest never references', async () => {
    const bearer = await loginAs('user_imp_unclaimed')
    const manifest = buildManifest({
      events: [{ ref: 'evt_no_ticket', name: 'Plain event', tickets: [] }],
    })
    const archive = zipManifest(manifest, {
      'blobs/stray_unclaimed.bin': new Uint8Array([9, 9, 9]),
    })

    const { status, body } = await importArchive(bearer, archive)
    expect(status).toBe(200)
    // The stray blob was never turned into a ticket upload.
    expect(fakeEvents.calls.some((c) => c.method === 'uploadTicket')).toBe(false)
    expect(body.counts['events']).toEqual({ created: 1, skipped: 0 })
  })

  it('rejects an archive whose manifest is not the first entry, writing nothing', async () => {
    const bearer = await loginAs('user_imp_reorder')
    const manifest = buildManifest({ lists: [makeBundle('Should not land')] })
    const files = unzipSync(zipManifest(manifest))
    // zipSync writes entries in key order, so putting a blob first is enough
    // (mirrors apps/fitness-api/src/routes/data-transfer.d1.test.ts).
    const reordered = zipSync({
      'blobs/stray.bin': new Uint8Array([1, 2, 3]),
      [PLANNER_MANIFEST_ENTRY]: files[PLANNER_MANIFEST_ENTRY]!,
    })

    const res = await app.request('http://localhost/api/v1/ui/data-import', {
      method: 'POST',
      headers: headers(bearer, { 'content-type': 'application/zip' }),
      body: reordered.slice().buffer as ArrayBuffer,
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as ApiErrorBody).error.code).toBe('manifest_not_first')

    expect(fakeLists.calls.some((c) => c.method === 'importListBundle')).toBe(false)
    expect(fakeEvents.calls.some((c) => c.method === 'createPersonalEvent')).toBe(false)
  })

  it('rejects a body that is not a zip at all', async () => {
    const bearer = await loginAs('user_imp_notzip')
    const res = await app.request('http://localhost/api/v1/ui/data-import', {
      method: 'POST',
      headers: headers(bearer, { 'content-type': 'application/zip' }),
      body: new TextEncoder().encode('not a zip file').buffer as ArrayBuffer,
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as ApiErrorBody).error.code).toBe('zip_invalid')
  })

  it('rejects a manifest that fails schema validation', async () => {
    const bearer = await loginAs('user_imp_badschema')
    const bad = zipSync({
      [PLANNER_MANIFEST_ENTRY]: new TextEncoder().encode(
        JSON.stringify({
          schemaVersion: 99,
          app: 'planner',
          exportedAt: Date.now(),
          lists: [],
          events: [],
        }),
      ),
    })
    const res = await app.request('http://localhost/api/v1/ui/data-import', {
      method: 'POST',
      headers: headers(bearer, { 'content-type': 'application/zip' }),
      body: bad.slice().buffer as ArrayBuffer,
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as ApiErrorBody).error.code).toBe('validation_failed')
  })

  it('warns on a list whose importListBundle throws but still imports the rest of the archive', async () => {
    const actor = 'user_imp_listfail'
    const bearer = await loginAs(actor)
    fakeLists.seedList(actor, makeBundle('Good list'))
    fakeLists.seedList(actor, makeBundle('Bad list'))
    await fakeEvents.client.createPersonalEvent({ actor, name: 'Still lands' })
    const archive = await exportArchive(bearer)

    fakeLists.failImport('Bad list')

    const { status, body } = await importArchive(bearer, archive)
    expect(status).toBe(200)
    expect(body.warnings).toContainEqual(
      expect.objectContaining({ entity: 'lists', code: 'list_failed' }),
    )
    // Only the good list counted as created — the bad one threw before any
    // tally call.
    expect(body.counts['lists']).toEqual({ created: 1, skipped: 0 })
    // The event loop runs independently of the list loop, so it still landed.
    expect(body.counts['events']).toEqual({ created: 1, skipped: 0 })
    expect(fakeEvents.calls.some((c) => c.method === 'createPersonalEvent')).toBe(true)
  })

  it('requires a session for import', async () => {
    const res = await app.request('http://localhost/api/v1/ui/data-import', {
      method: 'POST',
      headers: noSessionHeaders({ 'content-type': 'application/zip' }),
      body: zipManifest(buildManifest()).slice().buffer as ArrayBuffer,
    })
    expect(res.status).toBe(401)
  })

  // NOTE: MAX_BUFFERED_TICKET_BYTES (48 MB, apps/planner-api/src/routes/
  // data-import.ts) is intentionally NOT covered here. Exercising the
  // ceiling means streaming an archive whose ticket blobs exceed 48 MB
  // through the D1/workerd test harness, which would make this suite slow
  // for one edge case. Skipped per the task brief's explicit guidance to
  // prefer skipping over a slow test.
})

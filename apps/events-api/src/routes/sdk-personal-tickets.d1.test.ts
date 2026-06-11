import { env } from 'cloudflare:test'
import { describe, it, expect, beforeAll } from 'vitest'
import type { Hono } from 'hono'
import { ulid } from 'ulid'
import { createBindingObjectStore } from '@rallypoint/object-store'
import { TICKET_MAX_BYTES } from '@rallypoint/events-shared'
import { parseEnv, type Env } from '../env.js'
import { buildApp } from '../build-app.js'
import { buildD1Repos, createDb } from '../repos/d1/index.js'
import type { HonoApp } from '../context.js'
import type { Repos } from '../repos/types.js'
import type { Services } from '../services/types.js'
import { makeNoopMoneyClient, makeNoopListsClient } from './_test-services.js'

// Integration tests for the /api/v1/sdk/personal-events/:eventId/tickets*
// surface (Planner slice 3). Migrated to the single-step multipart upload
// against a real Miniflare R2 binding (#409). No presign stubs.

const PLANNER_KEY = 'dev-planner-api-key-do-not-use-in-production-32+chars'

describe('D1 integration — SDK personal-event ticket attachments', () => {
  let repos: Repos
  let envVars: Env
  let app: Hono<HonoApp>

  beforeAll(() => {
    repos = buildD1Repos(createDb(env.DB))
    envVars = parseEnv({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' })

    const services: Services = {
      idClient: {
        verifyRpidBearer: async (bearer: string) => ({ ok: true as const, userId: bearer }),
        signoutRpidBearer: async () => {},
        batchLookupUsers: async () => [],
      },
      rpidSso: {
        exchange: async () => ({ ok: false as const, reason: 'invalid' as const }),
      },
      rpidReauth: {
        verify: async () => ({ ok: true as const }),
      },
      // Real R2 binding — tests the actual put/get/headObject paths (#409).
      objectStore: createBindingObjectStore(env.OBJECT_STORE),
      listsClient: makeNoopListsClient(),
      moneyClient: makeNoopMoneyClient(),
      weather: {
        getEventWeather: async () => ({ forecast: null, airQuality: null, issuedAt: new Date().toISOString() }),
      },
      settings: {
        get: async () => ({}),
        patch: async (_u, _n, patch) => patch,
      },
    } as unknown as Services

    app = buildApp({ env: envVars, logger: undefined, repos, services })
  })

  // --- helpers -------------------------------------------------------

  function sdkHeaders(extraHeaders: Record<string, string> = {}): Record<string, string> {
    return { authorization: `Bearer ${PLANNER_KEY}`, ...extraHeaders }
  }

  async function createPersonalEvent(actor: string): Promise<string> {
    const res = await app.request('http://localhost/api/v1/sdk/personal-events', {
      method: 'POST',
      headers: { ...sdkHeaders({ 'x-actor': actor }), 'content-type': 'application/json' },
      body: JSON.stringify({ name: `Event for ${actor}` }),
    })
    expect(res.status).toBe(201)
    return ((await res.json()) as { id: string }).id
  }

  async function createGroupEvent(actor: string): Promise<string> {
    const id = `event_grp_${Date.now()}_${Math.random().toString(36).slice(2)}`
    await env.DB.prepare(
      `INSERT INTO events (id, tenant_id, owner_user_id, slug, name, timezone, privacy_mode, scope_type)
       VALUES (?, 'rallypoint', ?, ?, 'Group event', 'UTC', 'unlisted', 'group')`,
    )
      .bind(id, actor, `grp-${id}`)
      .run()
    return id
  }

  // Upload a ticket via multipart/form-data and return the created DTO.
  async function uploadTicket(
    actor: string,
    eventId: string,
    opts: { contentType?: string; fileName?: string } = {},
  ): Promise<Response> {
    const contentType = opts.contentType ?? 'application/pdf'
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]) // %PDF magic
    const formData = new FormData()
    formData.append('file', new File([bytes], 'ticket.pdf', { type: contentType }))
    if (opts.fileName) formData.append('fileName', opts.fileName)
    return app.request(
      `http://localhost/api/v1/sdk/personal-events/${eventId}/tickets`,
      {
        method: 'POST',
        headers: sdkHeaders({ 'x-actor': actor }),
        body: formData,
      },
    )
  }

  // --- single-step upload happy path ------------------------------------

  it('upload creates a DB row, stores bytes in R2, and does not expose objectKey', async () => {
    const actor = `user_${ulid()}`
    const eventId = await createPersonalEvent(actor)

    const res = await uploadTicket(actor, eventId, { fileName: 'concert-ticket.pdf' })
    expect(res.status).toBe(201)
    const dto = (await res.json()) as Record<string, unknown>

    expect(dto.id).toMatch(/^pkt_/)
    expect(dto.eventId).toBe(eventId)
    expect(dto.contentType).toBe('application/pdf')
    expect(dto.fileName).toBe('concert-ticket.pdf')
    expect(dto.uploadedByUserId).toBe(actor)
    expect(typeof dto.uploadedAt).toBe('string')
    // objectKey MUST NOT be surfaced.
    expect(dto).not.toHaveProperty('objectKey')

    // DB row exists with correct metadata.
    const { results } = await env.DB.prepare(
      'SELECT id, event_id, bytes, file_name, content_type FROM personal_tickets WHERE id = ?',
    )
      .bind(dto.id as string)
      .all()
    expect(results).toHaveLength(1)
    expect(results[0]!.file_name).toBe('concert-ticket.pdf')
    expect(results[0]!.content_type).toBe('application/pdf')

    // Object must be in R2.
    const row = await repos.personalTickets.findById(dto.id as string)
    const r2obj = await env.OBJECT_STORE.head(row!.objectKey)
    expect(r2obj).not.toBeNull()
    expect(r2obj!.httpMetadata?.contentType).toBe('application/pdf')
  })

  it('upload without fileName stores null', async () => {
    const actor = `user_${ulid()}`
    const eventId = await createPersonalEvent(actor)
    const res = await uploadTicket(actor, eventId)
    expect(res.status).toBe(201)
    const dto = (await res.json()) as Record<string, unknown>
    expect(dto.fileName).toBeNull()
  })

  it('upload rejects unsupported mime type', async () => {
    const actor = `user_${ulid()}`
    const eventId = await createPersonalEvent(actor)
    const res = await uploadTicket(actor, eventId, { contentType: 'video/mp4' })
    expect(res.status).toBeGreaterThanOrEqual(400)
  })

  it('upload rejects an oversize file before storing anything', async () => {
    const actor = `user_${ulid()}`
    const eventId = await createPersonalEvent(actor)
    const before = (await env.OBJECT_STORE.list()).objects.length
    const formData = new FormData()
    formData.append('file', new File([new Uint8Array(TICKET_MAX_BYTES + 1)], 'big.pdf', { type: 'application/pdf' }))
    const res = await app.request(
      `http://localhost/api/v1/sdk/personal-events/${eventId}/tickets`,
      { method: 'POST', headers: sdkHeaders({ 'x-actor': actor }), body: formData },
    )
    expect(res.status).toBe(400)
    // Validation runs before put — nothing should have landed in R2.
    expect((await env.OBJECT_STORE.list()).objects.length).toBe(before)
  })

  // --- download (streaming serve) -------------------------------------------

  it('download streams the stored bytes (200 with correct content-type)', async () => {
    const actor = `user_${ulid()}`
    const eventId = await createPersonalEvent(actor)

    const uploadRes = await uploadTicket(actor, eventId, { fileName: 'receipt.pdf' })
    expect(uploadRes.status).toBe(201)
    const { id: ticketId } = (await uploadRes.json()) as { id: string }

    const dlRes = await app.request(
      `http://localhost/api/v1/sdk/personal-events/${eventId}/tickets/${ticketId}/download`,
      { method: 'GET', headers: sdkHeaders({ 'x-actor': actor }) },
    )
    expect(dlRes.status).toBe(200)
    expect(dlRes.headers.get('Content-Type')).toBe('application/pdf')
    // Body should be the bytes we uploaded.
    const body = new Uint8Array(await dlRes.arrayBuffer())
    expect(body[0]).toBe(0x25) // %PDF magic byte
  })

  it('download 404s for a ticket belonging to a different event', async () => {
    const actor = `user_${ulid()}`
    const eventA = await createPersonalEvent(actor)
    const eventB = await createPersonalEvent(actor)

    const uploadRes = await uploadTicket(actor, eventA)
    expect(uploadRes.status).toBe(201)
    const { id: ticketId } = (await uploadRes.json()) as { id: string }

    const dlRes = await app.request(
      `http://localhost/api/v1/sdk/personal-events/${eventB}/tickets/${ticketId}/download`,
      { method: 'GET', headers: sdkHeaders({ 'x-actor': actor }) },
    )
    expect(dlRes.status).toBe(404)
  })

  // --- ownership gate ---------------------------------------------------

  it("upload/list/download 404 for another actor's personal event", async () => {
    const owner = `user_${ulid()}`
    const other = `user_${ulid()}`
    const eventId = await createPersonalEvent(owner)

    const uploadRes = await uploadTicket(other, eventId)
    expect(uploadRes.status).toBe(404)

    const listRes = await app.request(
      `http://localhost/api/v1/sdk/personal-events/${eventId}/tickets`,
      { method: 'GET', headers: sdkHeaders({ 'x-actor': other }) },
    )
    expect(listRes.status).toBe(404)
  })

  it('upload 404s for a group-scope event even if the actor is the owner', async () => {
    const actor = `user_${ulid()}`
    const groupEventId = await createGroupEvent(actor)
    const res = await uploadTicket(actor, groupEventId)
    expect(res.status).toBe(404)
  })

  // --- key gate (PLANNER_API_KEY) ----------------------------------------

  it('403s when the PLANNER bearer is missing on ticket routes', async () => {
    const res = await app.request(
      'http://localhost/api/v1/sdk/personal-events/event_fake/tickets',
      { method: 'GET', headers: { 'x-actor': 'user_fake' } },
    )
    expect(res.status).toBe(403)
  })

  // --- list ---------------------------------------------------------------

  it('list returns only that event\'s tickets and excludes other events\' tickets', async () => {
    const actor = `user_${ulid()}`
    const eventA = await createPersonalEvent(actor)
    const eventB = await createPersonalEvent(actor)

    await uploadTicket(actor, eventA)
    await uploadTicket(actor, eventB, { contentType: 'image/jpeg' })

    const res = await app.request(
      `http://localhost/api/v1/sdk/personal-events/${eventA}/tickets`,
      { method: 'GET', headers: sdkHeaders({ 'x-actor': actor }) },
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: Array<Record<string, unknown>> }
    expect(body.items).toHaveLength(1)
    expect(body.items[0]!.eventId).toBe(eventA)
    expect(body.items[0]!.contentType).toBe('application/pdf')
    // objectKey must not be in the list response.
    expect(body.items[0]).not.toHaveProperty('objectKey')
  })
})

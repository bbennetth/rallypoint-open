import { env } from 'cloudflare:test'
import { makeStubObjectStore } from './_test-services.js'
import { describe, it, expect, beforeAll } from 'vitest'
import type { Hono } from 'hono'
import { parseEnv, type Env } from '../env.js'
import { buildApp } from '../build-app.js'
import { buildD1Repos, createDb } from '../repos/d1/index.js'
import type { HonoApp } from '../context.js'
import type { Repos } from '../repos/types.js'
import type { Services } from '../services/types.js'
import { generateRawToken, hashToken } from '@rallypoint/crypto'
import { encryptBearer } from '../crypto/encryption.js'
import { EVENTS_SESSION_BEARER_PREFIX } from '../middleware/session.js'

// Integration tests for the sessions (activities) surface + approval
// workflow against a real Postgres (testcontainers). Same stub harness
// as lineup.it.test.ts: the id-client verifier echoes the decrypted
// bearer back as the user id.


const CSRF = 'csrf_token_value_aaaaaaaaaaaaaaaaaaaaaaaaaa'

interface SessionJson {
  id: string
  title: string
  day_id: string | null
  stage_id: string | null
  approval_status: string
  visibility: string
  start_time: string | null
  submitted_by_user_id: string | null
  approved_by_user_id: string | null
}

describe('D1 integration — sessions (event_sessions + approval workflow)', () => {
  let repos: Repos
  let envVars: Env
  let app: Hono<HonoApp>

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
    objectStore: makeStubObjectStore(),
    weather: {
      getEventWeather: async () => ({ forecast: null, airQuality: null, issuedAt: new Date().toISOString() }),
    },
    settings: {
      get: async () => ({}),
      patch: async (_u, _n, patch) => patch,
    },
  }

  beforeAll(() => {
    repos = buildD1Repos(createDb(env.DB))
    envVars = parseEnv({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' })
    app = buildApp({ env: envVars, logger: undefined, repos, services })
  })


  async function loginAs(userId: string): Promise<string> {
    const rawBearer = generateRawToken(EVENTS_SESSION_BEARER_PREFIX)
    const idHash = hashToken(rawBearer)
    const sealed = encryptBearer({
      plaintext: userId,
      aad: idHash,
      env: { EVENTS_SESSION_KEY_V1: envVars.EVENTS_SESSION_KEY_V1 },
      keyVersion: envVars.EVENTS_SESSION_KEY_VERSION,
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

  function headers(bearer: string): Record<string, string> {
    return {
      cookie: `${envVars.EVENTS_SESSION_COOKIE_NAME}=${bearer}; ${envVars.EVENTS_CSRF_COOKIE_NAME}=${CSRF}`,
      'x-rp-csrf': CSRF,
      'content-type': 'application/json',
    }
  }

  async function req(
    bearer: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    return app.request(`http://localhost${path}`, {
      method,
      headers: headers(bearer),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  }

  async function createEvent(bearer: string, name: string): Promise<string> {
    const res = await req(bearer, 'POST', '/api/v1/ui/events', { name, timezone: 'UTC' })
    expect(res.status).toBe(201)
    return ((await res.json()) as { id: string }).id
  }

  it('owner-created sessions are auto-approved and CRUD round-trips', async () => {
    const owner = `user_${Date.now()}_owncrud`
    const bearer = await loginAs(owner)
    const eventId = await createEvent(bearer, 'Sessions Fest')

    const created = await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/sessions`, {
      title: 'Sunrise Yoga',
      category: 'yoga',
      startTime: '06:30',
    })
    expect(created.status).toBe(201)
    const session = (await created.json()) as SessionJson
    expect(session.title).toBe('Sunrise Yoga')
    expect(session.approval_status).toBe('approved')
    expect(session.approved_by_user_id).toBe(owner)
    expect(session.visibility).toBe('group')
    expect(session.start_time).toBe('06:30')

    // Fetch one.
    const got = await req(bearer, 'GET', `/api/v1/ui/events/${eventId}/sessions/${session.id}`)
    expect(got.status).toBe(200)
    expect(((await got.json()) as SessionJson).title).toBe('Sunrise Yoga')

    // Patch the title.
    const patched = await req(
      bearer,
      'PATCH',
      `/api/v1/ui/events/${eventId}/sessions/${session.id}`,
      { title: 'Sunset Yoga' },
    )
    expect(patched.status).toBe(200)
    expect(((await patched.json()) as SessionJson).title).toBe('Sunset Yoga')

    // List shows it.
    const list = (await (
      await req(bearer, 'GET', `/api/v1/ui/events/${eventId}/sessions`)
    ).json()) as { items: SessionJson[] }
    expect(list.items.map((s) => s.id)).toContain(session.id)

    // Soft-delete removes it from the default list.
    const del = await req(bearer, 'DELETE', `/api/v1/ui/events/${eventId}/sessions/${session.id}`)
    expect(del.status).toBe(204)
    const after = (await (
      await req(bearer, 'GET', `/api/v1/ui/events/${eventId}/sessions`)
    ).json()) as { items: SessionJson[] }
    expect(after.items.map((s) => s.id)).not.toContain(session.id)

    const activity = (await repos.activity.listForEvent(eventId)).map((a) => a.eventType)
    expect(activity).toContain('event.session_created')
    expect(activity).toContain('event.session_updated')
    expect(activity).toContain('event.session_deleted')
  })

  it('editor-created sessions enter the queue as pending; owner approves', async () => {
    const owner = `user_${Date.now()}_appr`
    const editor = `${owner}_editor`
    const ownerBearer = await loginAs(owner)
    const editorBearer = await loginAs(editor)
    const eventId = await createEvent(ownerBearer, 'Approval Fest')
    await repos.members.add({ id: `evm_${Date.now()}_e`, eventId, userId: editor, role: 'editor' })

    const created = await req(editorBearer, 'POST', `/api/v1/ui/events/${eventId}/sessions`, {
      title: 'Editor Panel',
    })
    expect(created.status).toBe(201)
    const session = (await created.json()) as SessionJson
    expect(session.approval_status).toBe('pending')
    expect(session.submitted_by_user_id).toBe(editor)
    expect(session.approved_by_user_id).toBeNull()

    // Editor cannot approve their own session → 403 session_approval_required.
    const editorApprove = await req(
      editorBearer,
      'POST',
      `/api/v1/ui/events/${eventId}/sessions/${session.id}/approve`,
    )
    expect(editorApprove.status).toBe(403)
    expect(((await editorApprove.json()) as { error: { code: string } }).error.code).toBe(
      'session_approval_required',
    )

    // Owner approves.
    const approve = await req(
      ownerBearer,
      'POST',
      `/api/v1/ui/events/${eventId}/sessions/${session.id}/approve`,
    )
    expect(approve.status).toBe(200)
    const approved = (await approve.json()) as SessionJson
    expect(approved.approval_status).toBe('approved')
    expect(approved.approved_by_user_id).toBe(owner)

    // Filter list by pending — should now be empty.
    const pending = (await (
      await req(ownerBearer, 'GET', `/api/v1/ui/events/${eventId}/sessions?approval_status=pending`)
    ).json()) as { items: SessionJson[] }
    expect(pending.items.map((s) => s.id)).not.toContain(session.id)
  })

  it('owner rejects, editor re-submits to pending', async () => {
    const owner = `user_${Date.now()}_reject`
    const editor = `${owner}_editor`
    const ownerBearer = await loginAs(owner)
    const editorBearer = await loginAs(editor)
    const eventId = await createEvent(ownerBearer, 'Reject Fest')
    await repos.members.add({ id: `evm_${Date.now()}_r`, eventId, userId: editor, role: 'editor' })

    const session = (await (
      await req(editorBearer, 'POST', `/api/v1/ui/events/${eventId}/sessions`, { title: 'Maybe' })
    ).json()) as SessionJson

    const reject = await req(
      ownerBearer,
      'POST',
      `/api/v1/ui/events/${eventId}/sessions/${session.id}/reject`,
    )
    expect(reject.status).toBe(200)
    expect(((await reject.json()) as SessionJson).approval_status).toBe('rejected')

    // Editor re-submits → back to pending; the stale approver stamp is
    // cleared and the (re)submitter is recorded.
    const resubmit = await req(
      editorBearer,
      'POST',
      `/api/v1/ui/events/${eventId}/sessions/${session.id}/submit`,
    )
    expect(resubmit.status).toBe(200)
    const resubmitted = (await resubmit.json()) as SessionJson
    expect(resubmitted.approval_status).toBe('pending')
    expect(resubmitted.approved_by_user_id).toBeNull()
    expect(resubmitted.submitted_by_user_id).toBe(editor)
  })

  it('refuses to re-submit a session that is not rejected', async () => {
    const owner = `user_${Date.now()}_resub_guard`
    const editor = `${owner}_editor`
    const ownerBearer = await loginAs(owner)
    const editorBearer = await loginAs(editor)
    const eventId = await createEvent(ownerBearer, 'Resubmit Guard Fest')
    await repos.members.add({ id: `evm_${Date.now()}_rg`, eventId, userId: editor, role: 'editor' })

    // Editor creates → pending. Owner approves.
    const session = (await (
      await req(editorBearer, 'POST', `/api/v1/ui/events/${eventId}/sessions`, { title: 'Locked' })
    ).json()) as SessionJson
    const approve = await req(
      ownerBearer,
      'POST',
      `/api/v1/ui/events/${eventId}/sessions/${session.id}/approve`,
    )
    expect(approve.status).toBe(200)

    // An editor cannot submit an approved session back to pending.
    const resubmit = await req(
      editorBearer,
      'POST',
      `/api/v1/ui/events/${eventId}/sessions/${session.id}/submit`,
    )
    expect(resubmit.status).toBe(409)
    expect(((await resubmit.json()) as { error: { code: string } }).error.code).toBe(
      'session_not_rejected',
    )

    // The owner's approval is intact.
    const after = (await (
      await req(ownerBearer, 'GET', `/api/v1/ui/events/${eventId}/sessions/${session.id}`)
    ).json()) as SessionJson
    expect(after.approval_status).toBe('approved')
    expect(after.approved_by_user_id).toBe(owner)
  })

  it('PATCH cannot move approval state (setApproval is the sole writer)', async () => {
    const owner = `user_${Date.now()}_patch_appr`
    const editor = `${owner}_editor`
    const ownerBearer = await loginAs(owner)
    const editorBearer = await loginAs(editor)
    const eventId = await createEvent(ownerBearer, 'Patch Approval Fest')
    await repos.members.add({ id: `evm_${Date.now()}_pa`, eventId, userId: editor, role: 'editor' })

    // Editor creates → pending.
    const session = (await (
      await req(editorBearer, 'POST', `/api/v1/ui/events/${eventId}/sessions`, { title: 'Sneaky' })
    ).json()) as SessionJson
    expect(session.approval_status).toBe('pending')

    // Smuggle approval columns through PATCH — they must be ignored.
    const patched = await req(
      editorBearer,
      'PATCH',
      `/api/v1/ui/events/${eventId}/sessions/${session.id}`,
      { title: 'Renamed', approval_status: 'approved', approved_by_user_id: editor },
    )
    expect(patched.status).toBe(200)
    const result = (await patched.json()) as SessionJson
    expect(result.title).toBe('Renamed')
    expect(result.approval_status).toBe('pending')
    expect(result.approved_by_user_id).toBeNull()
  })

  it('rejects a session referencing a day from another event', async () => {
    const owner = `user_${Date.now()}_xday`
    const bearer = await loginAs(owner)
    const eventA = await createEvent(bearer, 'Sess Event A')
    const eventB = await createEvent(bearer, 'Sess Event B')

    const dayB = (await (
      await req(bearer, 'POST', `/api/v1/ui/events/${eventB}/days`, {
        dayLabel: 'Day 1',
        date: '2026-10-01',
      })
    ).json()) as { id: string }

    const wrong = await req(bearer, 'POST', `/api/v1/ui/events/${eventA}/sessions`, {
      title: 'Wrong Day',
      dayId: dayB.id,
    })
    expect(wrong.status).toBe(400)
    expect(((await wrong.json()) as { error: { code: string } }).error.code).toBe('day_not_in_event')
  })

  it('nulls day_id when the assigned day is deleted; cascades on event purge', async () => {
    const owner = `user_${Date.now()}_cascade`
    const bearer = await loginAs(owner)
    const eventId = await createEvent(bearer, 'Sess Cascade Fest')

    const day = (await (
      await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/days`, {
        dayLabel: 'Day 1',
        date: '2026-11-01',
      })
    ).json()) as { id: string }
    const session = (await (
      await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/sessions`, {
        title: 'Day-bound',
        dayId: day.id,
      })
    ).json()) as SessionJson
    expect(session.day_id).toBe(day.id)

    // Deleting the day SET NULLs the session's day_id (session survives).
    await req(bearer, 'DELETE', `/api/v1/ui/events/${eventId}/days/${day.id}`)
    const after = (await (
      await req(bearer, 'GET', `/api/v1/ui/events/${eventId}/sessions/${session.id}`)
    ).json()) as SessionJson
    expect(after.day_id).toBeNull()

    // Hard-purge the event — sessions cascade away.
    await repos.events.hardDelete(eventId)
    expect(await repos.eventSessions.findById(session.id)).toBeNull()
  })

  it('gates mutations to editors and reads to viewers; stranger 404s', async () => {
    const owner = `user_${Date.now()}_gate`
    const viewer = `${owner}_viewer`
    const stranger = `${owner}_stranger`
    const ownerBearer = await loginAs(owner)
    const viewerBearer = await loginAs(viewer)
    const strangerBearer = await loginAs(stranger)
    const eventId = await createEvent(ownerBearer, 'Sess Gate Fest')
    await repos.members.add({ id: `evm_${Date.now()}_v`, eventId, userId: viewer, role: 'viewer' })

    // Viewer reads.
    expect((await req(viewerBearer, 'GET', `/api/v1/ui/events/${eventId}/sessions`)).status).toBe(200)

    // Viewer cannot create → 403.
    const viewerWrite = await req(viewerBearer, 'POST', `/api/v1/ui/events/${eventId}/sessions`, {
      title: 'Nope',
    })
    expect(viewerWrite.status).toBe(403)

    // Stranger gets 404 (existence not leaked).
    const strangerRead = await req(strangerBearer, 'GET', `/api/v1/ui/events/${eventId}/sessions`)
    expect(strangerRead.status).toBe(404)
  })

  // --- bulk endpoint tests -------------------------------------------

  it('bulk: create + update + delete in one call; audit row written', async () => {
    const owner = `user_${Date.now()}_bulk_crud`
    const bearer = await loginAs(owner)
    const eventId = await createEvent(bearer, 'Bulk Fest')

    // Pre-create two sessions via the single endpoint.
    const s1 = (await (
      await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/sessions`, { title: 'Alpha' })
    ).json()) as SessionJson
    const s2 = (await (
      await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/sessions`, { title: 'Beta' })
    ).json()) as SessionJson

    // Bulk: create one new, update s1's title, delete s2.
    const bulk = await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/sessions/bulk`, {
      creates: [{ title: 'Gamma', startTime: '09:00' }],
      updates: [{ id: s1.id, patch: { title: 'Alpha Updated', category: 'workshop' } }],
      deletes: [s2.id],
    })
    expect(bulk.status).toBe(200)
    const bulkBody = (await bulk.json()) as { items: SessionJson[] }
    expect(bulkBody.items).toHaveLength(2) // created + updated

    // The created session should be owner-approved.
    const created = bulkBody.items.find((s) => s.title === 'Gamma')
    expect(created).toBeDefined()
    expect(created!.approval_status).toBe('approved')
    expect(created!.start_time).toBe('09:00')

    // The updated session should reflect the new title/category.
    const updatedItem = bulkBody.items.find((s) => s.id === s1.id)
    expect(updatedItem).toBeDefined()
    expect(updatedItem!.title).toBe('Alpha Updated')

    // Verify DB state: s2 should be soft-deleted.
    const afterList = (await (
      await req(bearer, 'GET', `/api/v1/ui/events/${eventId}/sessions`)
    ).json()) as { items: SessionJson[] }
    const ids = afterList.items.map((s) => s.id)
    expect(ids).not.toContain(s2.id)
    expect(ids).toContain(s1.id)
    expect(afterList.items.find((s) => s.title === 'Gamma')).toBeDefined()

    // Audit row must be present.
    const activity = (await repos.activity.listForEvent(eventId)).map((a) => a.eventType)
    expect(activity).toContain('event.sessions_bulk_updated')
  })

  it('bulk: cross-event dayId rejected', async () => {
    const owner = `user_${Date.now()}_bulk_xday`
    const bearer = await loginAs(owner)
    const eventA = await createEvent(bearer, 'Bulk Event A')
    const eventB = await createEvent(bearer, 'Bulk Event B')

    const dayB = (await (
      await req(bearer, 'POST', `/api/v1/ui/events/${eventB}/days`, {
        dayLabel: 'Day 1',
        date: '2026-09-01',
      })
    ).json()) as { id: string }

    const res = await req(bearer, 'POST', `/api/v1/ui/events/${eventA}/sessions/bulk`, {
      creates: [{ title: 'Wrong Day', dayId: dayB.id }],
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('day_not_in_event')
  })

  it('bulk: cross-event dayId in update rejected', async () => {
    const owner = `user_${Date.now()}_bulk_xday_upd`
    const bearer = await loginAs(owner)
    const eventA = await createEvent(bearer, 'Bulk Update A')
    const eventB = await createEvent(bearer, 'Bulk Update B')

    const session = (await (
      await req(bearer, 'POST', `/api/v1/ui/events/${eventA}/sessions`, { title: 'Moving' })
    ).json()) as SessionJson

    const dayB = (await (
      await req(bearer, 'POST', `/api/v1/ui/events/${eventB}/days`, {
        dayLabel: 'Day X',
        date: '2026-09-15',
      })
    ).json()) as { id: string }

    const res = await req(bearer, 'POST', `/api/v1/ui/events/${eventA}/sessions/bulk`, {
      updates: [{ id: session.id, patch: { dayId: dayB.id } }],
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('day_not_in_event')
  })

  it('bulk: owner-created → approved; editor-created → pending', async () => {
    const owner = `user_${Date.now()}_bulk_appr`
    const editor = `${owner}_editor`
    const ownerBearer = await loginAs(owner)
    const editorBearer = await loginAs(editor)
    const eventId = await createEvent(ownerBearer, 'Bulk Approval Fest')
    await repos.members.add({
      id: `evm_${Date.now()}_be`,
      eventId,
      userId: editor,
      role: 'editor',
    })

    // Owner bulk-creates.
    const ownerBulk = await req(ownerBearer, 'POST', `/api/v1/ui/events/${eventId}/sessions/bulk`, {
      creates: [{ title: 'Owner Session' }],
    })
    expect(ownerBulk.status).toBe(200)
    const ownerItems = ((await ownerBulk.json()) as { items: SessionJson[] }).items
    expect(ownerItems[0]!.approval_status).toBe('approved')
    expect(ownerItems[0]!.approved_by_user_id).toBe(owner)

    // Editor bulk-creates.
    const editorBulk = await req(
      editorBearer,
      'POST',
      `/api/v1/ui/events/${eventId}/sessions/bulk`,
      { creates: [{ title: 'Editor Session' }] },
    )
    expect(editorBulk.status).toBe(200)
    const editorItems = ((await editorBulk.json()) as { items: SessionJson[] }).items
    expect(editorItems[0]!.approval_status).toBe('pending')
    expect(editorItems[0]!.submitted_by_user_id).toBe(editor)
    expect(editorItems[0]!.approved_by_user_id).toBeNull()
  })

  it('bulk: validation — empty payload rejected', async () => {
    const owner = `user_${Date.now()}_bulk_empty`
    const bearer = await loginAs(owner)
    const eventId = await createEvent(bearer, 'Bulk Empty Fest')

    const res = await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/sessions/bulk`, {})
    expect(res.status).toBe(400)
  })

  it('bulk: viewer cannot call bulk endpoint', async () => {
    const owner = `user_${Date.now()}_bulk_viewer`
    const viewer = `${owner}_viewer`
    const ownerBearer = await loginAs(owner)
    const viewerBearer = await loginAs(viewer)
    const eventId = await createEvent(ownerBearer, 'Bulk Viewer Fest')
    await repos.members.add({
      id: `evm_${Date.now()}_bv`,
      eventId,
      userId: viewer,
      role: 'viewer',
    })

    const res = await req(viewerBearer, 'POST', `/api/v1/ui/events/${eventId}/sessions/bulk`, {
      creates: [{ title: 'Should fail' }],
    })
    expect(res.status).toBe(403)
  })

  it('stage round-trip: create with stageId, patch it, clear it (#215)', async () => {
    const owner = `user_${Date.now()}_stage`
    const bearer = await loginAs(owner)
    const eventId = await createEvent(bearer, 'Stage Sessions Fest')

    const stage = (await (
      await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/stages`, { name: 'Main' })
    ).json()) as { id: string }
    const stage2 = (await (
      await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/stages`, { name: 'Wellness' })
    ).json()) as { id: string }

    const created = await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/sessions`, {
      title: 'Main Stage Talk',
      stageId: stage.id,
    })
    expect(created.status).toBe(201)
    const session = (await created.json()) as SessionJson
    expect(session.stage_id).toBe(stage.id)

    // Reassign to another stage.
    const moved = await req(
      bearer,
      'PATCH',
      `/api/v1/ui/events/${eventId}/sessions/${session.id}`,
      { stageId: stage2.id },
    )
    expect(moved.status).toBe(200)
    expect(((await moved.json()) as SessionJson).stage_id).toBe(stage2.id)

    // Clear with explicit null.
    const cleared = await req(
      bearer,
      'PATCH',
      `/api/v1/ui/events/${eventId}/sessions/${session.id}`,
      { stageId: null },
    )
    expect(cleared.status).toBe(200)
    expect(((await cleared.json()) as SessionJson).stage_id).toBeNull()
  })

  it('rejects a session referencing a stage from another event', async () => {
    const owner = `user_${Date.now()}_xstage`
    const bearer = await loginAs(owner)
    const eventA = await createEvent(bearer, 'Stage Event A')
    const eventB = await createEvent(bearer, 'Stage Event B')

    const stageB = (await (
      await req(bearer, 'POST', `/api/v1/ui/events/${eventB}/stages`, { name: 'Foreign' })
    ).json()) as { id: string }

    const wrong = await req(bearer, 'POST', `/api/v1/ui/events/${eventA}/sessions`, {
      title: 'Wrong Stage',
      stageId: stageB.id,
    })
    expect(wrong.status).toBe(400)
    expect(((await wrong.json()) as { error: { code: string } }).error.code).toBe(
      'stage_not_in_event',
    )

    // Same check on the bulk path (create + update).
    const ok = (await (
      await req(bearer, 'POST', `/api/v1/ui/events/${eventA}/sessions`, { title: 'Fixable' })
    ).json()) as SessionJson
    const bulkCreate = await req(bearer, 'POST', `/api/v1/ui/events/${eventA}/sessions/bulk`, {
      creates: [{ title: 'Bulk Wrong', stageId: stageB.id }],
    })
    expect(bulkCreate.status).toBe(400)
    const bulkUpdate = await req(bearer, 'POST', `/api/v1/ui/events/${eventA}/sessions/bulk`, {
      updates: [{ id: ok.id, patch: { stageId: stageB.id } }],
    })
    expect(bulkUpdate.status).toBe(400)
  })

  it('nulls stage_id when the assigned stage is deleted (session survives)', async () => {
    const owner = `user_${Date.now()}_stagedel`
    const bearer = await loginAs(owner)
    const eventId = await createEvent(bearer, 'Stage Delete Fest')

    const stage = (await (
      await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/stages`, { name: 'Doomed' })
    ).json()) as { id: string }
    const session = (await (
      await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/sessions`, {
        title: 'Stage-bound',
        stageId: stage.id,
      })
    ).json()) as SessionJson
    expect(session.stage_id).toBe(stage.id)

    await req(bearer, 'DELETE', `/api/v1/ui/events/${eventId}/stages/${stage.id}`)
    const after = (await (
      await req(bearer, 'GET', `/api/v1/ui/events/${eventId}/sessions/${session.id}`)
    ).json()) as SessionJson
    expect(after.stage_id).toBeNull()
  })

  it('bulk: creates carry stageId through to the stored rows', async () => {
    const owner = `user_${Date.now()}_bulkstage`
    const bearer = await loginAs(owner)
    const eventId = await createEvent(bearer, 'Bulk Stage Fest')
    const stage = (await (
      await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/stages`, { name: 'Main' })
    ).json()) as { id: string }

    const res = await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/sessions/bulk`, {
      creates: [
        { title: 'Staged A', stageId: stage.id },
        { title: 'Unstaged B' },
      ],
    })
    expect(res.status).toBe(200)
    const { items } = (await res.json()) as { items: SessionJson[] }
    const staged = items.find((i) => i.title === 'Staged A')!
    const unstaged = items.find((i) => i.title === 'Unstaged B')!
    expect(staged.stage_id).toBe(stage.id)
    expect(unstaged.stage_id).toBeNull()
  })
})

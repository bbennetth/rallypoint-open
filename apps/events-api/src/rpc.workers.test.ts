import { env, createExecutionContext } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { ulid } from 'ulid'
import { EventsRPC } from './rpc.js'

// Cross-Worker RPC contract tests for EventsRPC (feat/rpc-bindings PR 1).
// Drives the WorkerEntrypoint directly against real D1. The HTTP routes
// keep their own d1.test.ts coverage; these tests focus on the typed
// RPC surface that planner-api will switch to in PR 2.

const TENANT = 'rallypoint'

async function clearAll(): Promise<void> {
  for (const t of [
    'personal_tickets',
    'event_planner_prefs',
    'event_attendees',
    'event_members',
    'event_days',
    'events',
    'event_weather',
    'rate_limits',
    'sessions',
  ]) {
    try {
      await env.DB.exec(`DELETE FROM ${t}`)
    } catch {
      // tolerate tables that may not exist in this schema slice
    }
  }
}
beforeEach(clearAll)

function rpc(): EventsRPC {
  return new EventsRPC(createExecutionContext(), env as never)
}

const actor = (): string => `user_${ulid()}`

describe('EventsRPC personal events', () => {
  it('round-trips create / get / list / patch / delete', async () => {
    const me = actor()
    const created = await rpc().createPersonalEvent(me, { name: 'My event' })
    expect(created.scopeType).toBe('personal')
    expect(created.ownerUserId).toBe(me)

    const got = await rpc().getPersonalEvent(me, created.id)
    expect(got.kind).toBe('ok')

    const listed = await rpc().listPersonalEvents(me, {})
    expect(listed.map((e) => e.id)).toContain(created.id)

    const patched = await rpc().patchPersonalEvent(me, created.id, { name: 'Renamed' })
    expect(patched.kind).toBe('ok')
    if (patched.kind === 'ok') {
      expect(patched.data.name).toBe('Renamed')
    }

    const deleted = await rpc().deletePersonalEvent(me, created.id)
    expect(deleted.kind).toBe('ok')

    const afterDelete = await rpc().getPersonalEvent(me, created.id)
    expect(afterDelete.kind).toBe('not_found')
  })

  it('hides events owned by someone else (opaque 404)', async () => {
    const owner = actor()
    const other = actor()
    const created = await rpc().createPersonalEvent(owner, { name: 'Mine' })
    const result = await rpc().getPersonalEvent(other, created.id)
    expect(result).toEqual({ kind: 'not_found' })
  })
})

describe('EventsRPC.listHolidays', () => {
  it('returns the federal holidays inside the window', async () => {
    const holidays = await rpc().listHolidays('2026-06-01', '2026-09-15')
    expect(Array.isArray(holidays)).toBe(true)
    expect(holidays.some((h) => h.name.toLowerCase().includes('independence'))).toBe(true)
  })
})

describe('EventsRPC.setPlannerPref + getPlannerEvents', () => {
  it('returns not_found when the event is not visible to the actor', async () => {
    const someone = actor()
    const result = await rpc().setPlannerPref(someone, 'event_doesnotexist', true)
    expect(result).toEqual({ kind: 'not_found' })
  })
})

describe('EventsRPC.listUserEvents', () => {
  it('returns [] for an actor with no group events', async () => {
    const me = actor()
    const events = await rpc().listUserEvents(me)
    expect(events).toEqual([])
  })
})

describe('EventsRPC.getCoordinateWeather validation', () => {
  it('rejects bad lat/lng', async () => {
    const result = await rpc().getCoordinateWeather({ lat: 999, lng: 0 })
    expect(result.kind).toBe('bad_latlng')
  })

  it('rejects a bad timezone', async () => {
    const result = await rpc().getCoordinateWeather({ lat: 0, lng: 0, tz: 'Not/A/Real_TZ' })
    expect(result.kind).toBe('bad_tz')
  })

  it('rejects a bad date', async () => {
    const result = await rpc().getCoordinateWeather({ lat: 0, lng: 0, date: 'tomorrow' })
    expect(result.kind).toBe('bad_date')
  })
})

describe('EventsRPC admin system events', () => {
  // Bound in vitest.d1.config.ts (miniflare bindings).
  const ADMIN = 'user_rpc_admin_test'

  it('rejects a non-allowlisted actor on every method', async () => {
    const outsider = actor()
    expect(await rpc().adminListSystemEvents(outsider)).toEqual({ kind: 'forbidden' })
    expect(await rpc().adminCreateSystemEvent(outsider, { name: 'X', timezone: 'UTC' })).toEqual({
      kind: 'forbidden',
    })
    expect(await rpc().adminGetSystemEvent(outsider, 'event_x')).toEqual({ kind: 'forbidden' })
    expect(await rpc().adminPatchSystemEvent(outsider, 'event_x', { name: 'Y' })).toEqual({
      kind: 'forbidden',
    })
    expect(await rpc().adminDeleteSystemEvent(outsider, 'event_x')).toEqual({ kind: 'forbidden' })
  })

  it('creates a sentinel-owned event and round-trips list / get / patch / delete / restore', async () => {
    const created = await rpc().adminCreateSystemEvent(ADMIN, {
      name: 'System Fest',
      timezone: 'UTC',
      privacyMode: 'public',
    })
    expect(created.kind).toBe('ok')
    if (created.kind !== 'ok') return
    const id = created.data.id

    // Owner column really is the sentinel.
    const row = await env.DB.prepare('SELECT owner_user_id FROM events WHERE id = ?')
      .bind(id)
      .first<{ owner_user_id: string }>()
    expect(row?.owner_user_id).toBe('user_00000000000000000000000000')

    const listed = await rpc().adminListSystemEvents(ADMIN)
    expect(listed.kind).toBe('ok')
    if (listed.kind === 'ok') {
      expect(listed.data.items.map((e) => e.id)).toContain(id)
    }

    const patched = await rpc().adminPatchSystemEvent(ADMIN, id, { name: 'Renamed Fest' })
    expect(patched.kind).toBe('ok')
    if (patched.kind === 'ok') expect(patched.data.name).toBe('Renamed Fest')

    expect((await rpc().adminDeleteSystemEvent(ADMIN, id)).kind).toBe('ok')
    // Deleted events drop out of the default list but restore works.
    const afterDelete = await rpc().adminListSystemEvents(ADMIN)
    if (afterDelete.kind === 'ok') {
      expect(afterDelete.data.items.map((e) => e.id)).not.toContain(id)
    }
    const restored = await rpc().adminRestoreSystemEvent(ADMIN, id)
    expect(restored.kind).toBe('ok')
  })

  it('refuses to touch non-system events and rejects invalid input', async () => {
    const someone = actor()
    const userEvent = await rpc().createPersonalEvent(someone, { name: 'Mine' })
    expect(await rpc().adminGetSystemEvent(ADMIN, userEvent.id)).toEqual({ kind: 'not_found' })
    expect(await rpc().adminPatchSystemEvent(ADMIN, userEvent.id, { name: 'Hijack' })).toEqual({
      kind: 'not_found',
    })
    expect(await rpc().adminDeleteSystemEvent(ADMIN, userEvent.id)).toEqual({ kind: 'not_found' })

    const invalid = await rpc().adminCreateSystemEvent(ADMIN, { timezone: 'UTC' })
    expect(invalid.kind).toBe('invalid')
  })
})

void TENANT // silence noUnusedLocals (TENANT is a useful constant for direct repo writes if expanded later).

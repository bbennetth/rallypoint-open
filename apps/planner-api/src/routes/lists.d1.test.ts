import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { env as testEnv } from 'cloudflare:test'
import type { Hono } from 'hono'
import { PERSONAL_GROUP_NAME_LEGACY } from '../lib/personal-scope.js'
import {
  ListsClientError,
  type FieldDefDto,
  type GroupDto,
  type ListDto,
  type ListItemDto,
  type ListItemSeriesDto,
  type ListsClient,
} from '@rallypoint/lists-client'
import { parseEnv, type Env } from '../env.js'
import { buildApp } from '../build-app.js'
import { buildD1Repos, createDb } from '../repos/d1/index.js'
import type { HonoApp } from '../context.js'
import type { Repos } from '../repos/types.js'
import type { Services } from '../services/types.js'
import { generateRawToken, hashToken } from '@rallypoint/crypto'
import { encryptBearer } from '../crypto/encryption.js'
import { PLANNER_SESSION_BEARER_PREFIX } from '../middleware/session.js'

// Integration tests for the Planner Task Lists BFF. A real planner session
// lives in a Miniflare D1 (planner-db); RPID is stubbed, and the
// Lists SDK is an in-memory fake injected at the services layer. The point
// is to exercise the BFF's planner-specific behaviour — scope injection
// (listType='tasks', the caller's personal list_group), the item-read IDOR
// guard, and SDK-error → envelope mapping — without standing up lists-api.

const CSRF = 'csrf_token_value_aaaaaaaaaaaaaaaaaaaaaaaaaa'
// PERSONAL_GROUP_NAME_LEGACY ('My Tasks') is the name fakes seed when
// modelling the pre-migration rollout state (groups that haven't been renamed
// yet). selectPersonalGroup matches either legacy or new name, so the fakes
// are still found. resolvePersonalScope creates NEW groups with PERSONAL_GROUP_NAME.

// A mutable in-memory Lists SDK. Models the slices-6a contract the BFF
// relies on: createGroup auto-owns the actor; createList/createListItem
// require the actor to own the list's group (404 otherwise, mirroring
// lists-api's membership gate); listItems is UNGATED (the read surface
// trusts its caller) — which is exactly why the BFF must guard reads.
interface FakeLists {
  client: ListsClient
  calls: { method: string; actor?: string; args: unknown[] }[]
  seedForeignList(): string
  // A list_group-scoped list owned by another user's group. Unlike
  // seedForeignList (opaque `group` scope, trusted to the caller), this is
  // the shape a Planner personal list actually takes — so the Lists SDK
  // membership gate (loadListForActor) rejects writes from a non-member.
  seedForeignPersonalList(): string
  // Seed a notes list inside the given actor's personal group (provisioning the
  // group if it doesn't exist yet). Returns the notes list id.
  seedNotesListForActor(actor: string): string
  // Seed a `tasks`-type list inside the given actor's personal group
  // (provisioning the group if needed). Returns the list id. Used to model the
  // single-list world (#543) where the BFF no longer exposes list-create, plus
  // the legacy multi-list state the merge folds in. `createdAt` is overridable
  // so tests can control which list is the oldest (canonical).
  seedTaskListForActor(actor: string, opts?: { name?: string; createdAt?: string }): string
  // Low-level seeders used by the merge tests to plant items / series / field
  // defs on a specific (typically non-canonical) list.
  seedItem(listId: string, over?: Partial<ListItemDto>): string
  seedSeriesWithOccurrence(listId: string, over?: Partial<ListItemSeriesDto>): string
  seedFieldDef(listId: string, over: Partial<FieldDefDto> & { label: string }): string
  listsSnapshot(): ListDto[]
  itemsSnapshot(): ListItemDto[]
  seriesSnapshot(): ListItemSeriesDto[]
  fieldDefsSnapshot(): FieldDefDto[]
}

function isoNow(): string {
  return new Date().toISOString()
}

function makeFakeLists(): FakeLists {
  const groups: GroupDto[] = []
  const lists: ListDto[] = []
  const items: ListItemDto[] = []
  const series: ListItemSeriesDto[] = []
  const fieldDefs: FieldDefDto[] = []
  const calls: { method: string; actor?: string; args: unknown[] }[] = []

  function ownsGroup(actor: string, scopeId: string): boolean {
    return groups.some((g) => g.id === scopeId && g.createdBy === actor)
  }
  function listOf(listId: string): ListDto | undefined {
    return lists.find((l) => l.id === listId)
  }

  const client: ListsClient = {
    health: async () => ({ status: 'ok' }),
    // UNGATED on purpose — matches sdk-lists.ts (caller authorizes scope),
    // which is exactly why the BFF must guard field reads.
    listFieldDefs: async (listId) => {
      calls.push({ method: 'listFieldDefs', args: [listId] })
      return fieldDefs.filter((d) => d.listId === listId)
    },
    createFieldDef: async (listId, input, actor) => {
      calls.push({ method: 'createFieldDef', actor, args: [listId, input] })
      const list = listOf(listId)
      if (!list || (list.scopeType === 'list_group' && !ownsGroup(actor, list.scopeId))) {
        throw new ListsClientError(404, 'not_found', 'List not found.')
      }
      const d: FieldDefDto = {
        id: `lfd_${fieldDefs.length + 1}`,
        listId,
        key: input.label.toLowerCase().replace(/\s+/g, '_'),
        label: input.label,
        fieldType: input.fieldType,
        options: {
          ...(input.multiline !== undefined ? { multiline: input.multiline } : {}),
          ...(input.choices
            ? { choices: input.choices.map((c, i) => ({ id: `opt_${i + 1}`, label: c.label })) }
            : {}),
        },
        required: input.required ?? false,
        defaultValue: null,
        position: input.position ?? fieldDefs.length,
        createdBy: actor,
        createdAt: isoNow(),
        updatedAt: isoNow(),
      }
      fieldDefs.push(d)
      return d
    },
    updateFieldDef: async (listId, fieldId, patch, actor) => {
      calls.push({ method: 'updateFieldDef', actor, args: [listId, fieldId, patch] })
      // Mirror the real SDK: loadListForActor runs the membership gate before
      // the def lookup, so a non-member 404s without learning the def exists.
      const list = listOf(listId)
      if (!list || (list.scopeType === 'list_group' && !ownsGroup(actor, list.scopeId))) {
        throw new ListsClientError(404, 'not_found', 'List not found.')
      }
      const d = fieldDefs.find((x) => x.id === fieldId && x.listId === listId)
      if (!d) throw new ListsClientError(404, 'field_def_not_found', 'Field not found.')
      if (patch.label !== undefined) d.label = patch.label
      if (patch.required !== undefined) d.required = patch.required
      return d
    },
    deleteFieldDef: async (listId, fieldId, actor) => {
      calls.push({ method: 'deleteFieldDef', actor, args: [listId, fieldId] })
      const list = listOf(listId)
      if (!list || (list.scopeType === 'list_group' && !ownsGroup(actor, list.scopeId))) {
        throw new ListsClientError(404, 'not_found', 'List not found.')
      }
      const idx = fieldDefs.findIndex((x) => x.id === fieldId && x.listId === listId)
      if (idx === -1) throw new ListsClientError(404, 'field_def_not_found', 'Field not found.')
      fieldDefs.splice(idx, 1)
    },
    listSeries: async (listId) => {
      calls.push({ method: 'listSeries', args: [listId] })
      return series.filter((s) => s.listId === listId)
    },
    createListItemSeries: async (listId, input, actor) => {
      calls.push({ method: 'createListItemSeries', actor, args: [listId, input] })
      const list = listOf(listId)
      if (!list || (list.scopeType === 'list_group' && !ownsGroup(actor, list.scopeId))) {
        throw new ListsClientError(404, 'not_found', 'List not found.')
      }
      const s: ListItemSeriesDto = {
        id: `lse_${series.length + 1}`,
        listId,
        title: input.title,
        notes: input.notes ?? null,
        assignedTo: input.assignedTo ?? null,
        priority: input.priority ?? null,
        freq: input.freq,
        interval: input.interval ?? 1,
        byDay: input.byDay ?? null,
        dtstart: input.dtstart,
        until: input.until ?? null,
        count: input.count ?? null,
        timeOfDay: input.timeOfDay ?? null,
        createdBy: actor,
        createdAt: isoNow(),
        updatedAt: isoNow(),
      }
      series.push(s)
      // Mirror lists-api: materialize two occurrence items carrying seriesId.
      for (let n = 0; n < 2; n++) {
        items.push({
          id: `lit_${items.length + 1}`,
          listId,
          title: input.title,
          notes: null,
          assignedTo: null,
          completed: false,
          completedAt: null,
          status: 'todo',
          priority: input.priority ?? 'medium',
          dueDate: input.dtstart,
          position: items.length,
          customFields: {},
          seriesId: s.id,
          createdBy: actor,
          createdAt: isoNow(),
          updatedAt: isoNow(),
        })
      }
      return s
    },
    updateSeries: async (seriesId, patch, actor) => {
      calls.push({ method: 'updateSeries', actor, args: [seriesId, patch] })
      const s = series.find((x) => x.id === seriesId)
      if (!s) throw new ListsClientError(404, 'not_found', 'Series not found.')
      if (patch.title !== undefined) s.title = patch.title
      if (patch.notes !== undefined) s.notes = patch.notes
      if (patch.priority !== undefined) s.priority = patch.priority ?? null
      if (patch.freq !== undefined) s.freq = patch.freq
      if (patch.interval !== undefined) s.interval = patch.interval
      if (patch.byDay !== undefined) s.byDay = patch.byDay ?? null
      if (patch.dtstart !== undefined) s.dtstart = patch.dtstart
      if (patch.until !== undefined) s.until = patch.until ?? null
      if (patch.count !== undefined) s.count = patch.count ?? null
      if (patch.timeOfDay !== undefined) s.timeOfDay = patch.timeOfDay ?? null
      s.updatedAt = isoNow()
      return s
    },
    deleteSeries: async (seriesId, actor) => {
      calls.push({ method: 'deleteSeries', actor, args: [seriesId] })
      const idx = series.findIndex((s) => s.id === seriesId)
      if (idx === -1) throw new ListsClientError(404, 'not_found', 'Series not found.')
      series.splice(idx, 1)
      for (let i = items.length - 1; i >= 0; i--) {
        if (items[i].seriesId === seriesId) items.splice(i, 1)
      }
    },
    listGroups: async (actor) => {
      calls.push({ method: 'listGroups', actor, args: [] })
      return groups.filter((g) => g.createdBy === actor)
    },
    createGroup: async (input, actor) => {
      calls.push({ method: 'createGroup', actor, args: [input] })
      const g: GroupDto = {
        id: `lgr_${groups.length + 1}`,
        name: input.name,
        description: input.description ?? null,
        createdBy: actor,
        createdAt: isoNow(),
        updatedAt: isoNow(),
      }
      groups.push(g)
      return g
    },
    listLists: async (scope) => {
      calls.push({ method: 'listLists', args: [scope] })
      return lists.filter(
        (l) => l.scopeType === scope.scopeType && l.scopeId === scope.scopeId,
      )
    },
    listItems: async (listId) => {
      // UNGATED on purpose — matches sdk-lists.ts (caller authorizes scope).
      calls.push({ method: 'listItems', args: [listId] })
      return items.filter((i) => i.listId === listId)
    },
    createList: async (input, actor) => {
      calls.push({ method: 'createList', actor, args: [input] })
      if (input.scopeType === 'list_group' && !ownsGroup(actor, input.scopeId)) {
        throw new ListsClientError(404, 'not_found', 'List group not found.')
      }
      const l: ListDto = {
        id: `lst_${lists.length + 1}`,
        scopeType: input.scopeType,
        scopeId: input.scopeId,
        listType: input.listType,
        name: input.name,
        visibility: input.visibility,
        color: input.color ?? null,
        incompleteCount: 0,
        createdBy: actor,
        createdAt: isoNow(),
        updatedAt: isoNow(),
      }
      lists.push(l)
      return l
    },
    createListItem: async (listId, input, actor) => {
      calls.push({ method: 'createListItem', actor, args: [listId, input] })
      const list = listOf(listId)
      if (!list || (list.scopeType === 'list_group' && !ownsGroup(actor, list.scopeId))) {
        throw new ListsClientError(404, 'not_found', 'List not found.')
      }
      const isTasks = list.listType === 'tasks'
      const resolvedStatus = isTasks ? (input.status ?? 'todo') : null
      const it: ListItemDto = {
        id: `lit_${items.length + 1}`,
        listId,
        title: input.title,
        notes: input.notes ?? null,
        assignedTo: input.assignedTo ?? null,
        // Mirror lists-api: the boolean `completed` column is derived from the
        // status category — 'done' → true, else false.
        completed: resolvedStatus === 'done',
        completedAt: null,
        status: resolvedStatus,
        // Mirror lists-api post-#430: explicit null = no-priority (null stored);
        // omitted (undefined) = default medium; else use the value. ?? coerces
        // null→'medium', so use a conditional to distinguish null from undefined.
        priority: isTasks ? (input.priority === undefined ? 'medium' : input.priority) : null,
        dueDate: input.dueDate ?? null,
        position: input.position ?? 0,
        customFields: input.customFields ?? {},
        seriesId: null,
        createdBy: actor,
        createdAt: isoNow(),
        updatedAt: isoNow(),
      }
      items.push(it)
      return it
    },
    updateListItem: async (listId, itemId, patch, actor) => {
      calls.push({ method: 'updateListItem', actor, args: [listId, itemId, patch] })
      const it = items.find((x) => x.id === itemId && x.listId === listId)
      if (!it) throw new ListsClientError(404, 'item_not_found', 'Item not found.')
      if (patch.completed !== undefined) it.completed = patch.completed
      if (patch.title !== undefined) it.title = patch.title
      if (patch.status !== undefined) it.status = patch.status
      return it
    },
    deleteListItem: async (listId, itemId, actor) => {
      calls.push({ method: 'deleteListItem', actor, args: [listId, itemId] })
      const idx = items.findIndex((x) => x.id === itemId && x.listId === listId)
      if (idx === -1) throw new ListsClientError(404, 'item_not_found', 'Item not found.')
      items.splice(idx, 1)
    },
    deleteList: async (listId, actor) => {
      calls.push({ method: 'deleteList', actor, args: [listId] })
      const idx = lists.findIndex((l) => l.id === listId)
      if (idx === -1) throw new ListsClientError(404, 'not_found', 'List not found.')
      lists.splice(idx, 1)
    },
  }

  return {
    client,
    calls,
    // Seed a non-personal list nobody on the planner side owns, to drive
    // the item-read IDOR guard.
    seedForeignList() {
      const l: ListDto = {
        id: 'lst_foreign',
        scopeType: 'group',
        scopeId: 'grp_someone_else',
        listType: 'tasks',
        name: 'Foreign',
        visibility: 'all',
        color: null,
        incompleteCount: 0,
        createdBy: 'user_someone_else',
        createdAt: isoNow(),
        updatedAt: isoNow(),
      }
      lists.push(l)
      items.push({
        id: 'lit_foreign',
        listId: 'lst_foreign',
        title: 'secret',
        notes: null,
        assignedTo: null,
        completed: false,
        completedAt: null,
        status: 'todo',
        priority: 'medium',
        dueDate: null,
        position: 0,
        customFields: {},
        seriesId: null,
        createdBy: 'user_someone_else',
        createdAt: isoNow(),
        updatedAt: isoNow(),
      })
      return l.id
    },
    seedForeignPersonalList() {
      groups.push({
        id: 'grp_foreign_personal',
        // Model the pre-migration state (legacy name) — selectPersonalGroup
        // still finds it via PERSONAL_GROUP_NAME_LEGACY during the rollout window.
        name: PERSONAL_GROUP_NAME_LEGACY,
        description: null,
        createdBy: 'user_someone_else',
        createdAt: isoNow(),
        updatedAt: isoNow(),
      })
      const l: ListDto = {
        id: 'lst_foreign_personal',
        scopeType: 'list_group',
        scopeId: 'grp_foreign_personal',
        listType: 'tasks',
        name: 'Foreign personal',
        visibility: 'all',
        color: null,
        incompleteCount: 0,
        createdBy: 'user_someone_else',
        createdAt: isoNow(),
        updatedAt: isoNow(),
      }
      lists.push(l)
      fieldDefs.push({
        id: 'lfd_1',
        listId: l.id,
        key: 'secret',
        label: 'Secret',
        fieldType: 'text',
        options: {},
        required: false,
        defaultValue: null,
        position: 0,
        createdBy: 'user_someone_else',
        createdAt: isoNow(),
        updatedAt: isoNow(),
      })
      return l.id
    },
    seedNotesListForActor(actor: string): string {
      // Find or create the actor's personal group. Use the legacy name here
      // to model the pre-migration state (selectPersonalGroup accepts either).
      let group = groups.find(
        (g) => g.createdBy === actor && g.name === PERSONAL_GROUP_NAME_LEGACY,
      )
      if (!group) {
        group = {
          id: `lgr_notes_${actor}`,
          name: PERSONAL_GROUP_NAME_LEGACY,
          description: null,
          createdBy: actor,
          createdAt: isoNow(),
          updatedAt: isoNow(),
        }
        groups.push(group)
      }
      const l: ListDto = {
        id: `lst_notes_${actor}`,
        scopeType: 'list_group',
        scopeId: group.id,
        listType: 'notes',
        name: 'Notes',
        visibility: 'all',
        color: null,
        incompleteCount: 0,
        createdBy: actor,
        createdAt: isoNow(),
        updatedAt: isoNow(),
      }
      lists.push(l)
      return l.id
    },
    seedTaskListForActor(actor, opts = {}) {
      // Find or create the actor's personal group (legacy name models the
      // pre-migration state; selectPersonalGroup accepts either).
      let group = groups.find(
        (g) => g.createdBy === actor && g.name === PERSONAL_GROUP_NAME_LEGACY,
      )
      if (!group) {
        group = {
          id: `lgr_t_${actor}`,
          name: PERSONAL_GROUP_NAME_LEGACY,
          description: null,
          createdBy: actor,
          createdAt: isoNow(),
          updatedAt: isoNow(),
        }
        groups.push(group)
      }
      const l: ListDto = {
        id: `lst_t_${lists.length + 1}`,
        scopeType: 'list_group',
        scopeId: group.id,
        listType: 'tasks',
        name: opts.name ?? 'Tasks',
        visibility: 'all',
        color: null,
        incompleteCount: 0,
        createdBy: actor,
        createdAt: opts.createdAt ?? isoNow(),
        updatedAt: opts.createdAt ?? isoNow(),
      }
      lists.push(l)
      return l.id
    },
    seedItem(listId, over = {}) {
      const it: ListItemDto = {
        id: `lit_seed_${items.length + 1}`,
        listId,
        title: 'Seeded',
        notes: null,
        assignedTo: null,
        completed: false,
        completedAt: null,
        status: 'todo',
        statusId: null,
        parentId: null,
        priority: 'medium',
        dueDate: null,
        position: items.length,
        customFields: {},
        seriesId: null,
        createdBy: 'system',
        createdAt: isoNow(),
        updatedAt: isoNow(),
        ...over,
      }
      items.push(it)
      return it.id
    },
    seedSeriesWithOccurrence(listId, over = {}) {
      const s: ListItemSeriesDto = {
        id: `lse_seed_${series.length + 1}`,
        listId,
        title: 'Seeded series',
        notes: null,
        assignedTo: null,
        priority: null,
        freq: 'weekly',
        interval: 1,
        byDay: ['MO'],
        dtstart: '2026-06-08',
        until: null,
        count: 4,
        timeOfDay: null,
        createdBy: 'system',
        createdAt: isoNow(),
        updatedAt: isoNow(),
        ...over,
      }
      series.push(s)
      // One materialized occurrence carrying the seriesId.
      items.push({
        id: `lit_occ_${items.length + 1}`,
        listId,
        title: s.title,
        notes: null,
        assignedTo: null,
        completed: false,
        completedAt: null,
        status: 'todo',
        statusId: null,
        parentId: null,
        priority: s.priority ?? 'medium',
        dueDate: s.dtstart,
        position: items.length,
        customFields: {},
        seriesId: s.id,
        createdBy: 'system',
        createdAt: isoNow(),
        updatedAt: isoNow(),
      })
      return s.id
    },
    seedFieldDef(listId, over) {
      const d: FieldDefDto = {
        id: `lfd_seed_${fieldDefs.length + 1}`,
        listId,
        key: over.label.toLowerCase().replace(/\s+/g, '_'),
        label: over.label,
        fieldType: over.fieldType ?? 'text',
        options: over.options ?? {},
        required: over.required ?? false,
        defaultValue: null,
        position: fieldDefs.length,
        createdBy: 'system',
        createdAt: isoNow(),
        updatedAt: isoNow(),
        ...over,
      }
      fieldDefs.push(d)
      return d.id
    },
    listsSnapshot: () => lists.map((l) => ({ ...l })),
    itemsSnapshot: () => items.map((i) => ({ ...i })),
    seriesSnapshot: () => series.map((s) => ({ ...s })),
    fieldDefsSnapshot: () => fieldDefs.map((d) => ({ ...d })),
  }
}

describe('D1 integration — Planner Task Lists BFF', () => {
  let repos: Repos
  let env: Env
  let app: Hono<HonoApp>
  let fake: FakeLists

  const baseServices = (listsClient: ListsClient): Services => ({
    idClient: {
      verifyRpidBearer: async (bearer: string) => ({ ok: true as const, userId: bearer }),
      signoutRpidBearer: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    },
    rpidSso: {
      exchange: vi.fn().mockResolvedValue({ ok: false, reason: 'invalid' }),
    },
    listsClient,
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
    fake = makeFakeLists()
    app = buildApp({ env, logger: undefined, repos, services: baseServices(fake.client) })
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
      ...extra,
    }
  }

  it('requires a session for every list route', async () => {
    const res = await app.request('http://localhost/api/v1/ui/lists', {
      headers: { cookie: `${env.PLANNER_CSRF_COOKIE_NAME}=${CSRF}`, 'x-rp-csrf': CSRF },
    })
    expect(res.status).toBe(401)
  })

  it('GET /lists provisions + returns the single canonical Tasks list (fresh user)', async () => {
    const bearer = await loginAs('user_a')
    const res = await app.request('http://localhost/api/v1/ui/lists', { headers: headers(bearer) })
    expect(res.status).toBe(200)
    const rows = (await res.json()) as ListDto[]
    expect(rows).toHaveLength(1)
    expect(rows[0].listType).toBe('tasks')
    expect(rows[0].name).toBe('Tasks')
    expect(rows[0].scopeType).toBe('list_group')
    expect(rows[0].visibility).toBe('all')
    // The personal group + the Tasks list were provisioned.
    expect(fake.calls.some((c) => c.method === 'createGroup')).toBe(true)
    expect(fake.calls.some((c) => c.method === 'createList')).toBe(true)
  })

  it('GET /lists is idempotent: a second call provisions nothing new', async () => {
    const bearer = await loginAs('user_c')
    const first = (await (
      await app.request('http://localhost/api/v1/ui/lists', { headers: headers(bearer) })
    ).json()) as ListDto[]
    const createListCount = fake.calls.filter((c) => c.method === 'createList').length
    const second = (await (
      await app.request('http://localhost/api/v1/ui/lists', { headers: headers(bearer) })
    ).json()) as ListDto[]
    // Same canonical list, and no extra list/group provisioned the 2nd time.
    expect(second[0].id).toBe(first[0].id)
    expect(fake.calls.filter((c) => c.method === 'createList')).toHaveLength(createListCount)
    expect(fake.calls.filter((c) => c.method === 'createGroup')).toHaveLength(1)
  })

  it('GET /lists returns the existing task list when one already exists (no provisioning)', async () => {
    const bearer = await loginAs('user_d')
    fake.seedTaskListForActor('user_d', { name: 'Today' })
    const res = await app.request('http://localhost/api/v1/ui/lists', { headers: headers(bearer) })
    const rows = (await res.json()) as ListDto[]
    expect(rows.map((l) => l.name)).toEqual(['Today'])
    expect(fake.calls.some((c) => c.method === 'createList')).toBe(false)
  })

  it('no POST /lists endpoint (single-list — list create is gone)', async () => {
    const bearer = await loginAs('user_b')
    const res = await app.request('http://localhost/api/v1/ui/lists', {
      method: 'POST',
      headers: headers(bearer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ name: 'Errands' }),
    })
    expect(res.status).toBe(404)
  })

  it('no DELETE /lists/:listId endpoint (single-list — list delete is gone)', async () => {
    const bearer = await loginAs('user_dl')
    const listId = fake.seedTaskListForActor('user_dl')
    const res = await app.request(`http://localhost/api/v1/ui/lists/${listId}`, {
      method: 'DELETE',
      headers: headers(bearer),
    })
    expect(res.status).toBe(404)
    expect(fake.calls.some((c) => c.method === 'deleteList')).toBe(false)
  })

  it('item create → check-off → delete round-trips with the session actor', async () => {
    const bearer = await loginAs('user_e')
    const listId = fake.seedTaskListForActor('user_e', { name: 'Chores' })

    const createRes = await app.request(
      `http://localhost/api/v1/ui/lists/${listId}/items`,
      {
        method: 'POST',
        headers: headers(bearer, { 'content-type': 'application/json' }),
        body: JSON.stringify({ title: 'Take out trash' }),
      },
    )
    expect(createRes.status).toBe(201)
    const item = (await createRes.json()) as ListItemDto
    expect(item.status).toBe('todo')
    expect(fake.calls.find((c) => c.method === 'createListItem')?.actor).toBe('user_e')

    const patchRes = await app.request(
      `http://localhost/api/v1/ui/lists/${listId}/items/${item.id}`,
      {
        method: 'PATCH',
        headers: headers(bearer, { 'content-type': 'application/json' }),
        body: JSON.stringify({ completed: true }),
      },
    )
    expect(patchRes.status).toBe(200)
    expect(((await patchRes.json()) as ListItemDto).completed).toBe(true)

    const delRes = await app.request(
      `http://localhost/api/v1/ui/lists/${listId}/items/${item.id}`,
      { method: 'DELETE', headers: headers(bearer) },
    )
    expect(delRes.status).toBe(204)

    const listItems = await app.request(
      `http://localhost/api/v1/ui/lists/${listId}/items`,
      { headers: headers(bearer) },
    )
    expect((await listItems.json()) as ListItemDto[]).toEqual([])
  })

  it('GET items leaves a one-off task’s genuine timed instant untouched in any tz', async () => {
    // A one-off task (seriesId null) carries a true UTC instant — the BFF must
    // NOT re-anchor it. 6:30 PM Pacific is stored as 01:30Z next day; GET items
    // returns it byte-identical whether tz is UTC or Pacific. (The resolver only
    // touches recurring floating dues; one-offs are genuine instants.)
    const bearer = await loginAs('user_oneoff_tz')
    const listId = fake.seedTaskListForActor('user_oneoff_tz', { name: 'Tasks' })
    const due = '2026-06-20T01:30:00.000Z'
    const createRes = await app.request(`http://localhost/api/v1/ui/lists/${listId}/items`, {
      method: 'POST',
      headers: headers(bearer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ title: 'Call mom', dueDate: due }),
    })
    expect(createRes.status).toBe(201)

    for (const tz of ['UTC', 'America/Los_Angeles']) {
      const res = await app.request(
        `http://localhost/api/v1/ui/lists/${listId}/items?tz=${encodeURIComponent(tz)}`,
        { headers: headers(bearer) },
      )
      expect(res.status).toBe(200)
      const rows = (await res.json()) as ListItemDto[]
      expect(rows).toHaveLength(1)
      expect(rows[0]!.seriesId).toBeNull()
      expect(rows[0]!.dueDate).toBe(due)
    }
  })

  it('GET items 404s for a list the caller does not own (IDOR guard)', async () => {
    const bearer = await loginAs('user_f')
    const foreignId = fake.seedForeignList()
    const res = await app.request(
      `http://localhost/api/v1/ui/lists/${foreignId}/items`,
      { headers: headers(bearer) },
    )
    expect(res.status).toBe(404)
    // The ungated SDK read must never have been reached.
    expect(fake.calls.some((c) => c.method === 'listItems')).toBe(false)
  })

  it('rejects a malformed item body at the BFF boundary (400)', async () => {
    const bearer = await loginAs('user_i')
    const listId = fake.seedTaskListForActor('user_i')
    const res = await app.request(`http://localhost/api/v1/ui/lists/${listId}/items`, {
      method: 'POST',
      headers: headers(bearer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ notes: 'no title' }),
    })
    expect(res.status).toBe(400)
    expect(fake.calls.some((c) => c.method === 'createListItem')).toBe(false)
  })

  it('maps an SDK ListsClientError to the same status envelope', async () => {
    const bearer = await loginAs('user_g')
    // No personal group → ownership check passes only for owned lists; a
    // write to an unknown list id surfaces the SDK 404 verbatim.
    const res = await app.request(
      'http://localhost/api/v1/ui/lists/lst_does_not_exist/items',
      {
        method: 'POST',
        headers: headers(bearer, { 'content-type': 'application/json' }),
        body: JSON.stringify({ title: 'x' }),
      },
    )
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('not_found')
  })

  // --- recurring series (slice 12) ---------------------------------

  // Single-list world (#543): the BFF no longer exposes list-create, so tests
  // seed a task list directly on the fake. `bearer` carries the actor id (the
  // stub idClient maps bearer→userId 1:1), so we resolve the actor from the
  // session to seed under the right group. Simpler: tests pass the actor via
  // loginAs and we seed for that same id — here we accept the actor explicitly.
  async function createList(bearer: string, name: string): Promise<string> {
    // Resolve the canonical list by hitting GET (provisions it), then rename
    // is unnecessary — the seeded fake list IS the canonical one. We seed via
    // the actor recovered from the session row.
    const session = await repos.sessions.findByIdHash(hashToken(bearer))
    const actor = session!.userId
    return fake.seedTaskListForActor(actor, { name })
  }

  it('POST /series creates a series; occurrences surface with seriesId', async () => {
    const bearer = await loginAs('user_s1')
    const listId = await createList(bearer, 'Habits')

    const res = await app.request(`http://localhost/api/v1/ui/lists/${listId}/series`, {
      method: 'POST',
      headers: headers(bearer, { 'content-type': 'application/json' }),
      body: JSON.stringify({
        title: 'Stretch',
        freq: 'weekly',
        interval: 1,
        byDay: ['MO', 'WE'],
        dtstart: '2026-06-08',
        count: 4,
      }),
    })
    expect(res.status).toBe(201)
    const created = (await res.json()) as ListItemSeriesDto
    expect(created.title).toBe('Stretch')
    expect(created.byDay).toEqual(['MO', 'WE'])
    expect(fake.calls.find((c) => c.method === 'createListItemSeries')?.actor).toBe('user_s1')

    const itemsRes = await app.request(`http://localhost/api/v1/ui/lists/${listId}/items`, {
      headers: headers(bearer),
    })
    const rows = (await itemsRes.json()) as ListItemDto[]
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((r) => r.seriesId === created.id)).toBe(true)
  })

  it('POST /series 404s for a list the caller does not own (IDOR guard)', async () => {
    const bearer = await loginAs('user_s2')
    const foreignId = fake.seedForeignList()
    const res = await app.request(`http://localhost/api/v1/ui/lists/${foreignId}/series`, {
      method: 'POST',
      headers: headers(bearer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ title: 'x', freq: 'daily', interval: 1, dtstart: '2026-06-08', count: 3 }),
    })
    expect(res.status).toBe(404)
    expect(fake.calls.some((c) => c.method === 'createListItemSeries')).toBe(false)
  })

  it('GET /series 404s for a list the caller does not own (IDOR guard)', async () => {
    const bearer = await loginAs('user_s6')
    const foreignId = fake.seedForeignList()
    const res = await app.request(`http://localhost/api/v1/ui/lists/${foreignId}/series`, {
      headers: headers(bearer),
    })
    expect(res.status).toBe(404)
    expect(fake.calls.some((c) => c.method === 'listSeries')).toBe(false)
  })

  it('DELETE /series 404s for a list the caller does not own (IDOR guard)', async () => {
    const bearer = await loginAs('user_s7')
    const foreignId = fake.seedForeignList()
    const res = await app.request(
      `http://localhost/api/v1/ui/lists/${foreignId}/series/lse_1`,
      { method: 'DELETE', headers: headers(bearer) },
    )
    expect(res.status).toBe(404)
    expect(fake.calls.some((c) => c.method === 'deleteSeries')).toBe(false)
  })

  it('POST /series rejects a malformed rule at the BFF boundary (400)', async () => {
    const bearer = await loginAs('user_s3')
    const listId = await createList(bearer, 'Bad')
    // byDay on a daily rule violates the cross-field rule.
    const res = await app.request(`http://localhost/api/v1/ui/lists/${listId}/series`, {
      method: 'POST',
      headers: headers(bearer, { 'content-type': 'application/json' }),
      body: JSON.stringify({
        title: 'x',
        freq: 'daily',
        interval: 1,
        byDay: ['MO'],
        dtstart: '2026-06-08',
        count: 3,
      }),
    })
    expect(res.status).toBe(400)
    expect(fake.calls.some((c) => c.method === 'createListItemSeries')).toBe(false)
  })

  it('GET then DELETE /series round-trips and removes its occurrences', async () => {
    const bearer = await loginAs('user_s4')
    const listId = await createList(bearer, 'Routine')
    const created = (await (
      await app.request(`http://localhost/api/v1/ui/lists/${listId}/series`, {
        method: 'POST',
        headers: headers(bearer, { 'content-type': 'application/json' }),
        body: JSON.stringify({ title: 'Walk', freq: 'daily', interval: 1, dtstart: '2026-06-08', count: 3 }),
      })
    ).json()) as ListItemSeriesDto

    const listRes = await app.request(`http://localhost/api/v1/ui/lists/${listId}/series`, {
      headers: headers(bearer),
    })
    expect(((await listRes.json()) as ListItemSeriesDto[]).map((s) => s.id)).toEqual([created.id])

    const delRes = await app.request(
      `http://localhost/api/v1/ui/lists/${listId}/series/${created.id}`,
      { method: 'DELETE', headers: headers(bearer) },
    )
    expect(delRes.status).toBe(204)

    const itemsRes = await app.request(`http://localhost/api/v1/ui/lists/${listId}/items`, {
      headers: headers(bearer),
    })
    expect((await itemsRes.json()) as ListItemDto[]).toEqual([])
  })

  it('DELETE /series 404s when the series is not in the caller-owned list', async () => {
    const bearer = await loginAs('user_s5')
    const listId = await createList(bearer, 'Mine')
    const res = await app.request(
      `http://localhost/api/v1/ui/lists/${listId}/series/lse_does_not_exist`,
      { method: 'DELETE', headers: headers(bearer) },
    )
    expect(res.status).toBe(404)
    expect(fake.calls.some((c) => c.method === 'deleteSeries')).toBe(false)
  })

  // --- custom field defs (slice 13) --------------------------------

  it('POST /fields creates a def; GET then PATCH then DELETE round-trips', async () => {
    const bearer = await loginAs('user_fd1')
    const listId = await createList(bearer, 'Project')

    const createRes = await app.request(`http://localhost/api/v1/ui/lists/${listId}/fields`, {
      method: 'POST',
      headers: headers(bearer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ label: 'Stage', fieldType: 'single_select', choices: [{ label: 'Todo' }] }),
    })
    expect(createRes.status).toBe(201)
    const def = (await createRes.json()) as FieldDefDto
    expect(def.label).toBe('Stage')
    expect(fake.calls.find((c) => c.method === 'createFieldDef')?.actor).toBe('user_fd1')

    const getRes = await app.request(`http://localhost/api/v1/ui/lists/${listId}/fields`, {
      headers: headers(bearer),
    })
    expect(((await getRes.json()) as FieldDefDto[]).map((d) => d.id)).toEqual([def.id])

    const patchRes = await app.request(`http://localhost/api/v1/ui/lists/${listId}/fields/${def.id}`, {
      method: 'PATCH',
      headers: headers(bearer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ label: 'Status', required: true }),
    })
    expect(patchRes.status).toBe(200)
    expect(await patchRes.json()).toMatchObject({ label: 'Status', required: true })

    const delRes = await app.request(`http://localhost/api/v1/ui/lists/${listId}/fields/${def.id}`, {
      method: 'DELETE',
      headers: headers(bearer),
    })
    expect(delRes.status).toBe(204)
    const after = await app.request(`http://localhost/api/v1/ui/lists/${listId}/fields`, {
      headers: headers(bearer),
    })
    expect((await after.json()) as FieldDefDto[]).toEqual([])
  })

  it('GET /fields 404s for a list the caller does not own (IDOR guard)', async () => {
    const bearer = await loginAs('user_fd2')
    const foreignId = fake.seedForeignList()
    const res = await app.request(`http://localhost/api/v1/ui/lists/${foreignId}/fields`, {
      headers: headers(bearer),
    })
    expect(res.status).toBe(404)
    // The ungated SDK read must never have been reached.
    expect(fake.calls.some((c) => c.method === 'listFieldDefs')).toBe(false)
  })

  it('POST /fields rejects a malformed def at the BFF boundary (400)', async () => {
    const bearer = await loginAs('user_fd3')
    const listId = await createList(bearer, 'Bad fields')
    // choices on a non-select type violates the create cross-field rule.
    const res = await app.request(`http://localhost/api/v1/ui/lists/${listId}/fields`, {
      method: 'POST',
      headers: headers(bearer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ label: 'Nope', fieldType: 'text', choices: [{ label: 'x' }] }),
    })
    expect(res.status).toBe(400)
    expect(fake.calls.some((c) => c.method === 'createFieldDef')).toBe(false)
  })

  it('POST /fields 404s for a personal list the caller does not own (IDOR guard)', async () => {
    const bearer = await loginAs('user_fd4')
    const foreignId = fake.seedForeignPersonalList()
    const res = await app.request(`http://localhost/api/v1/ui/lists/${foreignId}/fields`, {
      method: 'POST',
      headers: headers(bearer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ label: 'Stage', fieldType: 'text' }),
    })
    expect(res.status).toBe(404)
    // The downstream SDK membership gate (list_group ownership) rejects it.
    expect(fake.calls.some((c) => c.method === 'createFieldDef' && c.actor === 'user_fd4')).toBe(true)
  })

  it('PATCH /fields/:id 404s for a personal list the caller does not own (IDOR guard)', async () => {
    const bearer = await loginAs('user_fd5')
    const foreignId = fake.seedForeignPersonalList()
    const res = await app.request(`http://localhost/api/v1/ui/lists/${foreignId}/fields/lfd_1`, {
      method: 'PATCH',
      headers: headers(bearer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ label: 'Hijacked' }),
    })
    expect(res.status).toBe(404)
    expect(fake.calls.some((c) => c.method === 'updateFieldDef' && c.actor === 'user_fd5')).toBe(true)
  })

  it('DELETE /fields/:id 404s for a personal list the caller does not own (IDOR guard)', async () => {
    const bearer = await loginAs('user_fd6')
    const foreignId = fake.seedForeignPersonalList()
    const res = await app.request(`http://localhost/api/v1/ui/lists/${foreignId}/fields/lfd_1`, {
      method: 'DELETE',
      headers: headers(bearer),
    })
    expect(res.status).toBe(404)
    expect(fake.calls.some((c) => c.method === 'deleteFieldDef' && c.actor === 'user_fd6')).toBe(true)
  })

  // --- PATCH series (slice 12b) --------------------------------

  it('PATCH /series updates a field and returns the updated DTO', async () => {
    const bearer = await loginAs('user_ps1')
    const listId = await createList(bearer, 'Habits')

    // Create a series first
    const created = (await (
      await app.request(`http://localhost/api/v1/ui/lists/${listId}/series`, {
        method: 'POST',
        headers: headers(bearer, { 'content-type': 'application/json' }),
        body: JSON.stringify({ title: 'Walk', freq: 'daily', interval: 1, dtstart: '2026-06-08', count: 10 }),
      })
    ).json()) as ListItemSeriesDto

    const patchRes = await app.request(
      `http://localhost/api/v1/ui/lists/${listId}/series/${created.id}`,
      {
        method: 'PATCH',
        headers: headers(bearer, { 'content-type': 'application/json' }),
        body: JSON.stringify({ interval: 2, title: 'Long Walk' }),
      },
    )
    expect(patchRes.status).toBe(200)
    const updated = (await patchRes.json()) as ListItemSeriesDto
    expect(updated.interval).toBe(2)
    expect(updated.title).toBe('Long Walk')
    // The actor should be forwarded downstream
    expect(fake.calls.find((c) => c.method === 'updateSeries')?.actor).toBe('user_ps1')
  })

  it('PATCH /series: a follow-up GET reflects the updated field', async () => {
    const bearer = await loginAs('user_ps2')
    const listId = await createList(bearer, 'Routines')

    const created = (await (
      await app.request(`http://localhost/api/v1/ui/lists/${listId}/series`, {
        method: 'POST',
        headers: headers(bearer, { 'content-type': 'application/json' }),
        body: JSON.stringify({ title: 'Run', freq: 'weekly', interval: 1, byDay: ['MO'], dtstart: '2026-06-09', count: 4 }),
      })
    ).json()) as ListItemSeriesDto

    await app.request(`http://localhost/api/v1/ui/lists/${listId}/series/${created.id}`, {
      method: 'PATCH',
      headers: headers(bearer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ title: 'Morning Run' }),
    })

    const getRes = await app.request(`http://localhost/api/v1/ui/lists/${listId}/series`, {
      headers: headers(bearer),
    })
    const rows = (await getRes.json()) as ListItemSeriesDto[]
    expect(rows.find((s) => s.id === created.id)?.title).toBe('Morning Run')
  })

  it('PATCH /series 404s when the actor does not own the list (IDOR guard)', async () => {
    const bearer = await loginAs('user_ps3')
    const foreignId = fake.seedForeignList()
    const res = await app.request(
      `http://localhost/api/v1/ui/lists/${foreignId}/series/lse_1`,
      {
        method: 'PATCH',
        headers: headers(bearer, { 'content-type': 'application/json' }),
        body: JSON.stringify({ title: 'Hijacked' }),
      },
    )
    expect(res.status).toBe(404)
    expect(fake.calls.some((c) => c.method === 'updateSeries')).toBe(false)
  })

  it('PATCH /series 404s when the seriesId is not in the caller-owned list (IDOR guard)', async () => {
    const bearer = await loginAs('user_ps4')
    const listId = await createList(bearer, 'Mine')
    const res = await app.request(
      `http://localhost/api/v1/ui/lists/${listId}/series/lse_does_not_exist`,
      {
        method: 'PATCH',
        headers: headers(bearer, { 'content-type': 'application/json' }),
        body: JSON.stringify({ title: 'Fake' }),
      },
    )
    expect(res.status).toBe(404)
    expect(fake.calls.some((c) => c.method === 'updateSeries')).toBe(false)
  })

  it('PATCH /series 400s on an empty patch (UpdateSeriesSchema requires at least one field)', async () => {
    const bearer = await loginAs('user_ps5')
    const listId = await createList(bearer, 'Empty Patch')
    const created = (await (
      await app.request(`http://localhost/api/v1/ui/lists/${listId}/series`, {
        method: 'POST',
        headers: headers(bearer, { 'content-type': 'application/json' }),
        body: JSON.stringify({ title: 'Stretch', freq: 'daily', interval: 1, dtstart: '2026-06-08', count: 3 }),
      })
    ).json()) as ListItemSeriesDto

    const res = await app.request(
      `http://localhost/api/v1/ui/lists/${listId}/series/${created.id}`,
      {
        method: 'PATCH',
        headers: headers(bearer, { 'content-type': 'application/json' }),
        body: JSON.stringify({}),
      },
    )
    expect(res.status).toBe(400)
    expect(fake.calls.some((c) => c.method === 'updateSeries')).toBe(false)
  })

  it('PATCH /series 400s on an invalid freq value', async () => {
    const bearer = await loginAs('user_ps6')
    const listId = await createList(bearer, 'Bad Freq')
    const created = (await (
      await app.request(`http://localhost/api/v1/ui/lists/${listId}/series`, {
        method: 'POST',
        headers: headers(bearer, { 'content-type': 'application/json' }),
        body: JSON.stringify({ title: 'Yoga', freq: 'daily', interval: 1, dtstart: '2026-06-08', count: 3 }),
      })
    ).json()) as ListItemSeriesDto

    const res = await app.request(
      `http://localhost/api/v1/ui/lists/${listId}/series/${created.id}`,
      {
        method: 'PATCH',
        headers: headers(bearer, { 'content-type': 'application/json' }),
        body: JSON.stringify({ freq: 'monthly' }),
      },
    )
    expect(res.status).toBe(400)
    expect(fake.calls.some((c) => c.method === 'updateSeries')).toBe(false)
  })

  // --- single-list merge (#543) ------------------------------------------
  // GET /lists resolves the single canonical Tasks list and folds any legacy
  // extra task lists into it. These tests drive the merge end-to-end through
  // the BFF + fake SDK: fresh user, multi-list fold-in (items + series +
  // custom fields preserved), and idempotency.

  it('merge: a multi-list user is folded into one canonical list, nothing lost', async () => {
    const bearer = await loginAs('user_m1')
    // Canonical = oldest task list; two extra lists to fold in.
    const canonicalId = fake.seedTaskListForActor('user_m1', {
      name: 'Tasks',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    const srcA = fake.seedTaskListForActor('user_m1', {
      name: 'Errands',
      createdAt: '2026-02-01T00:00:00.000Z',
    })
    const srcB = fake.seedTaskListForActor('user_m1', {
      name: 'Work',
      createdAt: '2026-03-01T00:00:00.000Z',
    })
    fake.seedItem(canonicalId, { title: 'Already here' })
    fake.seedItem(srcA, { title: 'Milk', priority: 'high' })
    fake.seedItem(srcA, { title: 'Done thing', completed: true, status: 'done' })
    fake.seedItem(srcB, { title: 'Report', dueDate: '2026-04-01' })
    // A duplicate title across canonical and a source — merge keeps both.
    fake.seedItem(srcB, { title: 'Already here' })

    const res = await app.request('http://localhost/api/v1/ui/lists', { headers: headers(bearer) })
    const rows = (await res.json()) as ListDto[]
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(canonicalId)

    // All source items now live on the canonical list; sources are empty.
    const canonItems = fake.itemsSnapshot().filter((i) => i.listId === canonicalId)
    const titles = canonItems.map((i) => i.title).sort()
    expect(titles).toEqual(['Already here', 'Already here', 'Done thing', 'Milk', 'Report'].sort())
    expect(fake.itemsSnapshot().filter((i) => i.listId === srcA)).toHaveLength(0)
    expect(fake.itemsSnapshot().filter((i) => i.listId === srcB)).toHaveLength(0)

    // Field-level preservation: priority, dueDate, completion all survive.
    expect(canonItems.find((i) => i.title === 'Milk')?.priority).toBe('high')
    expect(canonItems.find((i) => i.title === 'Report')?.dueDate).toBe('2026-04-01')
    expect(canonItems.find((i) => i.title === 'Done thing')?.completed).toBe(true)

    // The source LIST rows remain (visible in the Lists app per #543).
    const listIds = fake.listsSnapshot().map((l) => l.id)
    expect(listIds).toEqual(expect.arrayContaining([canonicalId, srcA, srcB]))
  })

  it('merge: a recurring series on a source list is rebuilt on the canonical list', async () => {
    const bearer = await loginAs('user_m2')
    const canonicalId = fake.seedTaskListForActor('user_m2', {
      name: 'Tasks',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    const src = fake.seedTaskListForActor('user_m2', {
      name: 'Habits',
      createdAt: '2026-02-01T00:00:00.000Z',
    })
    fake.seedSeriesWithOccurrence(src, { title: 'Stretch', freq: 'weekly', byDay: ['MO', 'WE'], count: 4 })

    await app.request('http://localhost/api/v1/ui/lists', { headers: headers(bearer) })

    // The series now lives on the canonical list (rebuilt), and its occurrence
    // items carry the NEW canonical series id. The source series is gone.
    const canonSeries = fake.seriesSnapshot().filter((s) => s.listId === canonicalId)
    expect(canonSeries).toHaveLength(1)
    expect(canonSeries[0].title).toBe('Stretch')
    expect(canonSeries[0].byDay).toEqual(['MO', 'WE'])
    expect(fake.seriesSnapshot().filter((s) => s.listId === src)).toHaveLength(0)

    const canonOccurrences = fake.itemsSnapshot().filter((i) => i.listId === canonicalId && i.seriesId)
    expect(canonOccurrences.length).toBeGreaterThan(0)
    expect(canonOccurrences.every((i) => i.seriesId === canonSeries[0].id)).toBe(true)
    // Source list emptied of items + series.
    expect(fake.itemsSnapshot().filter((i) => i.listId === src)).toHaveLength(0)
  })

  it('merge: differing custom-field defs are unified by (label, type) and item values remapped', async () => {
    const bearer = await loginAs('user_m3')
    const canonicalId = fake.seedTaskListForActor('user_m3', {
      name: 'Tasks',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    const src = fake.seedTaskListForActor('user_m3', {
      name: 'Project',
      createdAt: '2026-02-01T00:00:00.000Z',
    })
    // Canonical already has an "Effort" number field; source has its own
    // "Effort" (same label+type → reused) plus a unique "Tag" text field.
    const canonEffort = fake.seedFieldDef(canonicalId, { label: 'Effort', fieldType: 'number' })
    const srcEffort = fake.seedFieldDef(src, { label: 'Effort', fieldType: 'number' })
    const srcTag = fake.seedFieldDef(src, { label: 'Tag', fieldType: 'text' })
    fake.seedItem(src, {
      title: 'Design',
      customFields: { [srcEffort]: 5, [srcTag]: 'ui' },
    })

    await app.request('http://localhost/api/v1/ui/lists', { headers: headers(bearer) })

    // Canonical defs: the reused Effort (one only — not duplicated) + a new Tag.
    const canonDefs = fake.fieldDefsSnapshot().filter((d) => d.listId === canonicalId)
    const effortDefs = canonDefs.filter((d) => d.label === 'Effort' && d.fieldType === 'number')
    expect(effortDefs).toHaveLength(1) // not duplicated
    expect(effortDefs[0].id).toBe(canonEffort)
    const tagDef = canonDefs.find((d) => d.label === 'Tag')
    expect(tagDef).toBeTruthy()

    // The moved item's customFields are remapped to the canonical def ids.
    const moved = fake.itemsSnapshot().find((i) => i.listId === canonicalId && i.title === 'Design')
    expect(moved?.customFields[canonEffort]).toBe(5)
    expect(moved?.customFields[tagDef!.id]).toBe('ui')
    // The stale source def ids must not leak into the canonical item.
    expect(moved?.customFields[srcEffort]).toBeUndefined()
    expect(moved?.customFields[srcTag]).toBeUndefined()
  })

  it('merge is idempotent: running GET /lists twice does not duplicate items', async () => {
    const bearer = await loginAs('user_m4')
    const canonicalId = fake.seedTaskListForActor('user_m4', {
      name: 'Tasks',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    const src = fake.seedTaskListForActor('user_m4', {
      name: 'Extra',
      createdAt: '2026-02-01T00:00:00.000Z',
    })
    fake.seedItem(src, { title: 'A' })
    fake.seedItem(src, { title: 'B' })

    await app.request('http://localhost/api/v1/ui/lists', { headers: headers(bearer) })
    const afterFirst = fake.itemsSnapshot().filter((i) => i.listId === canonicalId).map((i) => i.title).sort()
    expect(afterFirst).toEqual(['A', 'B'])

    await app.request('http://localhost/api/v1/ui/lists', { headers: headers(bearer) })
    const afterSecond = fake.itemsSnapshot().filter((i) => i.listId === canonicalId).map((i) => i.title).sort()
    // No duplication on the second pass.
    expect(afterSecond).toEqual(['A', 'B'])
  })

  it('merge: notes + shopping lists are never treated as task sources', async () => {
    const bearer = await loginAs('user_m5')
    const canonicalId = fake.seedTaskListForActor('user_m5', {
      name: 'Tasks',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    // Seed a notes list (under the same legacy-named personal group) with an item.
    const notesId = fake.seedNotesListForActor('user_m5')
    fake.seedItem(notesId, { title: 'a private note' })

    await app.request('http://localhost/api/v1/ui/lists', { headers: headers(bearer) })

    // The note stays on the notes list; it is NOT folded into Tasks.
    expect(fake.itemsSnapshot().filter((i) => i.listId === notesId)).toHaveLength(1)
    expect(fake.itemsSnapshot().filter((i) => i.listId === canonicalId)).toHaveLength(0)
  })

  // --- RPL↔RPP separation (#531): no shared lists in Planner ----------

  it('GET /lists/:listId/items 404s for a non-personal list (IDOR guard)', async () => {
    const bearer = await loginAs('user_sl3')
    // A foreign list — never reachable now that flagged shared lists are gone.
    const foreignId = fake.seedForeignList()

    const res = await app.request(
      `http://localhost/api/v1/ui/lists/${foreignId}/items`,
      { headers: headers(bearer) },
    )
    expect(res.status).toBe(404)
    // The ungated SDK read must never have been reached.
    expect(fake.calls.some((c) => c.method === 'listItems')).toBe(false)
  })

  it('PUT /lists/:listId/planner-pref no longer exists (404)', async () => {
    const bearer = await loginAs('user_sl4')

    const res = await app.request(
      'http://localhost/api/v1/ui/lists/lst_any/planner-pref',
      {
        method: 'PUT',
        headers: headers(bearer, { 'content-type': 'application/json' }),
        body: JSON.stringify({ show: false }),
      },
    )
    expect(res.status).toBe(404)
  })

  // --- quick-add path: dueDate + priority forwarding (#430) ----------
  // These tests exercise the quick-add use case — POST /items with
  // dueDate and priority, matching the shape the widened createTaskItem
  // client helper sends after the #430 change.

  it('POST /items with dueDate + priority persists both fields', async () => {
    const bearer = await loginAs('user_qa1')
    const listId = await createList(bearer, 'Quick Add Test')

    // Local-midnight instant for 2026-06-15 (simulates dateInputToInstant output).
    // We send a fixed UTC instant here since the BFF is tz-agnostic — it stores
    // whatever ISO string it receives. The conversion is tested on the client side.
    const dueDateInstant = new Date(2026, 5, 15).toISOString()
    const res = await app.request(
      `http://localhost/api/v1/ui/lists/${listId}/items`,
      {
        method: 'POST',
        headers: headers(bearer, { 'content-type': 'application/json' }),
        body: JSON.stringify({ title: 'Buy groceries', dueDate: dueDateInstant, priority: 'high' }),
      },
    )
    expect(res.status).toBe(201)
    const item = (await res.json()) as ListItemDto
    expect(item.title).toBe('Buy groceries')
    expect(item.dueDate).toBe(dueDateInstant)
    expect(item.priority).toBe('high')

    // Confirm the SDK received exactly the values the BFF forwarded.
    const sdkCall = fake.calls.find((c) => c.method === 'createListItem')
    expect(sdkCall?.actor).toBe('user_qa1')
    const sdkInput = sdkCall?.args[1] as { dueDate?: string; priority?: string } | undefined
    expect(sdkInput?.dueDate).toBe(dueDateInstant)
    expect(sdkInput?.priority).toBe('high')
  })

  it('POST /items without dueDate or priority preserves server defaults (priority=medium, dueDate=null)', async () => {
    const bearer = await loginAs('user_qa2')
    const listId = await createList(bearer, 'Title Only List')

    const res = await app.request(
      `http://localhost/api/v1/ui/lists/${listId}/items`,
      {
        method: 'POST',
        headers: headers(bearer, { 'content-type': 'application/json' }),
        body: JSON.stringify({ title: 'Just a title' }),
      },
    )
    expect(res.status).toBe(201)
    const item = (await res.json()) as ListItemDto
    expect(item.title).toBe('Just a title')
    // The fake SDK's createListItem defaults priority to 'medium' and dueDate to null
    // when omitted — matching lists-api behaviour.
    expect(item.priority).toBe('medium')
    expect(item.dueDate).toBeNull()
  })

  // --- asymmetric quick-add cases: null priority + isolated dueDate (#430 P3) ----

  it('POST /items with priority:null creates a no-priority task (null stored)', async () => {
    // Lock: quick-add sends explicit priority:null; the BFF must pass it through
    // to the SDK without coercing to 'medium'. This is the P2 fix in #430.
    const bearer = await loginAs('user_qa3')
    const listId = await createList(bearer, 'Null Priority List')

    const res = await app.request(
      `http://localhost/api/v1/ui/lists/${listId}/items`,
      {
        method: 'POST',
        headers: headers(bearer, { 'content-type': 'application/json' }),
        body: JSON.stringify({ title: 'No priority task', priority: null }),
      },
    )
    expect(res.status).toBe(201)
    const item = (await res.json()) as ListItemDto
    expect(item.title).toBe('No priority task')
    // null must survive all the way through — not coerced to 'medium'.
    expect(item.priority).toBeNull()
    expect(item.dueDate).toBeNull()

    // Confirm the SDK received null, not 'medium'.
    const sdkCall = fake.calls.find((c) => c.method === 'createListItem' && c.actor === 'user_qa3')
    const sdkInput = sdkCall?.args[1] as { priority?: string | null } | undefined
    expect(sdkInput?.priority).toBeNull()
  })

  it('POST /items with dueDate only (priority omitted) applies server default priority=medium', async () => {
    // Asymmetric: dueDate set, priority omitted → server default kicks in.
    const bearer = await loginAs('user_qa4')
    const listId = await createList(bearer, 'Due Only List')
    const dueDateInstant = new Date(2026, 8, 1).toISOString()

    const res = await app.request(
      `http://localhost/api/v1/ui/lists/${listId}/items`,
      {
        method: 'POST',
        headers: headers(bearer, { 'content-type': 'application/json' }),
        body: JSON.stringify({ title: 'Has due', dueDate: dueDateInstant }),
      },
    )
    expect(res.status).toBe(201)
    const item = (await res.json()) as ListItemDto
    expect(item.dueDate).toBe(dueDateInstant)
    // Priority was omitted → server default 'medium'.
    expect(item.priority).toBe('medium')
  })

  it('POST /items with priority set but no dueDate stores dueDate=null', async () => {
    // Asymmetric: priority set, dueDate omitted → dueDate stays null.
    const bearer = await loginAs('user_qa5')
    const listId = await createList(bearer, 'Priority Only List')

    const res = await app.request(
      `http://localhost/api/v1/ui/lists/${listId}/items`,
      {
        method: 'POST',
        headers: headers(bearer, { 'content-type': 'application/json' }),
        body: JSON.stringify({ title: 'Has priority', priority: 'low' }),
      },
    )
    expect(res.status).toBe(201)
    const item = (await res.json()) as ListItemDto
    expect(item.priority).toBe('low')
    expect(item.dueDate).toBeNull()
  })
})

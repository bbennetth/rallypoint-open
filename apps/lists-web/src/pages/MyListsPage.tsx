import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { VISIBILITIES, type Visibility } from '@rallypoint/lists-shared'
import {
  ApiError,
  createGroup,
  createList,
  listGroups,
  listLists,
  listSharedWithMe,
  signout,
  type GroupDto,
  type ListDto,
} from '../lib/api.js'
import { shouldRefetch, subscribeScopeStream } from '../lib/realtime.js'
import { getDb, purgeUserDb } from '../lib/offline/db.js'
import { engine } from '../lib/offline/engine.js'
import { readScopeLists, scopeKey, writeScopeLists } from '../lib/offline/cache-accessors.js'
import { partitionByOrigin } from '../lib/list-origin.js'
import { DEFAULT_GROUP_NAME, needsDefaultGroup, selectDefaultGroupId } from '../lib/default-group.js'

// Slice-2 "My Lists": pick a list_group you belong to, create lists
// in it, and open one to manage items. Lists are list_group-scoped
// post-#128 — events-group scopes are cross-app and reach lists-api
// only via the SDK (gated by EVENTS_API_KEY).

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; items: ListDto[] }
  | { status: 'error'; error: ApiError | Error }

// #128: lists-api UI surface now serves only lists owned by Lists.
// scope_type='group' (events groups) returns 404. Lists-local scope is
// 'list_group'; the user's groups in lists-api ARE the list_groups.
const SCOPE_TYPE = 'list_group' as const

interface MyListsPageProps {
  selfUserId: string
}

export function MyListsPage({ selfUserId }: MyListsPageProps) {
  const [groups, setGroups] = useState<GroupDto[]>([])
  // `scopeId === null` means "no group selected" — the user has zero
  // groups yet, so creation is disabled and we show a CTA to make one.
  const [scopeId, setScopeId] = useState<string | null>(null)
  const [name, setName] = useState('')
  // #128: new lists default to 'private' so a creator's notes don't
  // surface to every group member by default. The toggle below lets
  // the user flip to 'all' when they want the whole group to see it.
  const [visibility, setVisibility] = useState<Visibility>('private')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [newGroupName, setNewGroupName] = useState('')
  const [creatingGroup, setCreatingGroup] = useState(false)
  const [groupError, setGroupError] = useState<string | null>(null)
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  // "Shared with me" — private lists the user has been added to via the
  // share-by-email flow. They live in someone else's list_group, so
  // they don't surface in the scope listing above.
  const [sharedItems, setSharedItems] = useState<ListDto[]>([])

  async function loadGroups() {
    try {
      const page = await listGroups()
      let items = page.items
      // A user shouldn't have to create a group before making a list, so
      // auto-provision a writable "home" group when they have none. The
      // Planner "My Tasks" group is read-only here (#531), so it doesn't
      // count — a user with only that group still needs a Lists default.
      // createGroup is conflict-tolerant on (created_by, name), so this is
      // idempotent across tabs / reloads.
      if (needsDefaultGroup(items)) {
        try {
          const created = await createGroup({ name: DEFAULT_GROUP_NAME })
          items = [created, ...items]
        } catch {
          // Non-fatal: the manual "create group" form is still available.
        }
      }
      setGroups(items)
      // Default-select the first writable group so the create form lands on
      // a scope the user can actually write to, without forcing a pick from
      // a single-option dropdown. Falls back to the first group only if
      // provisioning failed and the user is left with just a read-only
      // Planner group (the #531 read-only banner then covers that case).
      const defaultId = selectDefaultGroupId(items) ?? items[0]?.id ?? null
      if (defaultId !== null) {
        setScopeId((prev) => prev ?? defaultId)
      }
    } catch {
      setGroups([])
    }
  }

  // `silent` skips the loading flash so a realtime refetch doesn't blank
  // the list when another member adds a list in this scope.
  async function load(scope: string | null, opts: { silent?: boolean } = {}) {
    if (scope === null) {
      setState({ status: 'ready', items: [] })
      return
    }
    if (!opts.silent) setState({ status: 'loading' })
    const db = getDb(selfUserId)
    const key = scopeKey(SCOPE_TYPE, scope)
    try {
      const page = await listLists({ scopeType: SCOPE_TYPE, scopeId: scope })
      void writeScopeLists(db, key, page.items)
      setState({ status: 'ready', items: page.items })
    } catch (err) {
      // Offline: serve the last-known list-of-lists for this scope rather than
      // a hard error, so the user can still navigate into a cached list.
      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        const cached = await readScopeLists(db, key)
        if (cached) {
          setState({ status: 'ready', items: cached })
          return
        }
      }
      setState({ status: 'error', error: err instanceof Error ? err : new Error(String(err)) })
    }
  }

  async function loadShared() {
    try {
      const page = await listSharedWithMe()
      setSharedItems(page.items)
    } catch {
      setSharedItems([])
    }
  }

  useEffect(() => {
    void loadGroups()
    void loadShared()
  }, [])

  useEffect(() => {
    void load(scopeId)
  }, [scopeId])

  // Live updates: refetch (silently) when another member creates a list in
  // the scope currently in view. loadRef keeps the subscription stable
  // across renders while always calling the freshest load.
  const loadRef = useRef(load)
  loadRef.current = load
  useEffect(() => {
    if (scopeId === null) return
    return subscribeScopeStream(SCOPE_TYPE, scopeId, {
      onEvent: (env) => {
        if (shouldRefetch(env, selfUserId)) void loadRef.current(scopeId, { silent: true })
      },
      onReconnect: () => void loadRef.current(scopeId, { silent: true }),
    })
  }, [scopeId, selfUserId])

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    if (creating || scopeId === null) return
    setCreating(true)
    setCreateError(null)
    try {
      await createList({
        name,
        listType: 'standard',
        scopeType: SCOPE_TYPE,
        scopeId,
        visibility,
      })
      setName('')
      await load(scopeId)
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.message : 'Create failed.')
    } finally {
      setCreating(false)
    }
  }

  async function handleCreateGroup(e: React.FormEvent) {
    e.preventDefault()
    if (creatingGroup || newGroupName.trim().length === 0) return
    setCreatingGroup(true)
    setGroupError(null)
    try {
      const group = await createGroup({ name: newGroupName })
      setNewGroupName('')
      await loadGroups()
      setScopeId(group.id) // switch to the new group
    } catch (err) {
      setGroupError(err instanceof ApiError ? err.message : 'Create failed.')
    } finally {
      setCreatingGroup(false)
    }
  }

  async function handleSignOut() {
    try {
      // Clear this user's offline cache + outbox before dropping the session
      // (shared-device safety) — see AppChrome.handleSignout.
      engine.dispose(selfUserId)
      await purgeUserDb(selfUserId)
      await signout()
    } finally {
      window.location.assign('/')
    }
  }

  const scopeLabel =
    scopeId === null
      ? 'No group'
      : (groups.find((g) => g.id === scopeId)?.name ?? scopeId)

  // The whole scope is Planner-managed when its group was provisioned by
  // the Planner BFF — every list in it is read-only here (#531).
  const scopeIsPlanner = groups.find((g) => g.id === scopeId)?.origin === 'planner'

  const visibleLists = state.status === 'ready' ? state.items : []
  // Your own lists vs. the lists Planner creates and manages — rendered
  // as separate sections below.
  const { own: ownLists, plannerManaged } = partitionByOrigin(visibleLists, scopeIsPlanner)

  return (
    <main className="page-pad">
      <div className="content-cap mx-auto space-y-6">
        <header className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <p className="text-xs" style={{ color: 'var(--ink-dim)' }}>Rallypoint Lists</p>
            <h1 className="display text-2xl mt-1">My Lists</h1>
          </div>
          <button
            type="button"
            onClick={() => void handleSignOut()}
            className="btn-ghost"
            style={{ width: 'auto' }}
          >
            Sign out
          </button>
        </header>

        <section
          className="p-4 space-y-3"
          style={{ border: '1.5px solid var(--line)', background: 'var(--surface)' }}
        >
          <label className="block text-sm text-[color:var(--ink-dim)]">
            Scope
            <select
              value={scopeId ?? ''}
              onChange={(e) => setScopeId(e.target.value || null)}
              className="cyber-input mt-1 capitalize"
            >
              {groups.length === 0 && (
                <option value="">No group yet — create one below</option>
              )}
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          </label>

          <form onSubmit={(e) => void handleCreateGroup(e)} className="flex items-end gap-3">
            <label className="flex-1 text-sm text-[color:var(--ink-dim)]">
              New group
              <input
                value={newGroupName}
                onChange={(e) => setNewGroupName(e.target.value)}
                placeholder="Road group"
                className="cyber-input mt-1"
              />
            </label>
            <button
              type="submit"
              disabled={creatingGroup || newGroupName.trim().length === 0}
              className="btn-ghost"
              style={{ width: 'auto' }}
            >
              {creatingGroup ? 'Creating…' : 'Create group'}
            </button>
          </form>
          {groupError && (
            <p className="text-sm" style={{ color: 'var(--hot)' }}>
              {groupError}
            </p>
          )}
        </section>

        {scopeIsPlanner && (
          <div
            className="p-4 text-sm"
            style={{
              border: '1.5px solid var(--line)',
              background: 'var(--surface)',
              color: 'var(--ink-dim)',
            }}
          >
            This group is managed by Rallypoint Planner. Its lists are
            read-only here — open Planner to add or edit tasks.
          </div>
        )}

        {!scopeIsPlanner && (
        <section
          className="p-4 space-y-3"
          style={{ border: '1.5px solid var(--line)', background: 'var(--surface)' }}
        >
          <form onSubmit={(e) => void handleCreate(e)} className="flex flex-wrap items-end gap-3">
            <label className="flex-1 min-w-40 text-sm text-[color:var(--ink-dim)]">
              List name
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Camp tasks"
                className="cyber-input mt-1"
              />
            </label>
            <label className="text-sm text-[color:var(--ink-dim)]">
              Visibility
              <select
                value={visibility}
                onChange={(e) => setVisibility(e.target.value as Visibility)}
                className="cyber-input mt-1 capitalize"
                style={{ width: 'auto' }}
                title="Private: only you + people you share with. All: every group member."
              >
                {VISIBILITIES.map((v) => (
                  <option key={v} value={v}>
                    {v === 'all' ? 'Group' : 'Private (you + shares)'}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="submit"
              disabled={creating || name.trim().length === 0 || scopeId === null}
              className="btn-brutal"
              style={{ width: 'auto' }}
            >
              {creating ? 'Creating…' : 'Create list'}
            </button>
          </form>
          {createError && (
            <p className="text-sm" style={{ color: 'var(--hot)' }}>
              {createError}
            </p>
          )}
        </section>
        )}

        {state.status === 'loading' && <p className="text-[color:var(--ink-dim)] text-sm">Loading…</p>}

        {state.status === 'error' && (
          <div
            className="p-4"
            style={{
              border: '1.5px solid var(--hot)',
              background: 'color-mix(in srgb, var(--hot) 12%, transparent)',
            }}
          >
            <p className="text-sm" style={{ color: 'var(--ink)' }}>
              {state.error instanceof ApiError
                ? `${state.error.code}: ${state.error.message}`
                : state.error.message}
            </p>
            <button
              type="button"
              onClick={() => void load(scopeId)}
              className="mt-3 text-sm underline"
              style={{ color: 'var(--ink-dim)' }}
            >
              Try again
            </button>
          </div>
        )}

        {state.status === 'ready' && visibleLists.length === 0 && (
          <div
            className="p-6 text-center text-[color:var(--ink-dim)] text-sm"
            style={{ border: '1.5px solid var(--line)', background: 'var(--surface)' }}
          >
            No lists in <span className="text-[color:var(--ink)]">{scopeLabel}</span> yet.
          </div>
        )}

        {state.status === 'ready' && ownLists.length > 0 && (
          <ul className="space-y-3">
            {ownLists.map((list) => (
              <li key={list.id}>
                <Link
                  to={`/me/lists/${list.id}`}
                  className="block p-4 transition-colors"
                  style={{ border: '1.5px solid var(--line)', background: 'var(--surface)' }}
                >
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium">{list.name}</span>
                    <span className="chip capitalize">{list.list_type}</span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}

        {/* Lists Planner creates and manages (task lists in its personal
            group plus the Shopping / Notes tabs). Read-only in this app —
            open Planner to edit them (#531). */}
        {state.status === 'ready' && plannerManaged.length > 0 && (
          <section className="space-y-3">
            <h2 style={{ fontSize: 12, color: 'var(--ink-dim)' }}>
              Managed by Planner ({plannerManaged.length})
            </h2>
            <p className="text-xs" style={{ color: 'var(--ink-mute)' }}>
              Created by Rallypoint Planner. Read-only here — open Planner
              to add or edit items.
            </p>
            <ul className="space-y-3">
              {plannerManaged.map((list) => (
                <li key={list.id}>
                  <Link
                    to={`/me/lists/${list.id}`}
                    className="block p-4 transition-colors"
                    style={{ border: '1.5px solid var(--line)', background: 'var(--surface)' }}
                  >
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium">{list.name}</span>
                      <span className="chip capitalize">{list.list_type}</span>
                      <span className="chip" style={{ fontSize: 10, color: 'var(--ink-dim)' }}>
                        Planner
                      </span>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* Shared with me: private lists you've been added to but
            that live in someone else's list_group. They won't appear
            in the scope listing above; this is the only in-app way to
            rediscover them after the initial accept-invite redirect. */}
        {sharedItems.length > 0 && (
          <section className="space-y-3">
            <h2
              style={{
                fontSize: 12,
                color: 'var(--ink-dim)',
              }}
            >
              Shared with me ({sharedItems.length})
            </h2>
            <ul className="space-y-3">
              {sharedItems.map((list) => (
                <li key={list.id}>
                  <Link
                    to={`/me/lists/${list.id}`}
                    className="block p-4 transition-colors"
                    style={{ border: '1.5px solid var(--line)', background: 'var(--surface)' }}
                  >
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium">{list.name}</span>
                      <span className="chip capitalize">{list.list_type}</span>
                      <span
                        className="chip"
                        style={{ fontSize: 10, color: 'var(--ink-dim)' }}
                      >
                        Shared
                      </span>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </main>
  )
}

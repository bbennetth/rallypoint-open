import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { VISIBILITIES, type Visibility } from '@rallypoint/lists-shared'
import {
  ApiError,
  createGroup,
  createList,
  listGroups,
  listLists,
  listPlannerPrefs,
  listSharedWithMe,
  setListPlannerPref,
  signout,
  type GroupDto,
  type ListDto,
} from '../lib/api.js'
import { shouldRefetch, subscribeScopeStream } from '../lib/realtime.js'

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
  // Per-user "show in Planner" flags — a Set of list ids the current
  // user has toggled on. Loaded once on mount; updated optimistically.
  const [plannerSet, setPlannerSet] = useState<Set<string>>(new Set())
  const [plannerError, setPlannerError] = useState<string | null>(null)

  async function loadGroups() {
    try {
      const page = await listGroups()
      setGroups(page.items)
      // Auto-select the first group if no selection yet, so the UI lands
      // on a usable scope without forcing the user to pick from a
      // single-option dropdown.
      if (page.items.length > 0) {
        setScopeId((prev) => prev ?? page.items[0]!.id)
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
    try {
      const page = await listLists({ scopeType: SCOPE_TYPE, scopeId: scope })
      setState({ status: 'ready', items: page.items })
    } catch (err) {
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

  async function loadPlannerPrefs() {
    try {
      const ids = await listPlannerPrefs()
      setPlannerSet(new Set(ids))
    } catch {
      // Non-fatal: prefs simply appear unset on error.
      setPlannerSet(new Set())
    }
  }

  async function handlePlannerToggle(listId: string, e: React.MouseEvent | React.ChangeEvent) {
    // Prevent the parent <Link> from navigating.
    e.stopPropagation()
    if ('preventDefault' in e) e.preventDefault()

    const next = !plannerSet.has(listId)
    // Optimistic update.
    setPlannerSet((prev) => {
      const copy = new Set(prev)
      if (next) copy.add(listId)
      else copy.delete(listId)
      return copy
    })
    setPlannerError(null)

    try {
      await setListPlannerPref(listId, next)
    } catch (err) {
      // Revert on failure.
      setPlannerSet((prev) => {
        const copy = new Set(prev)
        if (next) copy.delete(listId)
        else copy.add(listId)
        return copy
      })
      setPlannerError(err instanceof ApiError ? err.message : 'Could not update Planner preference.')
    }
  }

  useEffect(() => {
    void loadGroups()
    void loadShared()
    void loadPlannerPrefs()
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
      await signout()
    } finally {
      window.location.assign('/')
    }
  }

  const scopeLabel =
    scopeId === null
      ? 'No group'
      : (groups.find((g) => g.id === scopeId)?.name ?? scopeId)

  const visibleLists = state.status === 'ready' ? state.items : []

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

        {plannerError && (
          <p className="text-sm" style={{ color: 'var(--hot)' }}>
            {plannerError}
          </p>
        )}

        {state.status === 'ready' && visibleLists.length > 0 && (
          <ul className="space-y-3">
            {visibleLists.map((list) => (
              <li key={list.id}>
                <div
                  className="flex items-stretch transition-colors"
                  style={{ border: '1.5px solid var(--line)', background: 'var(--surface)' }}
                >
                  <Link
                    to={`/me/lists/${list.id}`}
                    className="flex-1 block p-4"
                  >
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium">{list.name}</span>
                      <span className="chip capitalize">{list.list_type}</span>
                    </div>
                  </Link>
                  <label
                    className="flex items-center gap-1.5 px-3 cursor-pointer text-xs"
                    style={{ color: 'var(--ink-dim)', borderLeft: '1px solid var(--line)' }}
                    title={plannerSet.has(list.id) ? 'Remove from Planner' : 'Show in Planner'}
                  >
                    <input
                      type="checkbox"
                      checked={plannerSet.has(list.id)}
                      onChange={(e) => void handlePlannerToggle(list.id, e)}
                      aria-label={`Show "${list.name}" in Planner`}
                      className="cyber-checkbox"
                    />
                    <span className="whitespace-nowrap">Planner</span>
                  </label>
                </div>
              </li>
            ))}
          </ul>
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

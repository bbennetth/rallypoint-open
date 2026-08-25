import { useEffect, useMemo, useRef, useState } from 'react'
import { useAsyncTask } from '@rallypoint/web-kit'
import {
  getList,
  listFieldDefs,
  listGroupMembers,
  listGroups,
  listItems,
  listLabels,
  listLists,
  listStatuses,
  type FieldDefDto,
  type GroupMemberDto,
  type LabelDto,
  type ListDto,
  type ListItemDto,
  type ListStatusDto,
} from './api.js'
import type { ApiError } from './api.js'
import { getDb } from './offline/db.js'
import {
  readListSnapshot,
  readPendingOps,
  writeListSnapshot,
} from './offline/cache-accessors.js'
import { applyOpsToItems } from './offline/outbox-reducers.js'
import { subscribeRefresh } from './offline/refresh-bus.js'
import { resolvePlannerReadOnly } from './list-origin.js'
import { shouldRefetch, subscribeListStream } from './realtime.js'
import type { FilterSortValue } from '../components/FilterSortBar.js'

export type LoadState =
  | { status: 'loading' }
  | {
      status: 'ready'
      list: ListDto
      items: ListItemDto[]
      fieldDefs: FieldDefDto[]
      // Custom kanban statuses — only fetched for `tasks` lists (the board
      // surface); empty for standard lists, which key off `completed`.
      statuses: ListStatusDto[]
      // Per-list labels (RPL v1.0.0 S12) — any list type may carry labels.
      labels: LabelDto[]
      // True when the list lives in a Planner-provisioned group — the UI
      // surface serves it read-only (#531), so mutating affordances hide.
      readOnly: boolean
    }
  | { status: 'error'; error: ApiError | Error }

// Owns the list-detail load/refetch machinery: the LoadState state
// machine, members/moveTargets/viewsReloadKey, the generation-gated
// load(), the offline fallback, and the realtime + outbox-refresh
// subscriptions that trigger silent reloads.
export function useListLoad(listId: string | undefined, selfUserId: string, query: FilterSortValue) {
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  const [members, setMembers] = useState<GroupMemberDto[]>([])
  // Other lists in the same scope, offered as move targets on task cards.
  const [moveTargets, setMoveTargets] = useState<ListDto[]>([])
  // Bumped on a realtime list_views envelope to reload the saved-view list
  // (slice 5). The view set lives in ViewSwitcher's own state.
  const [viewsReloadKey, setViewsReloadKey] = useState(0)

  // Generation gate: a list switch (useParams id change) or a superseding
  // refetch keeps this page mounted, so an older load resolving last must not
  // commit over the newer one — a stale render here would let `patch` /
  // `handleDelete` target the wrong list. `ctx.stale()` guards every commit.
  const run = useAsyncTask()

  // `silent` skips the loading flash — used by realtime refetches so a
  // collaborator's edit doesn't blank the page out from under the viewer.
  async function load(opts: { silent?: boolean } = {}) {
    if (!listId) return
    if (!opts.silent) setState({ status: 'loading' })
    await run(async (ctx) => {
      try {
        const [list, page, defs, labelPage] = await Promise.all([
          getList(listId),
          listItems(listId, query),
          listFieldDefs(listId),
          listLabels(listId),
        ])
        // Statuses back the kanban board only; fetching also lazy-seeds the
        // defaults server-side, so don't touch them on a standard list. The
        // board can't render without them, so let a failure bubble to the
        // outer catch (page error state) rather than silently show no columns.
        const statuses: ListStatusDto[] =
          list.list_type === 'tasks' ? (await listStatuses(listId)).items : []
        // Planner-origin groups are read-only on this surface (#531). The
        // group lookup is best-effort, but fail CLOSED (#675): a lookup
        // failure must not silently render mutating controls the server
        // will 403 on anyway — the server check still backstops every
        // mutation, but the UI shouldn't dangle affordances it can't honor.
        let groupsLookup: Awaited<ReturnType<typeof listGroups>> | null = null
        if (list.scope_type === 'list_group') {
          try {
            groupsLookup = await listGroups()
          } catch {
            groupsLookup = null
          }
        }
        const readOnly = resolvePlannerReadOnly(list.scope_type, list.scope_id, groupsLookup)
        // Write the whole page through to the offline cache, then fold any
        // still-pending outbox ops over the server truth so a just-made
        // optimistic edit isn't clobbered by this refetch. The cache write is
        // fire-and-forget and desirable even if this load is superseded, so it
        // stays outside the stale check; only the render commit is gated.
        const db = getDb(selfUserId)
        void writeListSnapshot(db, listId, {
          list,
          items: page.items,
          fieldDefs: defs.items,
          labels: labelPage.items,
          statuses,
          readOnly,
        })
        const pending = await readPendingOps(db, listId)
        if (ctx.stale()) return
        setState({
          status: 'ready',
          list,
          items: applyOpsToItems(page.items, pending, selfUserId),
          fieldDefs: defs.items,
          statuses,
          labels: labelPage.items,
          readOnly,
        })
        // Group-scoped lists can assign items to a member; group scopes
        // defer to the Events group roster (not wired in this slice).
        if (list.scope_type === 'list_group') {
          try {
            const members = (await listGroupMembers(list.scope_id)).items
            if (ctx.stale()) return
            setMembers(members)
          } catch {
            if (ctx.stale()) return
            setMembers([])
          }
        } else {
          setMembers([])
        }
        // Move targets only matter on the task board; load the sibling
        // task lists in this scope (drop the current one and any non-task
        // list — a kanban task only moves between task lists).
        if (list.list_type === 'tasks') {
          try {
            const targets = await listLists({ scopeType: list.scope_type, scopeId: list.scope_id })
            if (ctx.stale()) return
            setMoveTargets(targets.items.filter((l) => l.id !== list.id && l.list_type === 'tasks'))
          } catch {
            if (ctx.stale()) return
            setMoveTargets([])
          }
        } else {
          setMoveTargets([])
        }
      } catch (err) {
        // Offline: rehydrate the page from the cached snapshot (folding pending
        // ops on top) instead of a hard error. Only when actually offline — an
        // online failure (e.g. 404 deleted list) should still surface.
        if (typeof navigator !== 'undefined' && !navigator.onLine) {
          const db = getDb(selfUserId)
          const snap = await readListSnapshot(db, listId)
          if (snap) {
            const pending = await readPendingOps(db, listId)
            if (ctx.stale()) return
            setState({
              status: 'ready',
              list: snap.list,
              items: applyOpsToItems(snap.items, pending, selfUserId),
              fieldDefs: snap.fieldDefs,
              statuses: snap.statuses,
              labels: snap.labels,
              readOnly: snap.readOnly,
            })
            return
          }
        }
        if (ctx.stale()) return
        setState({ status: 'error', error: err instanceof Error ? err : new Error(String(err)) })
      }
    })
  }

  // Refetch on list change and whenever the filter/sort query changes.
  // The query is keyed by its encoded form so the effect only re-runs on
  // an actual spec change, not on every render.
  const queryKey = useMemo(() => JSON.stringify(query), [query])
  useEffect(() => {
    void load()
  }, [listId, queryKey])

  // Live updates: refetch (silently) when another client changes an item
  // on this list. loadRef keeps the subscription stable across renders
  // while always calling the freshest load.
  const loadRef = useRef(load)
  loadRef.current = load
  useEffect(() => {
    if (!listId) return undefined
    return subscribeListStream(listId, {
      onEvent: (env) => {
        if (!shouldRefetch(env, selfUserId)) return
        if (env.resource === 'list_views') setViewsReloadKey((k) => k + 1)
        else void loadRef.current({ silent: true })
      },
      onReconnect: () => {
        // A view add/rename/delete may have been missed while the
        // connection was down — reload the switcher too, not just items.
        setViewsReloadKey((k) => k + 1)
        void loadRef.current({ silent: true })
      },
    })
  }, [listId, selfUserId])

  // The outbox flusher publishes on this bus after it drains (e.g. an offline
  // create just flushed and got its real id) — refetch silently to reconcile.
  useEffect(() => subscribeRefresh(() => void loadRef.current({ silent: true })), [])

  return { state, setState, members, moveTargets, viewsReloadKey, load, queryKey }
}

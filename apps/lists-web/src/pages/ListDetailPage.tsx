import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  ApiError,
  createItem,
  deleteItem,
  deleteList,
  getList,
  listFieldDefs,
  listGroupMembers,
  listGroups,
  listItems,
  listLabels,
  listLists,
  listStatuses,
  restoreItem,
  updateItem,
  type FieldDefDto,
  type GroupMemberDto,
  type LabelDto,
  type ListDto,
  type ListItemDto,
  type ListStatusDto,
} from '../lib/api.js'
import { TaskBoard } from '../components/TaskBoard.js'
import { ShareDrawer } from '../components/ShareDrawer.js'
import { FieldManagerDrawer } from '../components/FieldManagerDrawer.js'
import { StatusManagerDrawer } from '../components/StatusManagerDrawer.js'
import { ItemCommentsDrawer } from '../components/ItemCommentsDrawer.js'
import { LabelManagerDrawer } from '../components/LabelManagerDrawer.js'
import { LabelChips } from '../components/LabelChips.js'
import { CustomFieldsEditor } from '../components/CustomFieldsEditor.js'
import {
  FilterSortBar,
  type FilterableField,
  type FilterSortValue,
} from '../components/FilterSortBar.js'
import { ViewSwitcher } from '../components/ViewSwitcher.js'
import { BulkToolbar } from '../components/BulkToolbar.js'
import { GridView } from '../components/GridView.js'
import { resolveQueryField, type ViewMode } from '@rallypoint/lists-shared'
import { missingRequiredFieldIds } from '../lib/field-form.js'
import { shouldRefetch, subscribeListStream } from '../lib/realtime.js'
import { useSelection } from '../lib/selection.js'
import { groupItemsByStatus } from '../lib/board.js'
import { applyBoardDrop, planBoardDrop, reindexPatches, type DropTarget } from '../lib/board-dnd.js'
import {
  buildItemTree,
  flattenVisible,
  progressPercent,
  type ItemTreeNode,
} from '../lib/hierarchy-view.js'

// Built-in columns offered in the filter/sort bar on a standard list.
// Task-only columns (status/priority/due_date) and ordering hints
// (position) are intentionally excluded here.
const BUILTIN_FILTERABLE: { field: string; label: string }[] = [
  { field: 'title', label: 'Title' },
  { field: 'notes', label: 'Notes' },
  { field: 'completed', label: 'Completed' },
  { field: 'created_at', label: 'Created' },
]

// Assemble the bar's field list from the built-ins above plus each custom
// def, deriving the comparison kind through the shared resolver so the
// web and API never disagree on a field's kind.
function buildFilterableFields(fieldDefs: FieldDefDto[]): FilterableField[] {
  const defsForQuery = fieldDefs.map((d) => ({ id: d.id, fieldType: d.field_type }))
  const fields: FilterableField[] = []
  for (const b of BUILTIN_FILTERABLE) {
    const resolved = resolveQueryField(b.field, [])
    if (resolved) fields.push({ field: b.field, label: b.label, kind: resolved.kind })
  }
  for (const d of fieldDefs) {
    const resolved = resolveQueryField(d.id, defsForQuery)
    if (!resolved) continue
    const choices = (d.options.choices ?? [])
      .filter((c) => !c.archived)
      .map((c) => ({ id: c.id, label: c.label }))
    fields.push({
      field: d.id,
      label: d.label,
      kind: resolved.kind,
      ...(choices.length > 0 ? { choices } : {}),
    })
  }
  return fields
}

// List-detail surface: add items, check them off, edit, reorder,
// assign to a group member, and soft-delete with an undo. A `tasks`
// list renders the kanban board; every other list is `standard` and
// renders this flat checklist (one type covers packing/shopping/meals
// with the generic item fields — no per-purpose columns).

type LoadState =
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

export function ListDetailPage({ selfUserId }: { selfUserId: string }) {
  const { listId } = useParams<{ listId: string }>()
  const navigate = useNavigate()
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  const [members, setMembers] = useState<GroupMemberDto[]>([])
  // Other lists in the same scope, offered as move targets on task cards.
  const [moveTargets, setMoveTargets] = useState<ListDto[]>([])
  const [newTitle, setNewTitle] = useState('')
  // Draft custom-field values for the item being added (fieldId → wire
  // value); cleared after a successful add. A null from a control clears
  // the key, matching CustomFieldsEditor's clear semantics.
  const [newCustomFields, setNewCustomFields] = useState<Record<string, unknown>>({})
  // Bumped after each successful add to remount the add-form's
  // CustomFieldsEditor — clearing the values map alone leaves the local
  // draft state inside text/number controls if the field was typed into
  // but never blurred, so the stale text would linger for the next add.
  const [addResetKey, setAddResetKey] = useState(0)
  const [adding, setAdding] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  // Most-recently deleted item id, surfaced as an undo affordance.
  const [lastDeleted, setLastDeleted] = useState<string | null>(null)
  const [shareOpen, setShareOpen] = useState(false)
  const [fieldsOpen, setFieldsOpen] = useState(false)
  const [statusesOpen, setStatusesOpen] = useState(false)
  const [labelsOpen, setLabelsOpen] = useState(false)
  // Filter/sort applied server-side via the items query (Lists v2 slice 4).
  const [query, setQuery] = useState<FilterSortValue>({ filters: [], sort: [] })
  // Bumped on a realtime list_views envelope to reload the saved-view list
  // (slice 5). The view set lives in ViewSwitcher's own state.
  const [viewsReloadKey, setViewsReloadKey] = useState(0)
  // Row selection for bulk actions, shared across checklist / grid / board
  // (slice 6 + RPL v1.0.0 S6). The bulk toolbar appears while non-empty;
  // cleared on list change / refetch.
  const selection = useSelection()
  // 'list' (checklist) vs 'grid' (spreadsheet) for a standard list (slice 7).
  // Restored from / persisted into the active saved view via ViewSwitcher.
  const [viewMode, setViewMode] = useState<ViewMode>('list')
  // Sub-item nesting (RPL v1.0.0 S5): collapsed parent ids (children hidden)
  // and the parent currently showing an inline "add sub-item" input, if any.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [addSubParent, setAddSubParent] = useState<string | null>(null)
  const [addingSub, setAddingSub] = useState(false)
  // The item whose comments thread is open (RPL v1.0.0 S7 UI), or null.
  const [commentsItem, setCommentsItem] = useState<{ id: string; title: string } | null>(null)

  // `silent` skips the loading flash — used by realtime refetches so a
  // collaborator's edit doesn't blank the page out from under the viewer.
  async function load(opts: { silent?: boolean } = {}) {
    if (!listId) return
    if (!opts.silent) setState({ status: 'loading' })
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
      // group lookup is best-effort: on failure the page renders writable
      // and the server's 403 still backstops every mutation.
      let readOnly = false
      if (list.scope_type === 'list_group') {
        try {
          const groups = await listGroups()
          readOnly = groups.items.find((g) => g.id === list.scope_id)?.origin === 'planner'
        } catch {
          readOnly = false
        }
      }
      setState({
        status: 'ready',
        list,
        items: page.items,
        fieldDefs: defs.items,
        statuses,
        labels: labelPage.items,
        readOnly,
      })
      // Group-scoped lists can assign items to a member; group scopes
      // defer to the Events group roster (not wired in this slice).
      if (list.scope_type === 'list_group') {
        try {
          setMembers((await listGroupMembers(list.scope_id)).items)
        } catch {
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
          const page = await listLists({ scopeType: list.scope_type, scopeId: list.scope_id })
          setMoveTargets(
            page.items.filter((l) => l.id !== list.id && l.list_type === 'tasks'),
          )
        } catch {
          setMoveTargets([])
        }
      } else {
        setMoveTargets([])
      }
    } catch (err) {
      setState({ status: 'error', error: err instanceof Error ? err : new Error(String(err)) })
    }
  }

  // Refetch on list change and whenever the filter/sort query changes.
  // The query is keyed by its encoded form so the effect only re-runs on
  // an actual spec change, not on every render.
  const queryKey = useMemo(() => JSON.stringify(query), [query])
  useEffect(() => {
    void load()
  }, [listId, queryKey])

  // Drop any stale selection / nesting UI state when the list or filter
  // changes — those ids may no longer be in view.
  useEffect(() => {
    selection.clear()
    setCollapsed(new Set())
    setAddSubParent(null)
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

  function reportError(err: unknown) {
    setActionError(err instanceof ApiError ? `${err.code}: ${err.message}` : 'Action failed.')
  }

  async function handleDeleteList() {
    if (!listId) return
    const listName = state.status === 'ready' ? state.list.name : 'this list'
    if (!window.confirm(`Delete "${listName}"? This cannot be undone.`)) return
    setActionError(null)
    try {
      await deleteList(listId)
      navigate('/me/lists')
    } catch (err) {
      reportError(err)
    }
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault()
    if (!listId || adding || newTitle.trim().length === 0) return
    // Mirror the Add button's gate: don't submit (and trigger a server 400)
    // when a required custom field is unset, e.g. on Enter in the title.
    const fieldDefs = state.status === 'ready' ? state.fieldDefs : []
    if (missingRequiredFieldIds(fieldDefs, newCustomFields).length > 0) return
    setAdding(true)
    setActionError(null)
    try {
      const customFields = Object.keys(newCustomFields).length > 0 ? newCustomFields : undefined
      await createItem(listId, { title: newTitle, ...(customFields ? { customFields } : {}) })
      setNewTitle('')
      setNewCustomFields({})
      setAddResetKey((k) => k + 1)
      await load()
    } catch (err) {
      reportError(err)
    } finally {
      setAdding(false)
    }
  }

  function setNewCustomField(fieldId: string, value: unknown | null) {
    setNewCustomFields((prev) => {
      const next = { ...prev }
      if (value === null) delete next[fieldId]
      else next[fieldId] = value
      return next
    })
  }

  async function patch(
    itemId: string,
    fields: Parameters<typeof updateItem>[2],
    opts: { silent?: boolean } = {},
  ) {
    if (!listId) return
    setActionError(null)
    try {
      await updateItem(listId, itemId, fields)
      // A silent reload keeps the ready view mounted — used by the inline
      // label picker so toggling a label doesn't blank the page and snap the
      // <details> disclosure shut between toggles.
      await load(opts.silent ? { silent: true } : {})
    } catch (err) {
      reportError(err)
    }
  }

  async function handleDelete(itemId: string) {
    if (!listId) return
    setActionError(null)
    try {
      await deleteItem(listId, itemId)
      setLastDeleted(itemId)
      await load()
    } catch (err) {
      reportError(err)
    }
  }

  async function handleUndo() {
    if (!listId || !lastDeleted) return
    setActionError(null)
    try {
      await restoreItem(listId, lastDeleted)
      setLastDeleted(null)
      await load()
    } catch (err) {
      reportError(err)
    }
  }


  // Kanban drag-drop (S3): move `activeId` onto a card or column. Plan the
  // move purely (lib/board-dnd), apply it optimistically, then persist the
  // status change + the target column's position reindex. The PATCHes are
  // self-authored, so the realtime echo is skipped; a silent reload
  // reconciles to server truth (and a failure restores it loudly).
  async function handleReorder(activeId: string, target: DropTarget) {
    if (!listId || state.status !== 'ready') return
    const cols = groupItemsByStatus(state.items, state.statuses).map((c) => ({
      statusId: c.status.id,
      itemIds: c.items.map((i) => i.id),
    }))
    const plan = planBoardDrop(cols, activeId, target)
    if (!plan) return

    const ready = state
    setState({ ...ready, items: applyBoardDrop(ready.items, plan) })
    setActionError(null)
    try {
      await Promise.all(
        reindexPatches(plan).map((p) =>
          updateItem(listId, p.id, {
            position: p.position,
            ...(p.id === plan.itemId && plan.statusChanged ? { statusId: plan.toStatusId } : {}),
          }),
        ),
      )
      await load({ silent: true })
    } catch (err) {
      reportError(err)
      await load()
    }
  }

  // Move an item up/down by swapping position values with its neighbour.
  // Appended items hold distinct positions (0,1,2,…), so the swap keeps
  // the ordering well-defined.
  async function move(items: ListItemDto[], index: number, dir: -1 | 1) {
    const other = items[index + dir]
    const cur = items[index]
    if (!other || !cur || !listId) return
    setActionError(null)
    try {
      await Promise.all([
        updateItem(listId, cur.id, { position: other.position }),
        updateItem(listId, other.id, { position: cur.position }),
      ])
      await load()
    } catch (err) {
      reportError(err)
    }
  }

  function toggleCollapse(itemId: string) {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(itemId)) next.delete(itemId)
      else next.add(itemId)
      return next
    })
  }

  // Add a sub-item under `parentId` from the inline affordance. The
  // in-flight guard stops a fast double-Enter from creating two children.
  async function handleAddSubItem(parentId: string, title: string) {
    if (!listId || addingSub || title.trim().length === 0) return
    setActionError(null)
    setAddingSub(true)
    try {
      await createItem(listId, { title: title.trim(), parentId })
      setAddSubParent(null)
      // Make sure the new child is visible.
      setCollapsed((prev) => {
        if (!prev.has(parentId)) return prev
        const next = new Set(prev)
        next.delete(parentId)
        return next
      })
      await load()
    } catch (err) {
      reportError(err)
    } finally {
      setAddingSub(false)
    }
  }

  // The item ids currently visible in the active view — all items in the
  // grid (no collapse there), but only un-collapsed rows in the checklist.
  // Drives select-all so it never sweeps in a hidden child.
  function currentVisibleIds(allItems: ListItemDto[]): string[] {
    const hidden = viewMode === 'grid' ? new Set<string>() : collapsed
    return flattenVisible(buildItemTree(allItems), hidden).map((r) => r.item.id)
  }

  // Render the checklist as a sub-item tree (RPL v1.0.0 S5): rows are the
  // tree flattened in order (children hidden under a collapsed parent),
  // indented by depth; up/down moves swap with a sibling, not a flat
  // neighbour. An inline add-sub-item input opens under the chosen parent.
  function renderChecklist(allItems: ListItemDto[]) {
    const tree = buildItemTree(allItems)
    const rows = flattenVisible(tree, collapsed)
    // id → its sibling group + index, for sibling-scoped reordering.
    const siblingInfo = new Map<string, { siblings: ListItemDto[]; index: number }>()
    const indexSiblings = (nodes: ItemTreeNode<ListItemDto>[]) => {
      const items = nodes.map((n) => n.item)
      nodes.forEach((n, i) => {
        siblingInfo.set(n.item.id, { siblings: items, index: i })
        indexSiblings(n.children)
      })
    }
    indexSiblings(tree)
    const visibleIds = rows.map((r) => r.item.id)

    return (
      <ul className="space-y-2">
        {rows.map((row) => {
          const item = row.item
          const sib = siblingInfo.get(item.id)!
          return (
            <Fragment key={item.id}>
              <ItemRow
                item={item}
                depth={row.depth}
                hasChildren={row.hasChildren}
                collapsed={collapsed.has(item.id)}
                onToggleCollapse={() => toggleCollapse(item.id)}
                onAddSubItem={() => setAddSubParent(item.id)}
                onComments={() => setCommentsItem({ id: item.id, title: item.title })}
                labels={state.status === 'ready' ? state.labels : []}
                onSetLabels={(labelIds) => void patch(item.id, { labelIds }, { silent: true })}
                members={members}
                fieldDefs={state.status === 'ready' ? state.fieldDefs : []}
                selected={selection.isSelected(item.id)}
                onSelect={(on) => selection.toggle(item.id, on)}
                onRangeSelect={() => selection.extendTo(item.id, visibleIds)}
                canMoveUp={sib.index > 0}
                canMoveDown={sib.index < sib.siblings.length - 1}
                onToggle={(completed) => void patch(item.id, { completed })}
                onRename={(title) => void patch(item.id, { title })}
                onAssign={(assignedTo) => void patch(item.id, { assignedTo })}
                onSetCustomField={(fieldId, value) =>
                  void patch(item.id, { customFields: { [fieldId]: value } })
                }
                onDelete={() => void handleDelete(item.id)}
                onMoveUp={() => void move(sib.siblings, sib.index, -1)}
                onMoveDown={() => void move(sib.siblings, sib.index, 1)}
              />
              {addSubParent === item.id && (
                <AddSubItemRow
                  depth={row.depth + 1}
                  submitting={addingSub}
                  onCancel={() => setAddSubParent(null)}
                  onSubmit={(title) => void handleAddSubItem(item.id, title)}
                />
              )}
            </Fragment>
          )
        })}
      </ul>
    )
  }

  // The kanban board (tasks lists) wants the full viewport width — columns
  // size themselves and overflow into horizontal scroll. Everything else
  // stays capped for readability.
  const isBoard = state.status === 'ready' && state.list.list_type === 'tasks'

  return (
    <main className="page-pad">
      {/* The board breaks out of the shell's 880px cap entirely (plapp-full)
          so its grid can fill the viewport; other list views stay on the
          wider-but-bounded cap (data-dense, but they starve at 860px). */}
      <div
        className={`${isBoard ? 'plapp-full w-full' : 'content-cap-wide'} mx-auto space-y-6`}
      >
        <Link to="/me/lists" className="text-sm hover:underline" style={{ color: 'var(--ink-dim)' }}>
          ← All lists
        </Link>

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
              onClick={() => void load()}
              className="mt-3 text-sm underline"
              style={{ color: 'var(--ink-dim)' }}
            >
              Try again
            </button>
          </div>
        )}

        {state.status === 'ready' && (
          <>
            <header className="flex items-start justify-between gap-3 flex-wrap">
              <div>
                <p className="text-xs capitalize" style={{ color: 'var(--ink-dim)' }}>
                  {state.list.list_type} · {state.list.visibility}
                </p>
                <h1 className="display text-2xl mt-1">{state.list.name}</h1>
              </div>
              <div className="flex items-center gap-2">
                {state.readOnly && (
                  <span className="chip" style={{ color: 'var(--ink-dim)' }}>
                    Planner · read-only
                  </span>
                )}
                {/* Statuses button — board columns; creator-only on a
                    tasks list (the API enforces the same). */}
                {!state.readOnly &&
                  state.list.list_type === 'tasks' &&
                  state.list.created_by === selfUserId && (
                    <button
                      type="button"
                      onClick={() => setStatusesOpen(true)}
                      className="btn-ghost"
                      style={{ width: 'auto' }}
                    >
                      Statuses
                    </button>
                  )}
                {/* Labels button — creator-only (the API enforces the
                    same); labels apply to any list type. */}
                {!state.readOnly && state.list.created_by === selfUserId && (
                  <button
                    type="button"
                    onClick={() => setLabelsOpen(true)}
                    className="btn-ghost"
                    style={{ width: 'auto' }}
                  >
                    Labels
                  </button>
                )}
                {/* Fields button — only the list creator can define
                    custom columns (the API enforces the same). */}
                {!state.readOnly && state.list.created_by === selfUserId && (
                  <button
                    type="button"
                    onClick={() => setFieldsOpen(true)}
                    className="btn-ghost"
                    style={{ width: 'auto' }}
                  >
                    Fields
                  </button>
                )}
                {/* Share button — only the creator of a 'private' list
                    can mint share invites. 'all' lists are scope-wide
                    already; no separate sharing surface. */}
                {!state.readOnly &&
                  state.list.visibility === 'private' &&
                  state.list.created_by === selfUserId && (
                    <button
                      type="button"
                      onClick={() => setShareOpen(true)}
                      className="btn-ghost"
                      style={{ width: 'auto' }}
                    >
                      Share
                    </button>
                  )}
                {/* Delete list — creator-only; the API enforces the same. */}
                {!state.readOnly && state.list.created_by === selfUserId && (
                  <button
                    type="button"
                    onClick={() => void handleDeleteList()}
                    className="btn-ghost"
                    style={{ width: 'auto', color: 'var(--hot)', borderColor: 'var(--hot)' }}
                  >
                    Delete list
                  </button>
                )}
              </div>
            </header>

            {state.readOnly && (
              <div
                className="p-4 text-sm"
                style={{
                  border: '1.5px solid var(--line)',
                  background: 'var(--surface)',
                  color: 'var(--ink-dim)',
                }}
              >
                This list is managed by Rallypoint Planner and is read-only
                here — open Planner to add or edit items.
              </div>
            )}

            {!state.readOnly && (
            <form
              onSubmit={(e) => void handleAdd(e)}
              className="space-y-3"
              style={isBoard ? { maxWidth: '640px' } : undefined}
            >
              <div className="flex items-end gap-3">
                <label className="flex-1 text-sm text-[color:var(--ink-dim)]">
                  Add an item
                  <input
                    value={newTitle}
                    onChange={(e) => setNewTitle(e.target.value)}
                    placeholder="e.g. Bring the tent"
                    className="cyber-input mt-1"
                  />
                </label>
                <button
                  type="submit"
                  disabled={
                    adding ||
                    newTitle.trim().length === 0 ||
                    missingRequiredFieldIds(state.fieldDefs, newCustomFields).length > 0
                  }
                  className="btn-brutal"
                  style={{ width: 'auto' }}
                >
                  {adding ? 'Adding…' : 'Add'}
                </button>
              </div>
              {state.fieldDefs.length > 0 && (
                <CustomFieldsEditor
                  key={addResetKey}
                  defs={state.fieldDefs}
                  values={newCustomFields}
                  members={members}
                  onChange={setNewCustomField}
                />
              )}
            </form>
            )}

            {actionError && (
              <p className="text-sm" style={{ color: 'var(--hot)' }}>
                {actionError}
              </p>
            )}

            {lastDeleted && (
              <div
                className="flex items-center justify-between gap-3 px-4 py-2 text-sm text-[color:var(--ink)]"
                style={{ border: '1.5px solid var(--line)', background: 'var(--surface)' }}
              >
                <span>Item deleted.</span>
                <button
                  type="button"
                  onClick={() => void handleUndo()}
                  className="underline"
                  style={{ color: 'var(--ink-dim)' }}
                >
                  Undo
                </button>
              </div>
            )}

            {state.list.list_type !== 'tasks' && (
              <div className="space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <ViewSwitcher
                    listId={state.list.id}
                    fieldDefs={state.fieldDefs}
                    canEdit={state.list.created_by === selfUserId}
                    query={query}
                    onApply={setQuery}
                    viewMode={viewMode}
                    onViewMode={setViewMode}
                    reloadKey={viewsReloadKey}
                  />
                  <div className="flex items-center gap-1 text-sm" role="group" aria-label="View mode">
                    {(['list', 'grid'] as const).map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        onClick={() => setViewMode(mode)}
                        className="btn-ghost capitalize"
                        style={{
                          width: 'auto',
                          ...(viewMode === mode
                            ? { borderColor: 'var(--acid)', color: 'var(--acid)' }
                            : {}),
                        }}
                        aria-pressed={viewMode === mode}
                      >
                        {mode}
                      </button>
                    ))}
                  </div>
                </div>
                <FilterSortBar
                  fields={buildFilterableFields(state.fieldDefs)}
                  value={query}
                  onChange={setQuery}
                />
              </div>
            )}

            {state.list.list_type === 'tasks' ? (
              <div className="space-y-2">
                {!state.readOnly && selection.count > 0 && (
                  <BulkToolbar
                    listId={state.list.id}
                    selectedIds={[...selection.selected]}
                    members={members}
                    fieldDefs={state.fieldDefs}
                    statuses={state.statuses}
                    onDone={() => {
                      selection.clear()
                      void load({ silent: true })
                    }}
                    onError={reportError}
                    onClear={() => selection.clear()}
                  />
                )}
                <TaskBoard
                  items={state.items}
                  statuses={state.statuses}
                  members={members}
                  moveTargets={moveTargets}
                  fieldDefs={state.fieldDefs}
                  selectedIds={selection.selected}
                  onToggleSelect={(itemId, on) => selection.toggle(itemId, on)}
                  onComments={(itemId, title) => setCommentsItem({ id: itemId, title })}
                  labels={state.labels}
                  onSetLabels={(itemId, labelIds) => void patch(itemId, { labelIds }, { silent: true })}
                  onSetStatus={(itemId, statusId) => void patch(itemId, { statusId })}
                  onReorder={(activeId, target) => void handleReorder(activeId, target)}
                  onRename={(itemId, title) => void patch(itemId, { title })}
                  onAssign={(itemId, assignedTo) => void patch(itemId, { assignedTo })}
                  onSetPriority={(itemId, priority) => void patch(itemId, { priority })}
                  onSetDueDate={(itemId, dueDate) => void patch(itemId, { dueDate })}
                  onMove={(itemId, targetListId) => void patch(itemId, { listId: targetListId })}
                  onSetCustomField={(itemId, fieldId, value) =>
                    void patch(itemId, { customFields: { [fieldId]: value } })
                  }
                  onDelete={(itemId) => void handleDelete(itemId)}
                />
              </div>
            ) : state.items.length === 0 ? (
              <div
                className="p-6 text-center text-[color:var(--ink-dim)] text-sm"
                style={{ border: '1.5px solid var(--line)', background: 'var(--surface)' }}
              >
                {query.filters.length > 0
                  ? 'No items match the current filters.'
                  : state.readOnly
                    ? 'No items yet.'
                    : 'No items yet. Add the first one above.'}
              </div>
            ) : (
              <div className="space-y-2">
                {!state.readOnly && selection.count > 0 && (
                  <BulkToolbar
                    listId={state.list.id}
                    selectedIds={[...selection.selected]}
                    members={members}
                    fieldDefs={state.fieldDefs}
                    onDone={() => {
                      selection.clear()
                      void load({ silent: true })
                    }}
                    onError={reportError}
                    onClear={() => selection.clear()}
                  />
                )}

                {/* Column legend for the two leading checkboxes on each
                    row: the red box selects for bulk actions (select-all
                    toggles them here), the green box marks an item done. */}
                <div
                  className="flex items-center gap-3 px-3 text-xs"
                  style={{ color: 'var(--ink-dim)' }}
                >
                  {(() => {
                    // Select-all targets only the rows currently in view — a
                    // collapsed parent's hidden children must not be swept into
                    // a bulk action the user can't see. (The grid shows
                    // everything; the checklist honors collapse.)
                    const visIds = currentVisibleIds(state.items)
                    const selVis = visIds.filter((id) => selection.isSelected(id)).length
                    return (
                      <label className="flex items-center gap-2" title="Select every visible item for bulk actions">
                        <input
                          type="checkbox"
                          checked={visIds.length > 0 && selVis === visIds.length}
                          ref={(el) => {
                            if (el) el.indeterminate = selVis > 0 && selVis < visIds.length
                          }}
                          onChange={(e) => selection.replace(e.target.checked ? visIds : [])}
                          className="h-4 w-4"
                          style={{ accentColor: 'var(--hot)' }}
                        />
                        Select all
                      </label>
                    )
                  })()}
                  <span aria-hidden style={{ alignSelf: 'stretch', borderLeft: '1px solid var(--line)' }} />
                  <span className="flex items-center gap-1.5" title="The green checkbox marks an item complete">
                    <span
                      aria-hidden
                      className="inline-block h-3.5 w-3.5 rounded-sm"
                      style={{ border: '1.5px solid var(--acid)', background: 'var(--acid)' }}
                    />
                    = Done
                  </span>
                </div>

                {viewMode === 'grid' ? (
                  (() => {
                    // Grid shows the tree-flattened order (children follow
                    // their parent) with a per-row depth for indentation. No
                    // collapse in the grid — a flat table reads better fully
                    // expanded; the checklist owns expand/collapse.
                    const gridRows = flattenVisible(buildItemTree(state.items), new Set())
                    const depthOf = new Map(gridRows.map((r) => [r.item.id, r.depth]))
                    const gridOrder = gridRows.map((r) => r.item.id)
                    return (
                      <GridView
                        items={gridRows.map((r) => r.item)}
                        depthOf={depthOf}
                        members={members}
                        fieldDefs={state.fieldDefs}
                        selectedIds={selection.selected}
                        onSelect={(itemId, on) => selection.toggle(itemId, on)}
                        onRangeSelect={(itemId) => selection.extendTo(itemId, gridOrder)}
                        onClearSelection={() => selection.clear()}
                        onToggleComplete={(itemId, completed) => void patch(itemId, { completed })}
                        onRename={(itemId, title) => void patch(itemId, { title })}
                        onAssign={(itemId, assignedTo) => void patch(itemId, { assignedTo })}
                        onSetCustomField={(itemId, fieldId, value) =>
                          void patch(itemId, { customFields: { [fieldId]: value } })
                        }
                      />
                    )
                  })()
                ) : (
                  renderChecklist(state.items)
                )}
              </div>
            )}
          </>
        )}
      </div>
      {state.status === 'ready' && (
        <>
          <ShareDrawer
            open={shareOpen}
            onClose={() => setShareOpen(false)}
            listId={state.list.id}
            listName={state.list.name}
          />
          <FieldManagerDrawer
            open={fieldsOpen}
            onClose={() => setFieldsOpen(false)}
            listId={state.list.id}
            listName={state.list.name}
          />
          {state.list.list_type === 'tasks' && (
            <StatusManagerDrawer
              open={statusesOpen}
              onClose={() => {
                setStatusesOpen(false)
                // Self-authored realtime events are skipped, so pull the
                // board's columns back in sync with any drawer edits.
                void load({ silent: true })
              }}
              listId={state.list.id}
              listName={state.list.name}
            />
          )}
          <ItemCommentsDrawer
            open={commentsItem !== null}
            onClose={() => setCommentsItem(null)}
            listId={state.list.id}
            itemId={commentsItem?.id ?? ''}
            itemTitle={commentsItem?.title ?? ''}
            selfUserId={selfUserId}
          />
          <LabelManagerDrawer
            open={labelsOpen}
            onClose={() => {
              setLabelsOpen(false)
              // Self-authored realtime is skipped; refresh chips after edits.
              void load({ silent: true })
            }}
            listId={state.list.id}
            listName={state.list.name}
          />
        </>
      )}
    </main>
  )
}

interface ItemRowProps {
  item: ListItemDto
  depth: number
  hasChildren: boolean
  collapsed: boolean
  onToggleCollapse: () => void
  onAddSubItem: () => void
  onComments: () => void
  labels: LabelDto[]
  onSetLabels: (labelIds: string[]) => void
  members: GroupMemberDto[]
  fieldDefs: FieldDefDto[]
  selected: boolean
  onSelect: (on: boolean) => void
  // Shift-click on the select box — extend the selection to this row.
  onRangeSelect: () => void
  canMoveUp: boolean
  canMoveDown: boolean
  onToggle: (completed: boolean) => void
  onRename: (title: string) => void
  onAssign: (assignedTo: string) => void
  onSetCustomField: (fieldId: string, value: unknown | null) => void
  onDelete: () => void
  onMoveUp: () => void
  onMoveDown: () => void
}

function ItemRow({
  item,
  depth,
  hasChildren,
  collapsed,
  onToggleCollapse,
  onAddSubItem,
  onComments,
  labels,
  onSetLabels,
  members,
  fieldDefs,
  selected,
  onSelect,
  onRangeSelect,
  canMoveUp,
  canMoveDown,
  onToggle,
  onRename,
  onAssign,
  onSetCustomField,
  onDelete,
  onMoveUp,
  onMoveDown,
}: ItemRowProps) {
  const [title, setTitle] = useState(item.title)

  // Re-sync when the server returns a normalized title (the row stays
  // mounted across reloads because the key is item.id).
  useEffect(() => {
    setTitle(item.title)
  }, [item.title])

  function commitTitle() {
    const next = title.trim()
    if (next.length > 0 && next !== item.title) onRename(next)
    else setTitle(item.title)
  }

  const childTotal = item.child_count ?? 0
  const childDone = item.child_done_count ?? 0

  return (
    <li
      className="space-y-2 px-3 py-2"
      style={{
        border: '1.5px solid var(--line)',
        background: 'var(--surface)',
        marginLeft: depth * 20,
      }}
    >
      <div className="flex items-center gap-3">
      {/* Collapse caret (parents only); a fixed-width spacer keeps leaf
          rows aligned with their parent's controls. */}
      {hasChildren ? (
        <button
          type="button"
          onClick={onToggleCollapse}
          aria-label={collapsed ? 'Expand sub-items' : 'Collapse sub-items'}
          aria-expanded={!collapsed}
          className="w-4 text-[color:var(--ink-dim)] hover:text-[color:var(--ink)]"
        >
          {collapsed ? '▸' : '▾'}
        </button>
      ) : (
        <span aria-hidden className="w-4" />
      )}
      <input
        type="checkbox"
        checked={selected}
        onClick={(e) => {
          // Shift-click selects the range from the anchor; let a plain click
          // fall through to onChange for the normal toggle.
          if (e.shiftKey) {
            e.preventDefault()
            onRangeSelect()
          }
        }}
        onChange={(e) => onSelect(e.target.checked)}
        className="h-4 w-4"
        style={{ accentColor: 'var(--hot)' }}
        title="Select for bulk actions (shift-click for a range)"
        aria-label={selected ? 'Deselect item' : 'Select item'}
      />
      {/* Divider so the bulk-select box reads as separate from the
          adjacent (green) complete box, which they otherwise look like. */}
      <span aria-hidden style={{ alignSelf: 'stretch', borderLeft: '1px solid var(--line)' }} />
      <input
        type="checkbox"
        checked={item.completed}
        onChange={(e) => onToggle(e.target.checked)}
        className="h-4 w-4"
        style={{ accentColor: 'var(--acid)' }}
        title={item.completed ? 'Mark incomplete' : 'Mark complete'}
        aria-label={item.completed ? 'Mark incomplete' : 'Mark complete'}
      />
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={commitTitle}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        }}
        className={`flex-1 bg-transparent text-sm focus:outline-none ${
          item.completed ? 'line-through text-[color:var(--ink-mute)]' : ''
        }`}
      />

      <select
        value={item.assigned_to ?? ''}
        onChange={(e) => onAssign(e.target.value)}
        className="cyber-input"
        style={{ width: 'auto', padding: '4px 8px' }}
        aria-label="Assignee"
      >
        <option value="">Unassigned</option>
        {/* Keep the current assignee selectable even if they're not in
            the member list (e.g. a group-scoped list). */}
        {item.assigned_to && !members.some((m) => m.user_id === item.assigned_to) && (
          <option value={item.assigned_to}>{item.assigned_to}</option>
        )}
        {members.map((m) => (
          <option key={m.id} value={m.user_id}>
            {m.user_id}
          </option>
        ))}
      </select>

      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={onComments}
          aria-label="Comments"
          title="Comments"
          className="rounded px-1.5 py-0.5 text-[color:var(--ink-dim)] hover:text-[color:var(--ink)]"
        >
          💬
        </button>
        <button
          type="button"
          onClick={onAddSubItem}
          aria-label="Add sub-item"
          title="Add sub-item"
          className="rounded px-1.5 py-0.5 text-[color:var(--ink-dim)] hover:text-[color:var(--ink)]"
        >
          + sub
        </button>
        <button
          type="button"
          onClick={onMoveUp}
          disabled={!canMoveUp}
          aria-label="Move up"
          className="rounded px-1.5 py-0.5 text-[color:var(--ink-dim)] hover:text-[color:var(--ink)] disabled:opacity-30"
        >
          ↑
        </button>
        <button
          type="button"
          onClick={onMoveDown}
          disabled={!canMoveDown}
          aria-label="Move down"
          className="rounded px-1.5 py-0.5 text-[color:var(--ink-dim)] hover:text-[color:var(--ink)] disabled:opacity-30"
        >
          ↓
        </button>
        <button
          type="button"
          onClick={onDelete}
          aria-label="Delete item"
          className="rounded px-1.5 py-0.5"
          style={{ color: 'var(--hot)' }}
        >
          ✕
        </button>
      </div>
      </div>

      <div className="pl-8">
        <LabelChips labelIds={item.label_ids} labels={labels} onSetLabels={onSetLabels} />
      </div>

      {childTotal > 0 && (
        <div className="flex items-center gap-2 pl-8 text-xs" style={{ color: 'var(--ink-dim)' }}>
          <div
            className="h-1.5 flex-1 overflow-hidden rounded-full"
            style={{ background: 'var(--surface-2)' }}
            role="progressbar"
            aria-valuenow={progressPercent(childDone, childTotal)}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Sub-item progress"
          >
            <div
              className="h-full rounded-full"
              style={{
                width: `${progressPercent(childDone, childTotal)}%`,
                background: 'var(--acid)',
              }}
            />
          </div>
          <span className="shrink-0 tabular-nums">
            {childDone}/{childTotal}
          </span>
        </div>
      )}

      {fieldDefs.length > 0 && (
        <div className="pl-8">
          <CustomFieldsEditor
            defs={fieldDefs}
            values={item.custom_fields}
            members={members}
            onChange={onSetCustomField}
          />
        </div>
      )}
    </li>
  )
}

// Inline add-sub-item input, opened under a parent row. Indented to match
// its parent's children; Enter or the Add button creates, Esc or ✕ cancels.
function AddSubItemRow({
  depth,
  submitting,
  onCancel,
  onSubmit,
}: {
  depth: number
  submitting: boolean
  onCancel: () => void
  onSubmit: (title: string) => void
}) {
  const [title, setTitle] = useState('')
  return (
    <li
      className="flex items-center gap-2 px-3 py-2"
      style={{
        border: '1.5px dashed var(--line)',
        background: 'var(--surface)',
        marginLeft: depth * 20,
      }}
    >
      <input
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && title.trim().length > 0) onSubmit(title)
          else if (e.key === 'Escape') onCancel()
        }}
        placeholder="Sub-item title…"
        className="cyber-input flex-1"
        style={{ padding: '4px 8px' }}
      />
      <button
        type="button"
        onClick={() => title.trim().length > 0 && onSubmit(title)}
        disabled={title.trim().length === 0 || submitting}
        className="btn-ghost"
        style={{ width: 'auto' }}
      >
        Add
      </button>
      <button
        type="button"
        onClick={onCancel}
        aria-label="Cancel"
        className="rounded px-1.5 py-0.5"
        style={{ color: 'var(--ink-dim)' }}
      >
        ✕
      </button>
    </li>
  )
}

import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  ApiError,
  createItem,
  deleteItem,
  deleteList,
  getList,
  listFieldDefs,
  listGroupMembers,
  listItems,
  listLists,
  restoreItem,
  updateItem,
  type FieldDefDto,
  type GroupMemberDto,
  type ListDto,
  type ListItemDto,
} from '../lib/api.js'
import { TaskBoard } from '../components/TaskBoard.js'
import { ShareDrawer } from '../components/ShareDrawer.js'
import { FieldManagerDrawer } from '../components/FieldManagerDrawer.js'
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
  | { status: 'ready'; list: ListDto; items: ListItemDto[]; fieldDefs: FieldDefDto[] }
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
  // Filter/sort applied server-side via the items query (Lists v2 slice 4).
  const [query, setQuery] = useState<FilterSortValue>({ filters: [], sort: [] })
  // Bumped on a realtime list_views envelope to reload the saved-view list
  // (slice 5). The view set lives in ViewSwitcher's own state.
  const [viewsReloadKey, setViewsReloadKey] = useState(0)
  // Row selection for bulk actions (slice 6). Holds item ids; the bulk
  // toolbar appears while non-empty. Cleared on list change / refetch.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  // 'list' (checklist) vs 'grid' (spreadsheet) for a standard list (slice 7).
  // Restored from / persisted into the active saved view via ViewSwitcher.
  const [viewMode, setViewMode] = useState<ViewMode>('list')

  // `silent` skips the loading flash — used by realtime refetches so a
  // collaborator's edit doesn't blank the page out from under the viewer.
  async function load(opts: { silent?: boolean } = {}) {
    if (!listId) return
    if (!opts.silent) setState({ status: 'loading' })
    try {
      const [list, page, defs] = await Promise.all([
        getList(listId),
        listItems(listId, query),
        listFieldDefs(listId),
      ])
      setState({ status: 'ready', list, items: page.items, fieldDefs: defs.items })
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

  // Drop any stale selection when the list or filter changes — selected
  // ids may no longer be in view.
  useEffect(() => {
    setSelectedIds(new Set())
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

  async function patch(itemId: string, fields: Parameters<typeof updateItem>[2]) {
    if (!listId) return
    setActionError(null)
    try {
      await updateItem(listId, itemId, fields)
      await load()
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

  function toggleSelect(itemId: string, on: boolean) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (on) next.add(itemId)
      else next.delete(itemId)
      return next
    })
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

  return (
    <main className="page-pad">
      <div className="content-cap mx-auto space-y-6">
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
                {/* Fields button — only the list creator can define
                    custom columns (the API enforces the same). */}
                {state.list.created_by === selfUserId && (
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
                {state.list.visibility === 'private' &&
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
                {state.list.created_by === selfUserId && (
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

            <form onSubmit={(e) => void handleAdd(e)} className="space-y-3">
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
              <TaskBoard
                items={state.items}
                members={members}
                moveTargets={moveTargets}
                fieldDefs={state.fieldDefs}
                onCycleStatus={(itemId, next) => void patch(itemId, { status: next })}
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
            ) : state.items.length === 0 ? (
              <div
                className="p-6 text-center text-[color:var(--ink-dim)] text-sm"
                style={{ border: '1.5px solid var(--line)', background: 'var(--surface)' }}
              >
                {query.filters.length > 0
                  ? 'No items match the current filters.'
                  : 'No items yet. Add the first one above.'}
              </div>
            ) : (
              <div className="space-y-2">
                {selectedIds.size > 0 && (
                  <BulkToolbar
                    listId={state.list.id}
                    selectedIds={[...selectedIds]}
                    members={members}
                    fieldDefs={state.fieldDefs}
                    onDone={() => {
                      setSelectedIds(new Set())
                      void load({ silent: true })
                    }}
                    onError={reportError}
                    onClear={() => setSelectedIds(new Set())}
                  />
                )}

                {/* Column legend for the two leading checkboxes on each
                    row: the red box selects for bulk actions (select-all
                    toggles them here), the green box marks an item done. */}
                <div
                  className="flex items-center gap-3 px-3 text-xs"
                  style={{ color: 'var(--ink-dim)' }}
                >
                  <label className="flex items-center gap-2" title="Select every item for bulk actions">
                    <input
                      type="checkbox"
                      checked={state.items.every((i) => selectedIds.has(i.id))}
                      ref={(el) => {
                        if (el) {
                          el.indeterminate =
                            selectedIds.size > 0 && !state.items.every((i) => selectedIds.has(i.id))
                        }
                      }}
                      onChange={(e) =>
                        setSelectedIds(
                          e.target.checked ? new Set(state.items.map((i) => i.id)) : new Set(),
                        )
                      }
                      className="h-4 w-4"
                      style={{ accentColor: 'var(--hot)' }}
                    />
                    Select all
                  </label>
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
                  <GridView
                    items={state.items}
                    members={members}
                    fieldDefs={state.fieldDefs}
                    selectedIds={selectedIds}
                    onSelect={toggleSelect}
                    onToggleComplete={(itemId, completed) => void patch(itemId, { completed })}
                    onRename={(itemId, title) => void patch(itemId, { title })}
                    onAssign={(itemId, assignedTo) => void patch(itemId, { assignedTo })}
                    onSetCustomField={(itemId, fieldId, value) =>
                      void patch(itemId, { customFields: { [fieldId]: value } })
                    }
                  />
                ) : (
                  <ul className="space-y-2">
                    {state.items.map((item, index) => (
                      <ItemRow
                        key={item.id}
                        item={item}
                        members={members}
                        fieldDefs={state.fieldDefs}
                        selected={selectedIds.has(item.id)}
                        onSelect={(on) => toggleSelect(item.id, on)}
                        canMoveUp={index > 0}
                        canMoveDown={index < state.items.length - 1}
                        onToggle={(completed) => void patch(item.id, { completed })}
                        onRename={(title) => void patch(item.id, { title })}
                        onAssign={(assignedTo) => void patch(item.id, { assignedTo })}
                        onSetCustomField={(fieldId, value) =>
                          void patch(item.id, { customFields: { [fieldId]: value } })
                        }
                        onDelete={() => void handleDelete(item.id)}
                        onMoveUp={() => void move(state.items, index, -1)}
                        onMoveDown={() => void move(state.items, index, 1)}
                      />
                    ))}
                  </ul>
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
        </>
      )}
    </main>
  )
}

interface ItemRowProps {
  item: ListItemDto
  members: GroupMemberDto[]
  fieldDefs: FieldDefDto[]
  selected: boolean
  onSelect: (on: boolean) => void
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
  members,
  fieldDefs,
  selected,
  onSelect,
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

  return (
    <li
      className="space-y-2 px-3 py-2"
      style={{ border: '1.5px solid var(--line)', background: 'var(--surface)' }}
    >
      <div className="flex items-center gap-3">
      <input
        type="checkbox"
        checked={selected}
        onChange={(e) => onSelect(e.target.checked)}
        className="h-4 w-4"
        style={{ accentColor: 'var(--hot)' }}
        title="Select for bulk actions"
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

      {fieldDefs.length > 0 && (
        <div className="pl-7">
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

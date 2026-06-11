import { useEffect, useState } from 'react'
import { validateListQuery, type ViewConfig, type ViewMode } from '@rallypoint/lists-shared'
import {
  createView,
  deleteView,
  listViews,
  updateView,
  type FieldDefDto,
  type ListViewDto,
} from '../lib/api.js'
import type { FilterSortValue } from './FilterSortBar.js'

// Saved-view switcher for the standard list view (Lists v2 slice 5).
// Persists the current filter/sort as a named, list-shared view and lets
// any reader re-apply one. Only the list creator can save / update /
// delete (the API enforces the same with a creator-write guard).
//
// A stored config may reference a since-deleted field (a stale spec). We
// resolve it against the LIVE defs at apply time via validateListQuery —
// dropping anything unresolvable — so an old view never pushes a spec the
// API would reject onto the bar (mirrors slice 4's stale-view tolerance).

interface ViewSwitcherProps {
  listId: string
  fieldDefs: FieldDefDto[]
  canEdit: boolean
  query: FilterSortValue
  onApply: (next: FilterSortValue) => void
  // Current grid/list mode, persisted into a saved view's config on
  // save/update and restored onto the page when a view is applied (slice 7).
  viewMode: ViewMode
  onViewMode: (mode: ViewMode) => void
  // Bumped by the page on a realtime list_views envelope to force a reload.
  reloadKey?: number
}

export function ViewSwitcher({
  listId,
  fieldDefs,
  canEdit,
  query,
  onApply,
  viewMode,
  onViewMode,
  reloadKey,
}: ViewSwitcherProps) {
  const [views, setViews] = useState<ListViewDto[]>([])
  const [activeId, setActiveId] = useState<string>('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Inline affordances replacing window.prompt / window.confirm (#244).
  const [naming, setNaming] = useState(false)
  const [newName, setNewName] = useState('')
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const page = await listViews(listId)
        if (!cancelled) setViews(page.items)
      } catch {
        if (!cancelled) setViews([])
      }
    })()
    return () => {
      cancelled = true
    }
  }, [listId, reloadKey])

  // Drop filters/sorts that don't resolve against the current defs, then
  // strip the `resolved` field validateListQuery attaches — the bar wants
  // bare FilterSpec/SortSpec.
  function sanitize(config: ViewConfig): FilterSortValue {
    const defsForQuery = fieldDefs.map((d) => ({ id: d.id, fieldType: d.field_type }))
    const { filters, sort } = validateListQuery(
      { filters: config.filters, sort: config.sort },
      defsForQuery,
    )
    return {
      filters: filters.map((f) =>
        f.value === undefined
          ? { field: f.field, op: f.op }
          : { field: f.field, op: f.op, value: f.value },
      ),
      sort: sort.map((s) => ({ field: s.field, dir: s.dir })),
    }
  }

  function applyView(id: string) {
    setActiveId(id)
    setConfirmingDelete(false)
    setNaming(false)
    setNewName('')
    if (id === '') {
      onApply({ filters: [], sort: [] })
      onViewMode('list')
      return
    }
    const view = views.find((v) => v.id === id)
    if (view) {
      onApply(sanitize(view.config))
      onViewMode(view.config.viewMode)
    }
  }

  // The config a save/update writes: the live filter/sort + the current
  // grid/list mode, plus the existing columns of the active view (so saving
  // a filter tweak doesn't wipe a column choice made elsewhere). Defaults
  // for a new view: all columns visible (empty = "all").
  function configFromQuery(base?: ViewConfig): ViewConfig {
    return {
      filters: query.filters,
      sort: query.sort,
      visibleColumns: base?.visibleColumns ?? [],
      viewMode,
    }
  }

  async function handleSaveNew() {
    const name = newName.trim()
    if (!name) return
    setBusy(true)
    setError(null)
    try {
      const view = await createView(listId, { name, config: configFromQuery() })
      setViews((prev) => [...prev, view])
      setActiveId(view.id)
      setNaming(false)
      setNewName('')
    } catch {
      setError('Could not save view.')
    } finally {
      setBusy(false)
    }
  }

  async function handleUpdate() {
    const view = views.find((v) => v.id === activeId)
    if (!view) return
    setBusy(true)
    setError(null)
    try {
      const updated = await updateView(listId, view.id, { config: configFromQuery(view.config) })
      setViews((prev) => prev.map((v) => (v.id === updated.id ? updated : v)))
    } catch {
      setError('Could not update view.')
    } finally {
      setBusy(false)
    }
  }

  async function handleDelete() {
    const view = views.find((v) => v.id === activeId)
    if (!view) return
    setBusy(true)
    setError(null)
    try {
      await deleteView(listId, view.id)
      setViews((prev) => prev.filter((v) => v.id !== view.id))
      setActiveId('')
      setConfirmingDelete(false)
      onApply({ filters: [], sort: [] })
      onViewMode('list')
    } catch {
      setError('Could not delete view.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 text-sm" style={{ color: 'var(--ink-dim)' }}>
      <span>View</span>
      <select
        value={activeId}
        onChange={(e) => applyView(e.target.value)}
        className="cyber-input"
        style={{ width: 'auto' }}
        aria-label="Saved view"
      >
        <option value="">Unsaved</option>
        {views.map((v) => (
          <option key={v.id} value={v.id}>
            {v.name}
          </option>
        ))}
      </select>
      {canEdit && (
        <>
          {naming ? (
            <span className="flex items-center gap-1">
              <input
                type="text"
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleSaveNew()
                  if (e.key === 'Escape') {
                    setNaming(false)
                    setNewName('')
                  }
                }}
                disabled={busy}
                placeholder="Name this view"
                aria-label="New view name"
                className="cyber-input"
                style={{ width: 'auto' }}
              />
              <button
                type="button"
                onClick={() => void handleSaveNew()}
                disabled={busy || newName.trim() === ''}
                className="text-sm underline"
                style={{ color: 'var(--ink-dim)' }}
              >
                Save
              </button>
              <button
                type="button"
                onClick={() => {
                  setNaming(false)
                  setNewName('')
                }}
                disabled={busy}
                className="text-sm underline"
                style={{ color: 'var(--ink-dim)' }}
              >
                Cancel
              </button>
            </span>
          ) : (
            <button
              type="button"
              onClick={() => {
                setConfirmingDelete(false)
                setNaming(true)
              }}
              disabled={busy}
              className="text-sm underline"
              style={{ color: 'var(--ink-dim)' }}
            >
              Save as…
            </button>
          )}
          {activeId !== '' && !naming && (
            <>
              <button
                type="button"
                onClick={() => void handleUpdate()}
                disabled={busy}
                className="text-sm underline"
                style={{ color: 'var(--ink-dim)' }}
              >
                Update
              </button>
              {confirmingDelete ? (
                <span className="flex items-center gap-1">
                  <span style={{ color: 'var(--hot)' }}>Delete?</span>
                  <button
                    type="button"
                    onClick={() => void handleDelete()}
                    disabled={busy}
                    className="text-sm underline"
                    style={{ color: 'var(--hot)' }}
                  >
                    Confirm
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmingDelete(false)}
                    disabled={busy}
                    className="text-sm underline"
                    style={{ color: 'var(--ink-dim)' }}
                  >
                    Cancel
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmingDelete(true)}
                  disabled={busy}
                  className="text-sm underline"
                  style={{ color: 'var(--hot)' }}
                >
                  Delete
                </button>
              )}
            </>
          )}
        </>
      )}
      {error && <span style={{ color: 'var(--hot)' }}>{error}</span>}
    </div>
  )
}

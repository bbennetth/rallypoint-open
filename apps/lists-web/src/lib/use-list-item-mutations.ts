import type { Dispatch, SetStateAction } from 'react'
import type { NavigateFunction } from 'react-router-dom'
import { ApiError, deleteList, restoreItem, updateItem, type ListItemDto } from './api.js'
import { newTempId, type OutboxOp } from './offline/outbox-ops.js'
import { enqueueItemOp } from './offline/engine.js'
import { missingRequiredFieldIds } from './field-form.js'
import { runWithConcurrency } from './concurrency.js'
import { groupItemsByStatus } from './board.js'
import { applyBoardDrop, planBoardDrop, reindexPatches, type DropTarget } from './board-dnd.js'
import { applyOpToItems } from './offline/outbox-reducers.js'
import type { LoadState } from './use-list-load.js'

// Owns the item-mutation closures: optimistic apply + outbox enqueue for
// item ops, plus the add/patch/delete/undo/reorder/move/add-sub-item
// handlers wired to the page's JSX. Each param is exactly what its
// closure(s) touch, mirroring the page's own state before extraction.
export function useListItemMutations(params: {
  listId: string | undefined
  selfUserId: string
  state: LoadState
  setState: Dispatch<SetStateAction<LoadState>>
  navigate: NavigateFunction
  load: (opts?: { silent?: boolean }) => Promise<void>
  newTitle: string
  setNewTitle: Dispatch<SetStateAction<string>>
  newCustomFields: Record<string, unknown>
  setNewCustomFields: Dispatch<SetStateAction<Record<string, unknown>>>
  adding: boolean
  setAdding: Dispatch<SetStateAction<boolean>>
  setAddResetKey: Dispatch<SetStateAction<number>>
  setActionError: Dispatch<SetStateAction<string | null>>
  lastDeleted: string | null
  setLastDeleted: Dispatch<SetStateAction<string | null>>
  addingSub: boolean
  setAddingSub: Dispatch<SetStateAction<boolean>>
  setAddSubParent: Dispatch<SetStateAction<string | null>>
  setCollapsed: Dispatch<SetStateAction<Set<string>>>
}) {
  const {
    listId,
    selfUserId,
    state,
    setState,
    navigate,
    load,
    newTitle,
    setNewTitle,
    newCustomFields,
    setNewCustomFields,
    adding,
    setAdding,
    setAddResetKey,
    setActionError,
    lastDeleted,
    setLastDeleted,
    addingSub,
    setAddingSub,
    setAddSubParent,
    setCollapsed,
  } = params

  function reportError(err: unknown) {
    setActionError(err instanceof ApiError ? `${err.code}: ${err.message}` : 'Action failed.')
  }

  // Apply an item op optimistically to the in-memory list so the UI updates
  // instantly, then persist it to the outbox (which flushes when online). The
  // optimistic apply mirrors what `load()` will reconstruct from cache+pending,
  // so an offline reload shows the same state.
  function applyOptimistic(op: OutboxOp) {
    setState((prev) =>
      prev.status === 'ready' ? { ...prev, items: applyOpToItems(prev.items, op, selfUserId) } : prev,
    )
  }

  async function runItemOp(op: OutboxOp) {
    if (!listId) return
    setActionError(null)
    applyOptimistic(op)
    try {
      await enqueueItemOp(selfUserId, op)
    } catch (err) {
      // Persisting to IndexedDB failed (quota / private mode) — fall back to a
      // resync so the UI doesn't drift from a change we couldn't queue.
      reportError(err)
      void load({ silent: true })
    }
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
    const customFields = Object.keys(newCustomFields).length > 0 ? newCustomFields : undefined
    try {
      await runItemOp({
        type: 'item:create',
        listId,
        tmpId: newTempId(),
        input: { title: newTitle, priority: null, ...(customFields ? { customFields } : {}) },
      })
      setNewTitle('')
      setNewCustomFields({})
      setAddResetKey((k) => k + 1)
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

  // Item edits go through the outbox: optimistic apply + queued PATCH that
  // flushes on reconnect. The legacy `silent` option is moot now (no reload),
  // kept in the signature so the many call sites don't need touching.
  async function patch(
    itemId: string,
    fields: Parameters<typeof updateItem>[2],
    _opts: { silent?: boolean } = {},
  ) {
    if (!listId) return
    await runItemOp({ type: 'item:update', listId, itemId, patch: fields })
  }

  async function handleDelete(itemId: string) {
    if (!listId) return
    setLastDeleted(itemId)
    await runItemOp({ type: 'item:delete', listId, itemId })
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
      // Bounded concurrency (#675): a big column reindex can touch dozens
      // of items in one drop — an unbounded Promise.all fan-out here
      // would fire that many PATCHes at once.
      await runWithConcurrency(reindexPatches(plan), 4, (p) =>
        updateItem(listId, p.id, {
          position: p.position,
          ...(p.id === plan.itemId && plan.statusChanged ? { statusId: plan.toStatusId } : {}),
        }),
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
    // Promise.allSettled (#675): with Promise.all, one swap PATCH failing
    // mid-flight throws before the outcome of the other is known, and the
    // subsequent `load()` in the catch block still reconciles either way
    // — but the settled approach lets us tell the two apart and always
    // reload once both are known, rather than racing a throw against the
    // second in-flight request.
    const results = await Promise.allSettled([
      updateItem(listId, cur.id, { position: other.position }),
      updateItem(listId, other.id, { position: cur.position }),
    ])
    const failure = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
    // Reload regardless of outcome so the UI always reconciles to server
    // truth — a partial swap must not leave stale positions in state.
    await load()
    if (failure) reportError(failure.reason)
  }

  // Add a sub-item under `parentId` from the inline affordance. The
  // in-flight guard stops a fast double-Enter from creating two children.
  async function handleAddSubItem(parentId: string, title: string) {
    if (!listId || addingSub || title.trim().length === 0) return
    setAddingSub(true)
    try {
      await runItemOp({
        type: 'item:create',
        listId,
        tmpId: newTempId(),
        input: { title: title.trim(), priority: null, parentId },
      })
      setAddSubParent(null)
      // Make sure the new child is visible.
      setCollapsed((prev) => {
        if (!prev.has(parentId)) return prev
        const next = new Set(prev)
        next.delete(parentId)
        return next
      })
    } finally {
      setAddingSub(false)
    }
  }

  return {
    reportError,
    applyOptimistic,
    runItemOp,
    handleDeleteList,
    handleAdd,
    setNewCustomField,
    patch,
    handleDelete,
    handleUndo,
    handleReorder,
    move,
    handleAddSubItem,
  }
}

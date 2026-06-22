import { useCallback, useEffect, useState } from 'react'
import {
  ApiError,
  createTaskItem,
  deleteTaskItem,
  listTaskItems,
  listTaskLists,
  setTaskItemCompleted,
  updateTaskItem,
  type TaskItemDto,
} from '../lib/api.js'
import { onCreated } from '../lib/refresh-bus.js'
import { Check, PriTag } from '../ui/bits.js'
import { SkeletonBlock, SkeletonRows } from '../ui/Skeleton.js'
import { Icon } from '../ui/icons.js'
import { Drawer } from '@rallypoint/ui'
import { TaskDetail } from '../ui/TaskDetail.js'
import { ChoresBody } from './ChoresBody.js'

// Tasks surface (#543 single list + Ink redesign). Tasks are one-off only —
// title / priority / due date. Recurrence and custom fields were removed;
// recurrence now lives on the Chores sub-view (every chore is a series). A thin
// view over the planner-api BFF: it resolves the single canonical Tasks list,
// then lets the user add / rename / complete / delete one-off items. The page
// also hosts the "Tasks | Chores" segmented control; Chores render through
// <ChoresBody/> (mounted lazily so a chores list is only provisioned on visit).

type SubView = 'tasks' | 'chores'

function errMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message
  return 'Something went wrong. Please try again.'
}

// Short due-date chip label, e.g. "Jun 9". Empty when unset / unparseable.
// dueDate is a genuine instant (the BFF resolves any recurring floating due), so
// its local calendar date formats directly.
function dueLabel(dueDate: string | null): string {
  if (!dueDate) return ''
  const d = new Date(dueDate)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function TasksPage() {
  const [subView, setSubView] = useState<SubView>('tasks')
  return (
    <>
      <div className="pg-head" style={{ flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1>{subView === 'chores' ? 'Chores' : 'Tasks'}</h1>
        </div>
        <div
          className="seg"
          role="group"
          aria-label="Tasks or chores"
          style={{ marginLeft: 'auto' }}
        >
          <button
            type="button"
            className={subView === 'tasks' ? 'on' : ''}
            aria-pressed={subView === 'tasks'}
            onClick={() => setSubView('tasks')}
          >
            <Icon name="tasks" size={12} />
            Tasks
          </button>
          <button
            type="button"
            className={subView === 'chores' ? 'on' : ''}
            aria-pressed={subView === 'chores'}
            onClick={() => setSubView('chores')}
          >
            <Icon name="repeat" size={12} />
            Chores
          </button>
        </div>
      </div>

      {subView === 'chores' ? <ChoresBody /> : <TasksList />}
    </>
  )
}

function TasksList() {
  // The single canonical Tasks list id, resolved on load. Null until the BFF
  // returns it (provisioned + merged server-side).
  const [listId, setListId] = useState<string | null>(null)
  const [items, setItems] = useState<TaskItemDto[]>([])
  const [editing, setEditing] = useState<TaskItemDto | null>(null)
  // Inline title rename: which row's title is being edited, and its draft text.
  const [inlineEditId, setInlineEditId] = useState<string | null>(null)
  const [inlineTitle, setInlineTitle] = useState('')
  const [newItemTitle, setNewItemTitle] = useState('')
  const [loadingList, setLoadingList] = useState(true)
  const [loadingItems, setLoadingItems] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Resolve the single canonical Tasks list. The BFF returns a one-element
  // array (it provisions + folds legacy lists server-side); we take the head.
  const refreshList = useCallback(async () => {
    setLoadingList(true)
    try {
      const rows = await listTaskLists()
      setListId((cur) => cur ?? rows[0]?.id ?? null)
    } catch (err) {
      setError(errMessage(err))
    } finally {
      setLoadingList(false)
    }
  }, [])

  useEffect(() => {
    void refreshList()
  }, [refreshList])

  const refreshItems = useCallback(async (id: string) => {
    setLoadingItems(true)
    try {
      setItems(await listTaskItems(id))
    } catch (err) {
      setError(errMessage(err))
    } finally {
      setLoadingItems(false)
    }
  }, [])

  useEffect(() => {
    if (listId) void refreshItems(listId)
    else setItems([])
  }, [listId, refreshItems])

  // A task added from the global quick-add FAB refreshes the open list's items.
  useEffect(
    () =>
      onCreated('task', () => {
        if (listId) void refreshItems(listId)
      }),
    [refreshItems, listId],
  )

  async function onCreateItem(e: React.FormEvent) {
    e.preventDefault()
    const title = newItemTitle.trim()
    if (!title || !listId) return
    setError(null)
    try {
      const created = await createTaskItem(listId, title)
      setNewItemTitle('')
      setItems((prev) => [...prev, created])
    } catch (err) {
      setError(errMessage(err))
    }
  }

  async function onToggle(item: TaskItemDto) {
    if (!listId) return
    setError(null)
    try {
      const updated = await setTaskItemCompleted(listId, item.id, !item.completed)
      setItems((prev) => prev.map((i) => (i.id === updated.id ? updated : i)))
    } catch (err) {
      setError(errMessage(err))
    }
  }

  async function onDelete(item: TaskItemDto) {
    if (!listId) return
    setError(null)
    try {
      await deleteTaskItem(listId, item.id)
      setItems((prev) => prev.filter((i) => i.id !== item.id))
    } catch (err) {
      setError(errMessage(err))
    }
  }

  function startInlineEdit(item: TaskItemDto) {
    setInlineEditId(item.id)
    setInlineTitle(item.title)
  }

  function cancelInlineEdit() {
    setInlineEditId(null)
    setInlineTitle('')
  }

  // Commit an inline title rename. A blank or unchanged title is a no-op.
  // Optimistically patches the row, rolling back on failure.
  async function commitInlineEdit(item: TaskItemDto) {
    const next = inlineTitle.trim()
    setInlineEditId(null)
    if (!listId || next === '' || next === item.title) return
    setError(null)
    setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, title: next } : i)))
    try {
      const updated = await updateTaskItem(listId, item.id, { title: next })
      setItems((prev) => prev.map((i) => (i.id === updated.id ? updated : i)))
    } catch (err) {
      setError(errMessage(err))
      setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, title: item.title } : i)))
    }
  }

  const doneCount = items.filter((i) => i.completed).length

  return (
    <section style={{ display: 'grid', gap: 12, minWidth: 0 }}>
      {error && (
        <p role="alert" style={{ color: 'var(--hot)', fontSize: 13, marginTop: 0 }}>
          {error}
        </p>
      )}
      {loadingList ? (
        <div role="status" aria-busy="true" aria-label="Loading tasks">
          <SkeletonBlock height={44} style={{ marginBottom: 12 }} />
          <SkeletonRows count={4} height={46} bare />
        </div>
      ) : listId == null ? (
        <p className="meta" style={{ color: 'var(--ink-mute)' }}>
          Couldn’t load your tasks. Please refresh.
        </p>
      ) : (
        <>
          <form style={{ display: 'flex', gap: 8 }} onSubmit={onCreateItem}>
            <input
              className="pl-input"
              aria-label="New task title"
              placeholder="Add a task…"
              value={newItemTitle}
              onChange={(e) => setNewItemTitle(e.target.value)}
            />
            <button className="pl-btn grow" type="submit">
              <Icon name="plus" size={13} />
              Add
            </button>
          </form>

          <span className="meta" style={{ color: 'var(--ink-mute)' }}>
            {doneCount} / {items.length} done
          </span>

          {loadingItems ? (
            <SkeletonRows count={4} height={46} label="Loading tasks" />
          ) : items.length === 0 ? (
            <p className="meta" style={{ color: 'var(--ink-mute)' }}>
              Nothing here yet — add a task above.
            </p>
          ) : (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 7 }}>
              {items.map((item) => (
                <li
                  key={item.id}
                  className="pl-row"
                  style={{ gridTemplateColumns: '20px 1fr auto', alignItems: 'start' }}
                >
                  <Check done={item.completed} onClick={() => void onToggle(item)} />
                  <span style={{ display: 'flex', flexDirection: 'column', gap: 7, minWidth: 0 }}>
                    {inlineEditId === item.id ? (
                      <input
                        className="pl-input"
                        value={inlineTitle}
                        autoFocus
                        aria-label={`Rename ${item.title}`}
                        onChange={(e) => setInlineTitle(e.target.value)}
                        onBlur={() => void commitInlineEdit(item)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault()
                            e.currentTarget.blur()
                          } else if (e.key === 'Escape') {
                            e.preventDefault()
                            cancelInlineEdit()
                          }
                        }}
                        style={{ fontSize: 14, padding: '4px 8px' }}
                      />
                    ) : (
                      <button
                        type="button"
                        onClick={() => startInlineEdit(item)}
                        title="Rename — or use the ⋯ details button to edit priority & due date"
                        style={{
                          all: 'unset',
                          cursor: 'text',
                          fontSize: 14,
                          color: item.completed ? 'var(--ink-mute)' : 'var(--ink)',
                          textDecoration: item.completed ? 'line-through' : 'none',
                        }}
                      >
                        {item.title}
                      </button>
                    )}
                    <span
                      style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}
                    >
                      <PriTag p={item.priority} />
                      {dueLabel(item.dueDate) && (
                        <span className="pl-chip">
                          <Icon name="clock" size={10} />
                          {dueLabel(item.dueDate)}
                        </span>
                      )}
                    </span>
                  </span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <button
                      type="button"
                      className="pl-iconbtn"
                      onClick={() => setEditing(item)}
                      aria-label={`Edit details for ${item.title}`}
                      title="Priority & due date"
                    >
                      <Icon name="sliders" size={13} />
                    </button>
                    <button
                      type="button"
                      className="pl-iconbtn danger"
                      onClick={() => void onDelete(item)}
                      aria-label={`Delete ${item.title}`}
                      title="Delete"
                    >
                      ✕
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      <Drawer open={editing !== null} onClose={() => setEditing(null)} title="Task" mobileSheet>
        {editing && (
          <TaskDetail
            task={editing}
            onChanged={() => {
              if (listId) void refreshItems(listId)
            }}
            onClose={() => setEditing(null)}
          />
        )}
      </Drawer>
    </section>
  )
}

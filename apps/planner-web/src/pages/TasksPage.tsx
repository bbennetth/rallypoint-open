import { Fragment, useEffect, useMemo, useState } from 'react'
import {
  ApiError,
  deleteTaskItem,
  setTaskItemCompleted,
  taskItemsQuery,
  taskListsQuery,
  updateTaskItem,
  type TaskItemDto,
} from '../lib/api.js'
import { useCachedQuery } from '../lib/offline/use-cached-query.js'
import { onCreated } from '../lib/refresh-bus.js'
import {
  TASK_BUCKET_LABELS,
  TASK_BUCKET_ORDER,
  type TaskBucket,
  bucketTasks,
  dueChip,
  partitionTasks,
} from '../lib/tasks-helpers.js'
import { Check, EyeRow, PriTag } from '../ui/bits.js'
import { SkeletonBlock, SkeletonRows } from '../ui/Skeleton.js'
import { Icon } from '../ui/icons.js'
import { ConfirmDialog, Drawer, SubBar, SubBarSeg, SwipeActions } from '@rallypoint/ui'
import { QuickAdd } from '../ui/QuickAdd.js'
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

export function TasksPage() {
  const [subView, setSubView] = useState<SubView>('tasks')
  return (
    <>
      <div className="pg-head pl-wide" style={{ flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1>{subView === 'chores' ? 'Chores' : 'Tasks'}</h1>
        </div>
        {/* Desktop: inline `.seg` segmented control in the page head.
            Hidden on mobile via the wrapper's `.plan-desktop-only`
            (`.seg`'s own `display: inline-flex` would otherwise win
            over the toggle on mobile — keep the wrapper as the
            display authority). The mobile equivalent renders below
            as a floating `.rp-subbar`. */}
        <div className="plan-desktop-only" style={{ marginLeft: 'auto' }}>
          <div
            className="seg"
            role="group"
            aria-label="Tasks or chores"
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
      </div>

      {/* Mobile-only floating sub-bar (Ink kit). FAB rides as the
          trailing flex child per the kit. The `.rp-fab-float`
          coordinates on no-sub-bar pages were tuned to match where
          this in-sub-bar FAB sits, so the FAB doesn't visibly shift
          when navigating between pages. */}
      <div className="plan-mobile-only">
        <SubBar label="Tasks or chores">
          <SubBarSeg active={subView === 'tasks'} onClick={() => setSubView('tasks')}>
            Tasks
          </SubBarSeg>
          <SubBarSeg active={subView === 'chores'} onClick={() => setSubView('chores')}>
            Chores
          </SubBarSeg>
          <QuickAdd anchor="subbar" />
        </SubBar>
      </div>
      {/* Desktop: standalone floating FAB; hidden on mobile (the sub-
          bar above owns the FAB there). */}
      <div className="plan-desktop-only">
        <QuickAdd anchor="float" />
      </div>

      {subView === 'chores' ? <ChoresBody /> : <TasksList />}
    </>
  )
}

function TasksList() {
  // Render-from-cache: both reads paint the last-known value instantly
  // (skeletons only on a true cold cache miss) and re-render on every
  // cache write — including the optimistic patches the local-first
  // mutations below make, so no manual setItems() mirroring is needed.
  const listsQ = useCachedQuery(useMemo(() => taskListsQuery(), []))
  // The single canonical Tasks list id (BFF provisions + folds legacy
  // lists server-side; one-element array, take the head).
  const listId = listsQ.data?.[0]?.id ?? null
  const itemsQ = useCachedQuery(useMemo(() => (listId ? taskItemsQuery(listId) : null), [listId]))
  const items = useMemo(() => itemsQ.data ?? [], [itemsQ.data])

  const [editing, setEditing] = useState<TaskItemDto | null>(null)
  // Swipe/hover Delete stages the item here; the ConfirmDialog commits it.
  const [confirmDelete, setConfirmDelete] = useState<TaskItemDto | null>(null)
  // Inline title rename: which row's title is being edited, and its draft text.
  const [inlineEditId, setInlineEditId] = useState<string | null>(null)
  const [inlineTitle, setInlineTitle] = useState('')
  const [error, setError] = useState<string | null>(null)
  // Completed tasks live under a disclosure at the bottom so they never bury
  // open ones. Collapsed on every visit — not persisted.
  const [showCompleted, setShowCompleted] = useState(false)

  const loadingList = listsQ.status === 'loading'
  const loadingItems = listId !== null && itemsQ.status === 'loading'

  useEffect(() => {
    if (listsQ.status === 'error') setError(errMessage(listsQ.error))
    else if (itemsQ.status === 'error') setError(errMessage(itemsQ.error))
  }, [listsQ.status, listsQ.error, itemsQ.status, itemsQ.error])

  // A task added from the global quick-add FAB lands in the cache via the
  // local-first write, but refetch anyway to pick up server-computed fields.
  const refetchItems = itemsQ.refetch
  useEffect(() => onCreated('task', () => void refetchItems()), [refetchItems])

  async function onToggle(item: TaskItemDto) {
    if (!listId) return
    setError(null)
    try {
      await setTaskItemCompleted(listId, item.id, !item.completed)
    } catch (err) {
      setError(errMessage(err))
    }
  }

  async function onDelete(item: TaskItemDto) {
    if (!listId) return
    setError(null)
    try {
      await deleteTaskItem(listId, item.id)
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
  // The local-first write patches the cache (and this page) instantly.
  async function commitInlineEdit(item: TaskItemDto) {
    const next = inlineTitle.trim()
    setInlineEditId(null)
    if (!listId || next === '' || next === item.title) return
    setError(null)
    try {
      await updateTaskItem(listId, item.id, { title: next })
    } catch (err) {
      setError(errMessage(err))
    }
  }

  // System-skipped occurrences (superseded by a newer instance of their
  // recurring series) stay in the DB as history but show nowhere — not
  // even in the Completed disclosure.
  const visibleItems = items.filter((i) => i.status !== 'skipped')
  const { open, completed } = partitionTasks(visibleItems)
  // Date sections per the Soft Ink frame (Overdue → Today → This week →
  // Later → No date). Completed stays out — it keeps its own disclosure.
  const buckets = bucketTasks(open, new Date())

  // One task row (checkbox, inline-renameable title, chips). Shared by the
  // bucketed open sections and the collapsed Completed section. Edit/Delete
  // live in the SwipeActions tray (swipe on touch, hover/focus on desktop)
  // instead of always-visible trailing buttons. The bucket drives the due
  // chip (none in Today, weekday in This week, date elsewhere); completed
  // rows pass no bucket and keep the plain date chip, same format as Later.
  function renderRow(item: TaskItemDto, bucket?: TaskBucket) {
    const chip = dueChip(bucket ?? 'later', item.dueDate)
    return (
      <SwipeActions
        key={item.id}
        as="li"
        actions={[
          {
            key: 'edit',
            label: `Edit details for ${item.title}`,
            icon: <Icon name="sliders" size={13} />,
            onAction: () => setEditing(item),
          },
          {
            key: 'delete',
            label: `Delete ${item.title}`,
            icon: <>✕</>,
            onAction: () => setConfirmDelete(item),
          },
        ]}
        contentClassName="pl-row"
        contentStyle={{ gridTemplateColumns: '20px 1fr', alignItems: 'start' }}
      >
        <Check
          done={item.completed}
          onClick={() => void onToggle(item)}
          label={item.completed ? `Mark ${item.title} not done` : `Mark ${item.title} done`}
        />
        <span style={{ display: 'flex', flexDirection: 'column', gap: 7, minWidth: 0 }}>
          {inlineEditId === item.id ? (
            <input
              className="pl-input sm"
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
          <span style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <PriTag p={item.priority} />
            {chip && (
              <span className={'pl-chip' + (chip.hot ? ' hot' : '')}>
                <Icon name="clock" size={10} />
                {chip.label}
              </span>
            )}
          </span>
        </span>
      </SwipeActions>
    )
  }

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
          <span className="meta" style={{ color: 'var(--ink-mute)' }}>
            {open.length} of {items.length} left
          </span>

          {loadingItems ? (
            <SkeletonRows count={4} height={46} label="Loading tasks" />
          ) : items.length === 0 ? (
            <p className="meta" style={{ color: 'var(--ink-mute)' }}>
              Nothing here yet — add a task with the + button.
            </p>
          ) : (
            <>
              {open.length === 0 ? (
                <p className="meta" style={{ color: 'var(--ink-mute)', margin: 0 }}>
                  All tasks done.
                </p>
              ) : (
                TASK_BUCKET_ORDER.map((bucket) =>
                  buckets[bucket].length === 0 ? null : (
                    <Fragment key={bucket}>
                      <EyeRow>{TASK_BUCKET_LABELS[bucket]}</EyeRow>
                      <ul className="tk-rows">
                        {buckets[bucket].map((item) => renderRow(item, bucket))}
                      </ul>
                    </Fragment>
                  ),
                )
              )}
              {completed.length > 0 && (
                <>
                  <button
                    type="button"
                    onClick={() => setShowCompleted((v) => !v)}
                    aria-expanded={showCompleted}
                    aria-controls="tasks-completed-list"
                    className="meta"
                    style={{
                      all: 'unset',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      fontSize: 13,
                      color: 'var(--ink-mute)',
                    }}
                  >
                    <span
                      style={{
                        display: 'inline-flex',
                        transform: showCompleted ? 'rotate(90deg)' : 'none',
                        transition: 'transform .15s',
                      }}
                    >
                      <Icon name="chevron" size={12} />
                    </span>
                    Completed ({completed.length})
                  </button>
                  {showCompleted && (
                    <ul id="tasks-completed-list" className="tk-rows">
                      {completed.map((item) => renderRow(item))}
                    </ul>
                  )}
                </>
              )}
            </>
          )}
        </>
      )}

      <ConfirmDialog
        open={confirmDelete !== null}
        title="Delete task?"
        body={confirmDelete ? `“${confirmDelete.title}” will be removed.` : undefined}
        confirmLabel="Delete"
        confirmVariant="hot"
        onConfirm={async () => {
          const item = confirmDelete
          setConfirmDelete(null)
          if (item) await onDelete(item)
        }}
        onCancel={() => setConfirmDelete(null)}
      />

      <Drawer open={editing !== null} onClose={() => setEditing(null)} title="Task" mobileSheet>
        {editing && (
          <TaskDetail
            task={editing}
            onChanged={() => void refetchItems()}
            onClose={() => setEditing(null)}
          />
        )}
      </Drawer>
    </section>
  )
}

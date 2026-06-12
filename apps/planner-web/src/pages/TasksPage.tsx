import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ApiError,
  createTaskItem,
  createTaskList,
  createTaskSeries,
  deleteTaskItem,
  deleteTaskList,
  listFieldDefs,
  listTaskItems,
  listTaskLists,
  setTaskItemCompleted,
  setTaskItemCustomFields,
  updateTaskItem,
  type CreateTaskSeriesInput,
  type FieldDefDto,
  type TaskItemDto,
  type TaskListDto,
} from '../lib/api.js'
import { onCreated } from '../lib/refresh-bus.js'
import { LIST_CONFIRM_TIMEOUT_MS, nextConfirmListId } from '../lib/planner-helpers.js'
import { FieldManager } from '../components/FieldManager.js'
import { Check, PriTag } from '../ui/bits.js'
import { Icon } from '../ui/icons.js'
import { Drawer } from '@rallypoint/ui'
import { TaskDetail } from '../ui/TaskDetail.js'

// Weekday codes in display order, matching the Lists recurrence DayCode set.
const DAY_CODES = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const
type DayCode = (typeof DAY_CODES)[number]

function todayISO(): string {
  return new Date().toLocaleDateString('en-CA') // YYYY-MM-DD in local time
}

// Tasks surface (slice 6b + recurrence + custom fields + Ink redesign). A thin
// view over the planner-api BFF: renders the user's personal task lists, lets
// them create lists / items / recurring series, check items off, edit custom
// fields, and delete. All persistence lives in Lists via the BFF.

function errMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message
  return 'Something went wrong. Please try again.'
}

// Short due-date chip label, e.g. "Jun 9". Empty when unset / unparseable.
function dueLabel(dueDate: string | null): string {
  if (!dueDate) return ''
  const d = new Date(dueDate)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function TasksPage() {
  const [lists, setLists] = useState<TaskListDto[]>([])
  const [activeListId, setActiveListId] = useState<string | null>(null)
  const [items, setItems] = useState<TaskItemDto[]>([])
  const [editing, setEditing] = useState<TaskItemDto | null>(null)
  // Inline title rename: which row's title is being edited, and its draft text.
  const [inlineEditId, setInlineEditId] = useState<string | null>(null)
  const [inlineTitle, setInlineTitle] = useState('')
  const [defs, setDefs] = useState<FieldDefDto[]>([])
  const [fieldsOpen, setFieldsOpen] = useState(false)
  const [newListName, setNewListName] = useState('')
  const [newListOpen, setNewListOpen] = useState(false)
  const [newItemTitle, setNewItemTitle] = useState('')
  const [loadingLists, setLoadingLists] = useState(true)
  const [loadingItems, setLoadingItems] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Recurrence form state. When `repeat` is on, submitting the task form
  // creates a recurring series (materialized into occurrence items server-
  // side) instead of a single one-off item.
  const [repeat, setRepeat] = useState(false)
  const [freq, setFreq] = useState<'daily' | 'weekly'>('weekly')
  const [interval, setIntervalValue] = useState(1)
  const [byDay, setByDay] = useState<DayCode[]>([])
  const [dtstart, setDtstart] = useState(todayISO)
  const [boundType, setBoundType] = useState<'count' | 'until' | 'forever'>('count')
  const [count, setCount] = useState(10)
  const [until, setUntil] = useState('')
  const [timeOfDay, setTimeOfDay] = useState('')

  // Overflow flyout + inline confirm state for the list rail.
  // `flyoutListId`: which list's ··· menu is open.
  // `confirmListId`: which list is waiting for inline delete-confirm.
  const [flyoutListId, setFlyoutListId] = useState<string | null>(null)
  const [confirmListId, setConfirmListId] = useState<string | null>(null)
  // Ref map so each row can detect outside-click on its own flyout container.
  const flyoutRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Close flyout on outside-click or Escape.
  useEffect(() => {
    if (!flyoutListId) return
    const container = flyoutRefs.current.get(flyoutListId)
    const off = (e: MouseEvent) => {
      if (container && !container.contains(e.target as Node)) setFlyoutListId(null)
    }
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFlyoutListId(null)
    }
    document.addEventListener('mousedown', off)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('mousedown', off)
      document.removeEventListener('keydown', esc)
    }
  }, [flyoutListId])

  // Auto-cancel confirm chip after LIST_CONFIRM_TIMEOUT_MS.
  function openConfirm(listId: string) {
    setFlyoutListId(null)
    if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current)
    setConfirmListId((cur) => nextConfirmListId(cur, { type: 'open', listId }))
    confirmTimerRef.current = setTimeout(
      () => setConfirmListId((cur) => nextConfirmListId(cur, { type: 'cancel' })),
      LIST_CONFIRM_TIMEOUT_MS,
    )
  }
  function cancelConfirm() {
    if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current)
    setConfirmListId((cur) => nextConfirmListId(cur, { type: 'cancel' }))
  }
  // Clean up timer on unmount.
  useEffect(() => () => { if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current) }, [])

  function toggleDay(day: DayCode) {
    setByDay((prev) => (prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day]))
  }

  function resetRecurrence() {
    setRepeat(false)
    setFreq('weekly')
    setIntervalValue(1)
    setByDay([])
    setDtstart(todayISO())
    setBoundType('count')
    setCount(10)
    setUntil('')
    setTimeOfDay('')
  }

  const refreshLists = useCallback(async () => {
    setLoadingLists(true)
    try {
      const rows = await listTaskLists()
      setLists(rows)
      setActiveListId((cur) => cur ?? rows[0]?.id ?? null)
    } catch (err) {
      setError(errMessage(err))
    } finally {
      setLoadingLists(false)
    }
  }, [])

  useEffect(() => {
    void refreshLists()
  }, [refreshLists])

  const refreshItems = useCallback(async (listId: string) => {
    setLoadingItems(true)
    try {
      setItems(await listTaskItems(listId))
    } catch (err) {
      setError(errMessage(err))
    } finally {
      setLoadingItems(false)
    }
  }, [])

  const refreshDefs = useCallback(async (listId: string) => {
    try {
      setDefs(await listFieldDefs(listId))
    } catch (err) {
      setError(errMessage(err))
    }
  }, [])

  useEffect(() => {
    if (activeListId) {
      void refreshItems(activeListId)
      void refreshDefs(activeListId)
    } else {
      setItems([])
      setDefs([])
    }
  }, [activeListId, refreshItems, refreshDefs])

  // A task added from the global quick-add FAB refreshes the rail counts and,
  // if its list is the open one, its items.
  useEffect(
    () =>
      onCreated('task', () => {
        void refreshLists()
        if (activeListId) void refreshItems(activeListId)
      }),
    [refreshLists, refreshItems, activeListId],
  )

  async function onCreateList(e: React.FormEvent) {
    e.preventDefault()
    const name = newListName.trim()
    if (!name) return
    setError(null)
    try {
      const created = await createTaskList(name)
      setNewListName('')
      setNewListOpen(false)
      setLists((prev) => [...prev, created])
      setActiveListId(created.id)
    } catch (err) {
      setError(errMessage(err))
    }
  }

  async function onDeleteList(list: TaskListDto) {
    setError(null)
    try {
      await deleteTaskList(list.id)
      // Derive the reselection from the freshest list set (prev), not the
      // captured `lists` closure, so a concurrent create/delete can't pick a
      // stale fallback. Reselect only when the deleted list was the active one.
      setLists((prev) => {
        const remaining = prev.filter((l) => l.id !== list.id)
        setActiveListId((cur) => (cur === list.id ? (remaining[0]?.id ?? null) : cur))
        return remaining
      })
    } catch (err) {
      setError(errMessage(err))
    }
  }

  async function onCreateItem(e: React.FormEvent) {
    e.preventDefault()
    const title = newItemTitle.trim()
    if (!title || !activeListId) return
    setError(null)
    try {
      if (repeat) {
        const input: CreateTaskSeriesInput = { title, freq, interval, dtstart }
        if (freq === 'weekly' && byDay.length > 0) input.byDay = byDay
        if (timeOfDay) input.timeOfDay = timeOfDay
        if (boundType === 'count') input.count = count
        else if (boundType === 'until') {
          if (!until) {
            setError('Pick an end date, or choose a different end condition.')
            return
          }
          input.until = until
        }
        await createTaskSeries(activeListId, input)
        setNewItemTitle('')
        resetRecurrence()
        // Occurrences are materialized server-side; refetch to show them.
        await refreshItems(activeListId)
      } else {
        const created = await createTaskItem(activeListId, title)
        setNewItemTitle('')
        setItems((prev) => [...prev, created])
      }
    } catch (err) {
      setError(errMessage(err))
    }
  }

  async function onToggle(item: TaskItemDto) {
    if (!activeListId) return
    setError(null)
    try {
      const updated = await setTaskItemCompleted(activeListId, item.id, !item.completed)
      setItems((prev) => prev.map((i) => (i.id === updated.id ? updated : i)))
    } catch (err) {
      setError(errMessage(err))
    }
  }

  async function onDelete(item: TaskItemDto) {
    if (!activeListId) return
    setError(null)
    try {
      await deleteTaskItem(activeListId, item.id)
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

  // Commit an inline title rename. A blank or unchanged title is a no-op (the
  // task keeps its current title). Optimistically patches the row, rolling back
  // on failure.
  async function commitInlineEdit(item: TaskItemDto) {
    const next = inlineTitle.trim()
    setInlineEditId(null)
    if (!activeListId || next === '' || next === item.title) return
    setError(null)
    setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, title: next } : i)))
    try {
      const updated = await updateTaskItem(activeListId, item.id, { title: next })
      setItems((prev) => prev.map((i) => (i.id === updated.id ? updated : i)))
    } catch (err) {
      setError(errMessage(err))
      setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, title: item.title } : i)))
    }
  }

  // Merge a single custom-field edit onto a task. Sends only the changed
  // key (null clears it); the server validates the result against the defs.
  async function onCustomFieldChange(item: TaskItemDto, fieldId: string, value: unknown | null) {
    if (!activeListId) return
    setError(null)
    try {
      const updated = await setTaskItemCustomFields(activeListId, item.id, { [fieldId]: value })
      setItems((prev) => prev.map((i) => (i.id === updated.id ? updated : i)))
      // Keep the open edit drawer's values in sync.
      setEditing((cur) => (cur && cur.id === updated.id ? updated : cur))
    } catch (err) {
      setError(errMessage(err))
    }
  }

  const doneCount = items.filter((i) => i.completed).length
  const fieldByKey = new Map(defs.map((d) => [d.id, d]))

  return (
    <>
      <div className="pg-head">
        <div>
          <h1>Tasks</h1>
          <div className="sub">Your personal task lists.</div>
        </div>
      </div>

      {error && (
        <p role="alert" style={{ color: 'var(--hot)', fontSize: 13, marginTop: 0 }}>
          {error}
        </p>
      )}

      <div className="tk-grid">
        {/* Lists rail */}
        <section style={{ display: 'grid', gap: 10 }}>
          {loadingLists ? (
            <p className="meta" style={{ color: 'var(--ink-mute)' }}>Loading…</p>
          ) : (
            <nav className="tk-lists">
              {lists.length === 0 && (
                <p className="meta" style={{ color: 'var(--ink-mute)', margin: 0 }}>No lists yet — create one below.</p>
              )}
              {lists.map((l) => {
                const sel = l.id === activeListId
                const flyoutOpen = flyoutListId === l.id
                const confirmPending = confirmListId === l.id
                return (
                  <div key={l.id} style={{ display: 'flex', alignItems: 'stretch', gap: 0 }}>
                    <button
                      type="button"
                      className={'pl-navlink' + (sel ? ' is-sel' : '')}
                      onClick={() => setActiveListId(l.id)}
                      style={{
                        flex: 1,
                        minWidth: 0,
                        borderLeft: sel ? '3px solid var(--acid)' : '3px solid transparent',
                        padding: '9px 11px',
                        background: sel ? 'var(--accent-soft)' : 'transparent',
                        borderTop: '1.5px solid',
                        borderRight: '1.5px solid',
                        borderBottom: '1.5px solid',
                        borderTopColor: sel ? 'var(--acid)' : 'transparent',
                        borderRightColor: sel ? 'var(--acid)' : 'transparent',
                        borderBottomColor: sel ? 'var(--acid)' : 'transparent',
                        color: sel ? 'var(--ink)' : 'var(--ink-dim)',
                        letterSpacing: 0,
                        textTransform: 'none',
                        fontFamily: 'var(--font-body)',
                        fontWeight: sel ? 700 : 500,
                        fontSize: 13,
                      }}
                    >
                      <span
                        style={{
                          width: 9,
                          height: 9,
                          borderRadius: 999,
                          flex: '0 0 9px',
                          background: l.color || 'var(--ink-mute)',
                          display: 'inline-block',
                          opacity: sel ? 1 : 0.55,
                        }}
                      />
                      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {l.name}
                      </span>
                      <span
                        className="meta"
                        style={{ flex: '0 0 auto', color: sel ? 'var(--acid)' : 'var(--ink-mute)', fontWeight: 700 }}
                      >
                        {l.incompleteCount}
                      </span>
                    </button>

                    {/* Settings live on the active list only — inactive rows stay clean. */}
                    {!sel ? null : confirmPending ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0, padding: '0 6px' }}>
                        <button
                          type="button"
                          className="tk-list-confirm-chip"
                          onClick={() => { cancelConfirm(); void onDeleteList(l) }}
                          aria-label={`Confirm delete ${l.name}`}
                        >
                          Confirm delete?
                        </button>
                        <button
                          type="button"
                          className="tk-list-confirm-cancel"
                          onClick={cancelConfirm}
                          aria-label="Cancel"
                        >
                          ✕
                        </button>
                      </div>
                    ) : (
                      /* ··· overflow trigger + flyout */
                      <div
                        className="tk-list-overflow"
                        ref={(el) => {
                          if (el) flyoutRefs.current.set(l.id, el)
                          else flyoutRefs.current.delete(l.id)
                        }}
                      >
                        <button
                          type="button"
                          className="tk-list-more-btn"
                          aria-label={`More options for ${l.name}`}
                          aria-expanded={flyoutOpen}
                          aria-haspopup="menu"
                          onClick={() => setFlyoutListId(flyoutOpen ? null : l.id)}
                        >
                          <Icon name="more" size={14} />
                        </button>
                        {flyoutOpen && (
                          <div className="pl-flyout is-up is-right" role="menu" style={{ minWidth: 160 }}>
                            <button
                              type="button"
                              role="menuitem"
                              className="tk-list-menu-item is-destructive"
                              onClick={() => openConfirm(l.id)}
                            >
                              Delete list
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
              <button
                type="button"
                className="pl-navlink tk-list-add"
                onClick={() => setNewListOpen(true)}
                style={{
                  borderLeft: '3px solid transparent',
                  border: '1.5px dashed var(--line)',
                  padding: '9px 11px',
                  color: 'var(--ink-dim)',
                  letterSpacing: 0,
                  textTransform: 'none',
                  fontFamily: 'var(--font-body)',
                  fontWeight: 600,
                  fontSize: 13,
                }}
              >
                <Icon name="plus" size={12} />
                <span>New list</span>
              </button>
            </nav>
          )}
        </section>

        {/* Items column */}
        <section style={{ display: 'grid', gap: 12, minWidth: 0 }}>
          {activeListId == null ? (
            <p className="meta" style={{ color: 'var(--ink-mute)' }}>Select or create a list.</p>
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
                <button className="pl-btn" style={{ padding: '0 16px' }} type="submit">
                  <Icon name="plus" size={13} />
                  Add
                </button>
              </form>

              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--ink-dim)', cursor: 'pointer' }}>
                <Check done={repeat} sz={18} onClick={() => setRepeat((r) => !r)} />
                <span style={{ color: repeat ? 'var(--ink)' : 'var(--ink-dim)' }}>Repeat this task</span>
                {repeat && (
                  <span className="pl-chip repeat" style={{ marginLeft: 4 }}>
                    <Icon name="repeat" size={10} />
                    Series
                  </span>
                )}
              </label>

              {repeat && (
                <div className="pl-card" style={{ padding: 14, display: 'grid', gap: 12 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span className="meta">Every</span>
                    <input
                      className="pl-input"
                      type="number"
                      min={1}
                      aria-label="Interval"
                      value={interval}
                      onChange={(e) => setIntervalValue(Math.max(1, Number(e.target.value) || 1))}
                      style={{ width: 56, padding: '8px 10px', textAlign: 'center' }}
                    />
                    <div className="seg">
                      <button type="button" className={freq === 'daily' ? 'on' : ''} onClick={() => setFreq('daily')}>
                        Day(s)
                      </button>
                      <button type="button" className={freq === 'weekly' ? 'on' : ''} onClick={() => setFreq('weekly')}>
                        Week(s)
                      </button>
                    </div>
                  </div>

                  {freq === 'weekly' && (
                    <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                      {DAY_CODES.map((day) => {
                        const on = byDay.includes(day)
                        return (
                          <button
                            key={day}
                            type="button"
                            className="pl-chip"
                            aria-pressed={on}
                            onClick={() => toggleDay(day)}
                            style={{
                              cursor: 'pointer',
                              padding: '5px 8px',
                              borderColor: on ? 'var(--acid)' : 'var(--line)',
                              color: on ? 'var(--acid)' : 'var(--ink-mute)',
                              background: on ? 'var(--accent-soft)' : 'transparent',
                            }}
                          >
                            {day}
                          </button>
                        )
                      })}
                    </div>
                  )}

                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span className="meta">Starts</span>
                    <input
                      className="pl-input"
                      type="date"
                      aria-label="Start date"
                      value={dtstart}
                      onChange={(e) => setDtstart(e.target.value)}
                      style={{ width: 'auto', padding: '8px 10px' }}
                    />
                    <span className="meta" style={{ marginLeft: 8 }}>Time</span>
                    <input
                      className="pl-input"
                      type="time"
                      aria-label="Time of day"
                      value={timeOfDay}
                      onChange={(e) => setTimeOfDay(e.target.value)}
                      style={{ width: 'auto', padding: '8px 10px' }}
                    />
                  </label>

                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span className="meta">Ends</span>
                    <div className="seg">
                      <button type="button" className={boundType === 'count' ? 'on' : ''} onClick={() => setBoundType('count')}>
                        After N
                      </button>
                      <button type="button" className={boundType === 'until' ? 'on' : ''} onClick={() => setBoundType('until')}>
                        On date
                      </button>
                      <button type="button" className={boundType === 'forever' ? 'on' : ''} onClick={() => setBoundType('forever')}>
                        Open
                      </button>
                    </div>
                    {boundType === 'count' && (
                      <input
                        className="pl-input"
                        type="number"
                        min={1}
                        max={50}
                        aria-label="Occurrence count"
                        value={count}
                        onChange={(e) => setCount(Math.min(50, Math.max(1, Number(e.target.value) || 1)))}
                        style={{ width: 64, padding: '8px 10px', textAlign: 'center' }}
                      />
                    )}
                    {boundType === 'until' && (
                      <input
                        className="pl-input"
                        type="date"
                        aria-label="End date"
                        min={dtstart}
                        value={until}
                        onChange={(e) => setUntil(e.target.value)}
                        style={{ width: 'auto', padding: '8px 10px' }}
                      />
                    )}
                    <span className="meta" style={{ color: 'var(--ink-mute)', marginLeft: 'auto' }}>Max 50 · rolling window</span>
                  </div>
                </div>
              )}

              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span className="meta" style={{ color: 'var(--ink-mute)' }}>
                  {doneCount} / {items.length} done
                </span>
                <span style={{ flex: 1, height: 1, background: 'var(--line)' }} />
                <button
                  type="button"
                  className="pl-btn ghost"
                  style={{ padding: '7px 11px' }}
                  onClick={() => setFieldsOpen(true)}
                >
                  <Icon name="sliders" size={12} />
                  Fields{defs.length > 0 ? ` · ${defs.length}` : ''}
                </button>
              </div>

              {loadingItems ? (
                <p className="meta" style={{ color: 'var(--ink-mute)' }}>Loading…</p>
              ) : items.length === 0 ? (
                <p className="meta" style={{ color: 'var(--ink-mute)' }}>Nothing here yet — add a task above.</p>
              ) : (
                <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 7 }}>
                  {items.map((item) => {
                    const fieldEntries = Object.entries(item.customFields).filter(
                      ([, v]) => v != null && v !== '',
                    )
                    return (
                      <li key={item.id} className="pl-row" style={{ gridTemplateColumns: '20px 1fr auto', alignItems: 'start' }}>
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
                              title="Rename — or use the ⋯ details button to edit priority, due date & fields"
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
                            {dueLabel(item.dueDate) && (
                              <span className="pl-chip">
                                <Icon name="clock" size={10} />
                                {dueLabel(item.dueDate)}
                              </span>
                            )}
                            {item.seriesId && (
                              <span className="pl-chip repeat">
                                <Icon name="repeat" size={10} />
                                Repeats
                              </span>
                            )}
                            {fieldEntries.map(([k, v]) => {
                              const def = fieldByKey.get(k)
                              return (
                                <span key={k} className="pl-chip">
                                  <b style={{ color: 'var(--ink-mute)', fontWeight: 700, marginRight: 4 }}>
                                    {def?.label ?? 'Field'}
                                  </b>
                                  {String(v)}
                                </span>
                              )
                            })}
                          </span>
                        </span>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                          <button
                            type="button"
                            className="pl-donebtn"
                            onClick={() => setEditing(item)}
                            aria-label={`Edit details for ${item.title}`}
                            title="Priority, due date & custom fields"
                          >
                            <Icon name="sliders" size={13} />
                          </button>
                          <button
                            type="button"
                            className="pl-donebtn"
                            onClick={() => void onDelete(item)}
                            aria-label={`Delete ${item.title}`}
                            title="Delete"
                          >
                            ✕
                          </button>
                        </span>
                      </li>
                    )
                  })}
                </ul>
              )}
            </>
          )}
        </section>
      </div>

      <Drawer open={editing !== null} onClose={() => setEditing(null)} title="Task" mobileSheet>
        {editing && (
          <TaskDetail
            task={editing}
            onChanged={() => {
              if (activeListId) void refreshItems(activeListId)
            }}
            onClose={() => setEditing(null)}
            fieldDefs={defs}
            customFields={editing.customFields}
            onCustomFieldChange={(fieldId, value) => void onCustomFieldChange(editing, fieldId, value)}
          />
        )}
      </Drawer>

      <Drawer
        open={newListOpen}
        onClose={() => { setNewListOpen(false); setNewListName('') }}
        title="New list"
        mobileSheet
      >
        <form style={{ display: 'grid', gap: 10, padding: '4px 0' }} onSubmit={onCreateList}>
          <input
            className="pl-input"
            aria-label="New list name"
            placeholder="List name…"
            autoFocus
            value={newListName}
            onChange={(e) => setNewListName(e.target.value)}
          />
          <button className="pl-btn" type="submit" disabled={!newListName.trim()}>
            <Icon name="plus" size={13} />
            Create list
          </button>
        </form>
      </Drawer>

      <Drawer open={fieldsOpen} onClose={() => setFieldsOpen(false)} title="Custom fields" width={420} mobileSheet>
        {activeListId && (
          <FieldManager
            listId={activeListId}
            defs={defs}
            onChanged={() => refreshDefs(activeListId)}
          />
        )}
      </Drawer>
    </>
  )
}

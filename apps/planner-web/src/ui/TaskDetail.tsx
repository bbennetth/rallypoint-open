import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, deleteTaskItem, setTaskItemCompleted, updateTaskItem } from '../lib/api.js'
import { PriorityPicker } from './PriorityPicker.js'
import { DoneBtn } from './bits.js'
import { hasTimeOfDay, instantToDateInput, instantToTimeInput } from '../lib/planner-helpers.js'
import { applyPatchToState, buildTaskPatch, taskEditState } from '../lib/task-edit.js'

// Detail + quick-edit body for a task, rendered inside an Ink Drawer by the
// host page (My Day / Upcoming / Tasks). Edits the first-class task columns
// (title / priority / due date) plus complete-toggle and delete. Edits
// auto-save: each change is debounced and patched, then `onChanged()` fires so
// the host refetches — there is no explicit Save button. The shape is the
// common subset both MyDayTask and TaskItemDto satisfy.

// Debounce window before an edit is flushed to the server. Field blur and
// drawer close flush immediately, so this only governs mid-typing saves.
const SAVE_DEBOUNCE_MS = 600

export interface EditableTask {
  id: string
  listId: string
  title: string
  priority: string | null
  dueDate: string | null
  completed: boolean
  seriesId?: string | null
}

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error'

function errMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message
  return 'Something went wrong. Please try again.'
}

export function TaskDetail({
  task,
  onChanged,
  onClose,
}: {
  task: EditableTask
  onChanged: () => void
  onClose: () => void
}) {
  const [title, setTitle] = useState(task.title)
  const [priority, setPriority] = useState<string | null>(task.priority)
  const [due, setDue] = useState(instantToDateInput(task.dueDate))
  const [dueTime, setDueTime] = useState(hasTimeOfDay(task.dueDate) ? instantToTimeInput(task.dueDate) : '')
  const [completed, setCompleted] = useState(task.completed)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<SaveStatus>('idle')
  const [error, setError] = useState<string | null>(null)

  // The last-persisted baseline each edit is diffed against, and the latest
  // draft — both in refs so the debounced flush always reads current values
  // without being re-created on every keystroke.
  const savedRef = useRef(taskEditState(task))
  const draftRef = useRef(savedRef.current)
  draftRef.current = { title, priority, dueInput: due, dueTimeInput: dueTime }
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // A different task opened into the same drawer instance — reset baseline +
  // fields to the new task. Keyed on id ONLY: a refetch that re-supplies the
  // same task (e.g. after a priority save fires onChanged) must not reset and
  // clobber an in-progress title edit.
  const taskId = task.id
  useEffect(() => {
    savedRef.current = taskEditState(task)
    setTitle(task.title)
    setPriority(task.priority)
    setDue(instantToDateInput(task.dueDate))
    setDueTime(hasTimeOfDay(task.dueDate) ? instantToTimeInput(task.dueDate) : '')
    setStatus('idle')
    setError(null)
  }, [taskId])

  const flush = useCallback(async () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    const patch = buildTaskPatch(savedRef.current, draftRef.current)
    if (!patch) return
    setStatus('saving')
    setError(null)
    try {
      await updateTaskItem(task.listId, task.id, patch)
      savedRef.current = applyPatchToState(savedRef.current, patch)
      setStatus('saved')
      onChanged()
    } catch (err) {
      setError(errMessage(err))
      setStatus('error')
    }
  }, [task.listId, task.id, onChanged])

  // Flush any pending edit on unmount (drawer close) — without depending on the
  // possibly-unstable `flush`/`onChanged` identity, which would fire mid-edit.
  const flushRef = useRef(flush)
  flushRef.current = flush
  useEffect(() => () => void flushRef.current(), [])

  function scheduleSave() {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => void flush(), SAVE_DEBOUNCE_MS)
  }

  function onTitleChange(v: string) {
    setTitle(v)
    // Clear a stale "Saved" the instant the user resumes typing, rather than
    // letting it linger through the debounce window until the next save fires.
    if (status !== 'idle') setStatus('idle')
    scheduleSave()
  }
  function onTitleBlur() {
    // An empty title is never persisted (buildTaskPatch skips it); snap the
    // field back to the saved title so the input doesn't sit visually empty.
    if (title.trim() === '') {
      setTitle(savedRef.current.title)
    } else {
      void flush()
    }
  }
  function onPriorityChange(p: string | null) {
    setPriority(p)
    // Priority is a discrete pick, not typing — save right away.
    if (timerRef.current) clearTimeout(timerRef.current)
    draftRef.current = { ...draftRef.current, priority: p }
    void flush()
  }
  function onDueChange(v: string) {
    setDue(v)
    // A time with no date is meaningless — clear it when the date is cleared.
    const time = v ? draftRef.current.dueTimeInput : ''
    if (!v) setDueTime('')
    if (timerRef.current) clearTimeout(timerRef.current)
    draftRef.current = { ...draftRef.current, dueInput: v, dueTimeInput: time }
    void flush()
  }
  function onDueTimeChange(v: string) {
    setDueTime(v)
    if (timerRef.current) clearTimeout(timerRef.current)
    draftRef.current = { ...draftRef.current, dueTimeInput: v }
    void flush()
  }

  async function toggleDone() {
    const next = !completed
    setCompleted(next)
    setError(null)
    try {
      await setTaskItemCompleted(task.listId, task.id, next)
      onChanged()
    } catch (err) {
      setError(errMessage(err))
      setCompleted(!next)
    }
  }

  async function remove() {
    if (busy) return
    // Cancel any pending autosave so it can't race the delete.
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    setBusy(true)
    setError(null)
    try {
      await deleteTaskItem(task.listId, task.id)
      onChanged()
      onClose()
    } catch (err) {
      setError(errMessage(err))
      setBusy(false)
    }
  }

  return (
    <div className="pl-fab-form">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <DoneBtn done={completed} onClick={() => void toggleDone()} busy={busy} />
        {task.seriesId && <span className="pl-chip">Repeats</span>}
        <span
          aria-live="polite"
          className="meta"
          style={{
            marginLeft: 'auto',
            color: status === 'error' ? 'var(--hot)' : 'var(--ink-mute)',
            minHeight: 14,
          }}
        >
          {status === 'saving' ? 'Saving…' : status === 'saved' ? 'Saved' : ''}
        </span>
      </div>
      <label className="pl-fab-label">
        Title
        <input
          className="pl-input"
          value={title}
          onChange={(e) => onTitleChange(e.target.value)}
          onBlur={onTitleBlur}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              e.currentTarget.blur()
            }
          }}
          aria-label="Task title"
        />
      </label>
      <div className="pl-fab-label">
        Priority
        <PriorityPicker value={priority} onChange={onPriorityChange} disabled={busy} allowClear />
      </div>
      <label className="pl-fab-label">
        Due date
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            className="pl-input"
            type="date"
            value={due}
            onChange={(e) => onDueChange(e.target.value)}
            aria-label="Due date"
          />
          <input
            className="pl-input"
            type="time"
            value={dueTime}
            onChange={(e) => onDueTimeChange(e.target.value)}
            aria-label="Due time"
            disabled={!due}
          />
        </div>
      </label>
      {error && (
        <p role="alert" className="pl-fab-error">
          {error}
        </p>
      )}
      <button className="pl-btn ghost" type="button" onClick={() => void remove()} disabled={busy}>
        Delete task
      </button>
    </div>
  )
}

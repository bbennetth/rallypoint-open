import { useState, type FormEvent } from 'react'
import {
  ApiError,
  deleteTaskItem,
  setTaskItemCompleted,
  updateTaskItem,
  type FieldDefDto,
} from '../lib/api.js'
import { CustomFieldsEditor } from '../components/CustomFieldsEditor.js'
import { PriorityPicker } from './PriorityPicker.js'
import { DoneBtn } from './bits.js'
import { dateInputToInstant, instantToDateInput } from '../lib/planner-helpers.js'

// Detail + quick-edit body for a task, rendered inside an Ink Drawer by the
// host page (My Day / Upcoming / Tasks). Edits the first-class task columns
// (title / priority / due date) plus complete-toggle and delete; after any
// successful write it calls `onChanged()` so the host refetches. The shape is
// the common subset both MyDayTask and TaskItemDto satisfy.

export interface EditableTask {
  id: string
  listId: string
  title: string
  priority: string | null
  dueDate: string | null
  completed: boolean
  seriesId?: string | null
}

function errMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message
  return 'Something went wrong. Please try again.'
}

export function TaskDetail({
  task,
  onChanged,
  onClose,
  fieldDefs,
  customFields,
  onCustomFieldChange,
}: {
  task: EditableTask
  onChanged: () => void
  onClose: () => void
  // Optional per-task custom-field editing (Tasks page passes these; My Day /
  // Upcoming don't, since they don't have the list's field defs loaded).
  fieldDefs?: FieldDefDto[]
  customFields?: Record<string, unknown>
  onCustomFieldChange?: (fieldId: string, value: unknown | null) => void
}) {
  const [title, setTitle] = useState(task.title)
  const [priority, setPriority] = useState<string | null>(task.priority)
  const [due, setDue] = useState(instantToDateInput(task.dueDate))
  const [completed, setCompleted] = useState(task.completed)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save(e: FormEvent) {
    e.preventDefault()
    const t = title.trim()
    if (!t || busy) return
    setBusy(true)
    setError(null)
    const patch: { title?: string; priority?: string | null; dueDate?: string | null } = {}
    if (t !== task.title) patch.title = t
    if (priority !== task.priority) patch.priority = priority
    if (due !== instantToDateInput(task.dueDate)) patch.dueDate = dateInputToInstant(due)
    try {
      if (Object.keys(patch).length > 0) await updateTaskItem(task.listId, task.id, patch)
      onChanged()
      onClose()
    } catch (err) {
      setError(errMessage(err))
      setBusy(false)
    }
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
    <form className="pl-fab-form" onSubmit={save}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <DoneBtn done={completed} onClick={() => void toggleDone()} busy={busy} />
        {task.seriesId && <span className="pl-chip">Repeats</span>}
      </div>
      <label className="pl-fab-label">
        Title
        <input
          className="pl-input"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          aria-label="Task title"
        />
      </label>
      <div className="pl-fab-label">
        Priority
        <PriorityPicker value={priority} onChange={(p) => setPriority(p)} disabled={busy} allowClear />
      </div>
      <label className="pl-fab-label">
        Due date
        <input
          className="pl-input"
          type="date"
          value={due}
          onChange={(e) => setDue(e.target.value)}
          aria-label="Due date"
        />
      </label>
      {fieldDefs && fieldDefs.length > 0 && onCustomFieldChange && (
        <div style={{ display: 'grid', gap: 8 }}>
          <div className="eyebrow">Custom fields</div>
          <CustomFieldsEditor
            defs={fieldDefs}
            values={customFields ?? {}}
            onChange={onCustomFieldChange}
          />
        </div>
      )}
      {error && <p role="alert" className="pl-fab-error">{error}</p>}
      <button className="pl-btn" type="submit" disabled={busy || !title.trim()}>
        Save changes
      </button>
      <button className="pl-btn ghost" type="button" onClick={() => void remove()} disabled={busy}>
        Delete task
      </button>
    </form>
  )
}

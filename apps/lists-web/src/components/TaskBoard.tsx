import { useEffect, useState, type CSSProperties } from 'react'
import {
  TASK_PRIORITIES,
  nextStatus,
  type TaskPriority,
  type TaskStatus,
} from '@rallypoint/lists-shared'
import type { FieldDefDto, GroupMemberDto, ListDto, ListItemDto } from '../lib/api.js'
import { CustomFieldsEditor } from './CustomFieldsEditor.js'

// Faithful port of festival-planner's Tasks.tsx kanban: three columns
// (To do / In progress / Done) built by grouping items on status (a null
// status — e.g. a pre-slice-3 row — reads as 'todo'). Click the status
// chip to cycle todo→in_progress→done→todo; the server mirrors completed.

const COLUMNS: { status: TaskStatus; label: string }[] = [
  { status: 'todo', label: 'To do' },
  { status: 'in_progress', label: 'In progress' },
  { status: 'done', label: 'Done' },
]

// Semantic Ink mapping (sky/amber/rose aren't theme-remapped, so set
// border+text via inline style): low de-emphasised, high = destructive red.
const PRIORITY_STYLE: Record<TaskPriority, CSSProperties> = {
  low: { borderColor: 'var(--line)', color: 'var(--ink-dim)' },
  medium: { borderColor: 'var(--acid)', color: 'var(--acid)' },
  high: { borderColor: 'var(--hot)', color: 'var(--hot)' },
}

function effectiveStatus(item: ListItemDto): TaskStatus {
  return item.status ?? 'todo'
}

interface TaskBoardProps {
  items: ListItemDto[]
  members: GroupMemberDto[]
  // Other lists in scope the card can be moved into (current list excluded).
  moveTargets: ListDto[]
  fieldDefs: FieldDefDto[]
  onCycleStatus: (itemId: string, next: TaskStatus) => void
  onRename: (itemId: string, title: string) => void
  onAssign: (itemId: string, assignedTo: string) => void
  onSetPriority: (itemId: string, priority: TaskPriority) => void
  onSetDueDate: (itemId: string, dueDate: string | null) => void
  onMove: (itemId: string, targetListId: string) => void
  onSetCustomField: (itemId: string, fieldId: string, value: unknown | null) => void
  onDelete: (itemId: string) => void
}

export function TaskBoard({
  items,
  members,
  moveTargets,
  fieldDefs,
  onCycleStatus,
  onRename,
  onAssign,
  onSetPriority,
  onSetDueDate,
  onMove,
  onSetCustomField,
  onDelete,
}: TaskBoardProps) {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
      {COLUMNS.map((col) => {
        const cards = items.filter((i) => effectiveStatus(i) === col.status)
        return (
          <div
            key={col.status}
            className="p-3"
            style={{ border: '1.5px solid var(--line)', background: 'var(--surface)' }}
          >
            <h2 className="mb-3 flex items-center justify-between text-xs font-semibold text-[color:var(--ink-dim)]">
              {col.label}
              <span className="chip">{cards.length}</span>
            </h2>
            {cards.length === 0 ? (
              <p className="px-1 py-4 text-center text-xs text-[color:var(--ink-mute)]">No tasks</p>
            ) : (
              <ul className="space-y-2">
                {cards.map((item) => (
                  <TaskCard
                    key={item.id}
                    item={item}
                    members={members}
                    moveTargets={moveTargets}
                    fieldDefs={fieldDefs}
                    onCycleStatus={onCycleStatus}
                    onRename={onRename}
                    onAssign={onAssign}
                    onSetPriority={onSetPriority}
                    onSetDueDate={onSetDueDate}
                    onMove={onMove}
                    onSetCustomField={onSetCustomField}
                    onDelete={onDelete}
                  />
                ))}
              </ul>
            )}
          </div>
        )
      })}
    </div>
  )
}

interface TaskCardProps {
  item: ListItemDto
  members: GroupMemberDto[]
  moveTargets: ListDto[]
  fieldDefs: FieldDefDto[]
  onCycleStatus: (itemId: string, next: TaskStatus) => void
  onRename: (itemId: string, title: string) => void
  onAssign: (itemId: string, assignedTo: string) => void
  onSetPriority: (itemId: string, priority: TaskPriority) => void
  onSetDueDate: (itemId: string, dueDate: string | null) => void
  onMove: (itemId: string, targetListId: string) => void
  onSetCustomField: (itemId: string, fieldId: string, value: unknown | null) => void
  onDelete: (itemId: string) => void
}

// <input type="date"> wants yyyy-mm-dd; the DTO carries a full ISO string.
function toDateInput(iso: string | null): string {
  if (!iso) return ''
  return iso.slice(0, 10)
}

function TaskCard({
  item,
  members,
  moveTargets,
  fieldDefs,
  onCycleStatus,
  onRename,
  onAssign,
  onSetPriority,
  onSetDueDate,
  onMove,
  onSetCustomField,
  onDelete,
}: TaskCardProps) {
  const status = effectiveStatus(item)
  const [title, setTitle] = useState(item.title)

  useEffect(() => {
    setTitle(item.title)
  }, [item.title])

  function commitTitle() {
    const next = title.trim()
    if (next.length > 0 && next !== item.title) onRename(item.id, next)
    else setTitle(item.title)
  }

  return (
    <li
      className="space-y-2 p-3"
      style={{ border: '1.5px solid var(--line)', background: 'var(--surface-2)' }}
    >
      <div className="flex items-start gap-2">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={commitTitle}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          }}
          className={`flex-1 bg-transparent text-sm focus:outline-none ${
            status === 'done' ? 'text-[color:var(--ink-mute)] line-through' : ''
          }`}
        />
        <button
          type="button"
          onClick={() => onDelete(item.id)}
          aria-label="Delete task"
          className="rounded px-1"
          style={{ color: 'var(--hot)' }}
        >
          ✕
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => onCycleStatus(item.id, nextStatus(status))}
          className="chip"
        >
          {COLUMNS.find((c) => c.status === status)?.label ?? status}
        </button>

        <select
          value={item.priority ?? 'medium'}
          onChange={(e) => onSetPriority(item.id, e.target.value as TaskPriority)}
          aria-label="Priority"
          className="rounded-full border bg-transparent px-2 py-0.5 text-xs"
          style={PRIORITY_STYLE[item.priority ?? 'medium']}
        >
          {TASK_PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <input
          type="date"
          value={toDateInput(item.due_date)}
          onChange={(e) => onSetDueDate(item.id, e.target.value === '' ? null : e.target.value)}
          aria-label="Due date"
          className="cyber-input"
          style={{ width: 'auto', padding: '4px 8px' }}
        />

        <select
          value={item.assigned_to ?? ''}
          onChange={(e) => onAssign(item.id, e.target.value)}
          aria-label="Assignee"
          className="cyber-input"
          style={{ width: 'auto', padding: '4px 8px' }}
        >
          <option value="">Unassigned</option>
          {item.assigned_to && !members.some((m) => m.user_id === item.assigned_to) && (
            <option value={item.assigned_to}>{item.assigned_to}</option>
          )}
          {members.map((m) => (
            <option key={m.id} value={m.user_id}>
              {m.user_id}
            </option>
          ))}
        </select>
      </div>

      {moveTargets.length > 0 && (
        <select
          value=""
          onChange={(e) => {
            if (e.target.value) onMove(item.id, e.target.value)
          }}
          aria-label="Move to list"
          className="cyber-input"
          style={{ padding: '4px 8px' }}
        >
          <option value="">Move to…</option>
          {moveTargets.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
      )}

      {fieldDefs.length > 0 && (
        <CustomFieldsEditor
          defs={fieldDefs}
          values={item.custom_fields}
          members={members}
          onChange={(fieldId, value) => onSetCustomField(item.id, fieldId, value)}
        />
      )}
    </li>
  )
}

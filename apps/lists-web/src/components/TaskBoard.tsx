import { useEffect, useState, type CSSProperties, type DragEvent } from 'react'
import { TASK_PRIORITIES, type TaskPriority } from '@rallypoint/lists-shared'
import type {
  FieldDefDto,
  GroupMemberDto,
  LabelDto,
  ListDto,
  ListItemDto,
  ListStatusDto,
} from '../lib/api.js'
import { CustomFieldsEditor } from './CustomFieldsEditor.js'
import { LabelChips } from './LabelChips.js'
import { groupItemsByStatus, resolveItemStatus } from '../lib/board.js'
import { statusColorStyle } from '../lib/status-colors.js'
import type { DropTarget } from '../lib/board-dnd.js'

// Kanban board over a list's custom statuses (RPL v1.0.0 S2 + S3 drag-drop).
// Layout is fluid: an equal-width `1fr` grid fills the (uncapped) board width
// down to a 280px floor, then the wrapper scrolls horizontally.
// Columns are the list's `list_statuses` in position order; a card's status
// is changed by the per-card picker OR by dragging it to another column.
// Drag-and-drop is native HTML5 (no dnd library — keeps React 19 happy and
// the ordering math, in lib/board-dnd.ts, fully unit-tested): grab a card by
// its grip handle, drop it on another card (lands before it) or a column's
// empty area (appends). An item's "done" styling keys off its resolved
// status's `category`, so a renamed done column still strikes its cards.

const PRIORITY_STYLE: Record<TaskPriority, CSSProperties> = {
  low: { borderColor: 'var(--line)', color: 'var(--ink-dim)' },
  medium: { borderColor: 'var(--acid)', color: 'var(--acid)' },
  high: { borderColor: 'var(--hot)', color: 'var(--hot)' },
}

interface TaskBoardProps {
  items: ListItemDto[]
  statuses: ListStatusDto[]
  members: GroupMemberDto[]
  // Other lists in scope the card can be moved into (current list excluded).
  moveTargets: ListDto[]
  fieldDefs: FieldDefDto[]
  // Bulk-select (RPL v1.0.0 S6): selected card ids + a per-card toggle.
  selectedIds: Set<string>
  onToggleSelect: (itemId: string, on: boolean) => void
  // Open the comments thread for a card (RPL v1.0.0 S7 UI).
  onComments: (itemId: string, title: string) => void
  // Labels (RPL v1.0.0 S12): the list's labels + a per-card replace.
  labels: LabelDto[]
  onSetLabels: (itemId: string, labelIds: string[]) => void
  onSetStatus: (itemId: string, statusId: string) => void
  // A drag-drop gesture: move `activeId` onto `target` (another card or a
  // column). The page turns this into a status change + position reindex.
  onReorder: (activeId: string, target: DropTarget) => void
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
  statuses,
  members,
  moveTargets,
  fieldDefs,
  selectedIds,
  onToggleSelect,
  onComments,
  labels,
  onSetLabels,
  onSetStatus,
  onReorder,
  onRename,
  onAssign,
  onSetPriority,
  onSetDueDate,
  onMove,
  onSetCustomField,
  onDelete,
}: TaskBoardProps) {
  const columns = groupItemsByStatus(items, statuses)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [overColumn, setOverColumn] = useState<string | null>(null)

  function endDrag() {
    setDraggingId(null)
    setOverColumn(null)
  }

  return (
    // Columns never squeeze below a usable card width — past that the board
    // scrolls horizontally instead of letting card controls bleed across
    // column borders. The scroll lives on the wrapper, NOT the grid: an
    // `overflow-x` on the grid would force `overflow-y: auto` too (CSS rule),
    // clipping a card's absolutely-positioned label popover. The board's
    // container breaks out of the page width cap (see `.plapp-full` in
    // ListDetailPage), so `1fr` tracks fill the whole viewport.
    <div className="overflow-x-auto pb-2">
      <div
        className="grid gap-4"
        style={{
          gridTemplateColumns: `repeat(${Math.max(columns.length, 1)}, minmax(280px, 1fr))`,
        }}
      >
      {columns.map((col) => {
        const chip = statusColorStyle(col.status.color)
        const isOver = overColumn === col.status.id && draggingId !== null
        return (
          <div
            key={col.status.id}
            className="p-3"
            style={{
              border: `1.5px solid ${isOver ? 'var(--acid)' : 'var(--line)'}`,
              background: 'var(--surface)',
            }}
            onDragOver={(e) => {
              if (draggingId === null) return
              e.preventDefault()
              setOverColumn(col.status.id)
            }}
            onDragLeave={(e) => {
              // Only clear when the pointer truly left this column (not when
              // it crossed onto a child card), so the highlight doesn't flicker.
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                setOverColumn((cur) => (cur === col.status.id ? null : cur))
              }
            }}
            onDrop={(e) => {
              if (draggingId === null) return
              e.preventDefault()
              onReorder(draggingId, { type: 'column', statusId: col.status.id })
              endDrag()
            }}
          >
            <h2 className="mb-3 flex items-center justify-between gap-2 text-xs font-semibold">
              <span
                className="truncate rounded-full border px-2 py-0.5"
                style={chip}
                title={col.status.name}
              >
                {col.status.name}
              </span>
              <span className="chip">{col.items.length}</span>
            </h2>
            {col.items.length === 0 ? (
              <p className="px-1 py-4 text-center text-xs text-[color:var(--ink-mute)]">
                {isOver ? 'Drop here' : 'No tasks'}
              </p>
            ) : (
              <ul className="space-y-2">
                {col.items.map((item) => (
                  <TaskCard
                    key={item.id}
                    item={item}
                    statuses={statuses}
                    members={members}
                    moveTargets={moveTargets}
                    fieldDefs={fieldDefs}
                    selected={selectedIds.has(item.id)}
                    onToggleSelect={onToggleSelect}
                    onComments={onComments}
                    labels={labels}
                    onSetLabels={onSetLabels}
                    dragging={draggingId === item.id}
                    onDragStartItem={setDraggingId}
                    onDragEndItem={endDrag}
                    onDropOnItem={(targetId) => {
                      if (draggingId === null) return
                      onReorder(draggingId, { type: 'item', itemId: targetId })
                      endDrag()
                    }}
                    onSetStatus={onSetStatus}
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
    </div>
  )
}

interface TaskCardProps {
  item: ListItemDto
  statuses: ListStatusDto[]
  members: GroupMemberDto[]
  moveTargets: ListDto[]
  fieldDefs: FieldDefDto[]
  selected: boolean
  onToggleSelect: (itemId: string, on: boolean) => void
  onComments: (itemId: string, title: string) => void
  labels: LabelDto[]
  onSetLabels: (itemId: string, labelIds: string[]) => void
  dragging: boolean
  onDragStartItem: (itemId: string) => void
  onDragEndItem: () => void
  onDropOnItem: (itemId: string) => void
  onSetStatus: (itemId: string, statusId: string) => void
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
  statuses,
  members,
  moveTargets,
  fieldDefs,
  selected,
  onToggleSelect,
  onComments,
  labels,
  onSetLabels,
  dragging,
  onDragStartItem,
  onDragEndItem,
  onDropOnItem,
  onSetStatus,
  onRename,
  onAssign,
  onSetPriority,
  onSetDueDate,
  onMove,
  onSetCustomField,
  onDelete,
}: TaskCardProps) {
  const status = resolveItemStatus(item, statuses)
  const isDone = status?.category === 'done'
  const [title, setTitle] = useState(item.title)

  useEffect(() => {
    setTitle(item.title)
  }, [item.title])

  function commitTitle() {
    const next = title.trim()
    if (next.length > 0 && next !== item.title) onRename(item.id, next)
    else setTitle(item.title)
  }

  // A card is a drop target (drop-before semantics); only the grip handle
  // initiates a drag so the title/select controls stay usable.
  function handleDrop(e: DragEvent) {
    e.preventDefault()
    e.stopPropagation()
    onDropOnItem(item.id)
  }

  return (
    <li
      className="space-y-2 p-3"
      style={{
        border: `1.5px solid ${selected ? 'var(--hot)' : 'var(--line)'}`,
        background: 'var(--surface-2)',
        opacity: dragging ? 0.5 : 1,
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={handleDrop}
    >
      <div className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={selected}
          onChange={(e) => onToggleSelect(item.id, e.target.checked)}
          className="mt-0.5 h-4 w-4"
          style={{ accentColor: 'var(--hot)' }}
          title="Select for bulk actions"
          aria-label={selected ? 'Deselect task' : 'Select task'}
        />
        <span
          role="button"
          tabIndex={0}
          aria-label="Drag to reorder"
          title="Drag to reorder"
          draggable
          onDragStart={(e) => {
            onDragStartItem(item.id)
            e.dataTransfer.effectAllowed = 'move'
            // Firefox requires data to be set for a drag to start.
            e.dataTransfer.setData('text/plain', item.id)
          }}
          onDragEnd={onDragEndItem}
          className="cursor-grab select-none px-0.5 text-[color:var(--ink-mute)]"
          style={{ lineHeight: 1 }}
        >
          ⠿
        </span>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={commitTitle}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          }}
          className={`flex-1 bg-transparent text-sm focus:outline-none ${
            isDone ? 'text-[color:var(--ink-mute)] line-through' : ''
          }`}
        />
        <button
          type="button"
          onClick={() => onComments(item.id, item.title)}
          aria-label="Comments"
          title="Comments"
          className="rounded px-1 text-[color:var(--ink-dim)] hover:text-[color:var(--ink)]"
        >
          💬
        </button>
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
        <select
          value={status?.id ?? ''}
          onChange={(e) => {
            if (e.target.value && e.target.value !== status?.id) onSetStatus(item.id, e.target.value)
          }}
          aria-label="Status"
          className="rounded-full border bg-transparent px-2 py-0.5 text-xs"
          style={statusColorStyle(status?.color ?? null)}
        >
          {statuses.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>

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

        {(item.child_count ?? 0) > 0 && (
          <span
            className="chip"
            title={`${item.child_done_count ?? 0} of ${item.child_count} sub-items done`}
            aria-label={`${item.child_done_count ?? 0} of ${item.child_count} sub-items done`}
          >
            ☰ {item.child_done_count ?? 0}/{item.child_count}
          </span>
        )}
      </div>

      <LabelChips
        labelIds={item.label_ids}
        labels={labels}
        onSetLabels={(labelIds) => onSetLabels(item.id, labelIds)}
      />

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

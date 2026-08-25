import { useEffect, useState } from 'react'
import type { FieldDefDto, GroupMemberDto, LabelDto, ListItemDto } from '../lib/api.js'
import { LabelChips } from './LabelChips.js'
import { CustomFieldsEditor } from './CustomFieldsEditor.js'
import { progressPercent } from '../lib/hierarchy-view.js'

export interface ItemRowProps {
  item: ListItemDto
  depth: number
  hasChildren: boolean
  collapsed: boolean
  onToggleCollapse: () => void
  onAddSubItem: () => void
  onComments: () => void
  labels: LabelDto[]
  onSetLabels: (labelIds: string[]) => void
  members: GroupMemberDto[]
  fieldDefs: FieldDefDto[]
  selected: boolean
  onSelect: (on: boolean) => void
  // Shift-click on the select box — extend the selection to this row.
  onRangeSelect: () => void
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

export function ItemRow({
  item,
  depth,
  hasChildren,
  collapsed,
  onToggleCollapse,
  onAddSubItem,
  onComments,
  labels,
  onSetLabels,
  members,
  fieldDefs,
  selected,
  onSelect,
  onRangeSelect,
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

  const childTotal = item.child_count ?? 0
  const childDone = item.child_done_count ?? 0

  return (
    <li
      className="space-y-2 px-3 py-2"
      style={{
        border: '1.5px solid var(--line)',
        background: 'var(--surface)',
        marginLeft: depth * 20,
      }}
    >
      <div className="flex items-center gap-3">
      {/* Collapse caret (parents only); a fixed-width spacer keeps leaf
          rows aligned with their parent's controls. */}
      {hasChildren ? (
        <button
          type="button"
          onClick={onToggleCollapse}
          aria-label={collapsed ? 'Expand sub-items' : 'Collapse sub-items'}
          aria-expanded={!collapsed}
          className="w-4 text-[color:var(--ink-dim)] hover:text-[color:var(--ink)]"
        >
          {collapsed ? '▸' : '▾'}
        </button>
      ) : (
        <span aria-hidden className="w-4" />
      )}
      <input
        type="checkbox"
        checked={selected}
        onClick={(e) => {
          // Shift-click selects the range from the anchor; let a plain click
          // fall through to onChange for the normal toggle.
          if (e.shiftKey) {
            e.preventDefault()
            onRangeSelect()
          }
        }}
        onChange={(e) => onSelect(e.target.checked)}
        className="h-4 w-4"
        style={{ accentColor: 'var(--hot)' }}
        title="Select for bulk actions (shift-click for a range)"
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
          onClick={onComments}
          aria-label="Comments"
          title="Comments"
          className="rounded px-1.5 py-0.5 text-[color:var(--ink-dim)] hover:text-[color:var(--ink)]"
        >
          💬
        </button>
        <button
          type="button"
          onClick={onAddSubItem}
          aria-label="Add sub-item"
          title="Add sub-item"
          className="rounded px-1.5 py-0.5 text-[color:var(--ink-dim)] hover:text-[color:var(--ink)]"
        >
          + sub
        </button>
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

      <div className="pl-8">
        <LabelChips labelIds={item.label_ids} labels={labels} onSetLabels={onSetLabels} />
      </div>

      {childTotal > 0 && (
        <div className="flex items-center gap-2 pl-8 text-xs" style={{ color: 'var(--ink-dim)' }}>
          <div
            className="h-1.5 flex-1 overflow-hidden rounded-full"
            style={{ background: 'var(--surface-2)' }}
            role="progressbar"
            aria-valuenow={progressPercent(childDone, childTotal)}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Sub-item progress"
          >
            <div
              className="h-full rounded-full"
              style={{
                width: `${progressPercent(childDone, childTotal)}%`,
                background: 'var(--acid)',
              }}
            />
          </div>
          <span className="shrink-0 tabular-nums">
            {childDone}/{childTotal}
          </span>
        </div>
      )}

      {fieldDefs.length > 0 && (
        <div className="pl-8">
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

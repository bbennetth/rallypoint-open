import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { FieldDefDto, GroupMemberDto, ListItemDto } from '../lib/api.js'
import { CustomFieldControl } from './CustomFieldsEditor.js'
import { gridKeyAction } from '../lib/grid-keys.js'

// Spreadsheet-style grid for a standard list (Lists v2 slice 7). Renders one
// column per built-in + custom field with inline cell editing, and a second
// view mode alongside the checklist. Power-user keyboard shortcuts (handled
// when focus is on the grid shell, not inside a cell control): j/k move the
// active row, x toggles its selection, e focuses its title to edit. Edits and
// selection flow through the same callbacks the checklist uses, so realtime /
// bulk behaviour is identical across modes.

interface GridViewProps {
  items: ListItemDto[]
  members: GroupMemberDto[]
  fieldDefs: FieldDefDto[]
  selectedIds: Set<string>
  onSelect: (itemId: string, on: boolean) => void
  onToggleComplete: (itemId: string, completed: boolean) => void
  onRename: (itemId: string, title: string) => void
  onAssign: (itemId: string, assignedTo: string) => void
  onSetCustomField: (itemId: string, fieldId: string, value: unknown | null) => void
}

const CELL = 'border-b border-r px-2 py-1 align-top'
const HEAD = 'border-b border-r px-2 py-1 text-left font-semibold'

export function GridView({
  items,
  members,
  fieldDefs,
  selectedIds,
  onSelect,
  onToggleComplete,
  onRename,
  onAssign,
  onSetCustomField,
}: GridViewProps) {
  const [activeRow, setActiveRow] = useState(0)
  const titleRefs = useRef<(HTMLInputElement | null)[]>([])

  // Keep the active row in range as the item set shrinks (filter / delete).
  useEffect(() => {
    setActiveRow((r) => Math.min(Math.max(r, 0), Math.max(items.length - 1, 0)))
  }, [items.length])

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    // Don't hijack keystrokes while a cell control has focus — typing a
    // literal "j" into a title must not navigate.
    const tag = (e.target as HTMLElement).tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return

    const action = gridKeyAction(e.key, { activeRow, rowCount: items.length })
    if (action.type === 'none') return
    e.preventDefault()
    if (action.type === 'move') {
      setActiveRow(action.row)
    } else if (action.type === 'select') {
      const item = items[activeRow]
      if (item) onSelect(item.id, !selectedIds.has(item.id))
    } else if (action.type === 'edit') {
      titleRefs.current[activeRow]?.focus()
    }
  }

  return (
    <div
      tabIndex={0}
      onKeyDown={handleKeyDown}
      className="overflow-x-auto focus:outline-none"
      aria-label="List grid. Use j and k to move, x to select, e to edit."
    >
      <p className="mb-1 text-xs" style={{ color: 'var(--ink-dim)' }}>
        <kbd>j</kbd>/<kbd>k</kbd> move · <kbd>x</kbd> select · <kbd>e</kbd> edit
      </p>
      <table className="w-full border-collapse text-sm" style={{ color: 'var(--ink)' }}>
        <thead>
          <tr style={{ background: 'var(--surface)', color: 'var(--ink-dim)' }}>
            <th className={HEAD} style={{ borderColor: 'var(--line)' }} title="Select for bulk actions">
              Select
            </th>
            <th className={HEAD} style={{ borderColor: 'var(--line)' }} title="Mark complete">
              Done
            </th>
            <th className={HEAD} style={{ borderColor: 'var(--line)' }}>
              Title
            </th>
            <th className={HEAD} style={{ borderColor: 'var(--line)' }}>
              Assignee
            </th>
            {fieldDefs.map((d) => (
              <th key={d.id} className={HEAD} style={{ borderColor: 'var(--line)' }}>
                {d.label}
                {d.required && <span style={{ color: 'var(--hot)' }}> *</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {items.map((item, index) => (
            <tr
              key={item.id}
              onClick={() => setActiveRow(index)}
              style={{
                background:
                  index === activeRow ? 'color-mix(in srgb, var(--acid) 12%, transparent)' : 'transparent',
              }}
            >
              <td className={CELL} style={{ borderColor: 'var(--line)' }}>
                <input
                  type="checkbox"
                  checked={selectedIds.has(item.id)}
                  onChange={(e) => onSelect(item.id, e.target.checked)}
                  className="h-4 w-4"
                  style={{ accentColor: 'var(--hot)' }}
                  title="Select for bulk actions"
                  aria-label={selectedIds.has(item.id) ? 'Deselect item' : 'Select item'}
                />
              </td>
              <td className={CELL} style={{ borderColor: 'var(--line)' }}>
                <input
                  type="checkbox"
                  checked={item.completed}
                  onChange={(e) => onToggleComplete(item.id, e.target.checked)}
                  className="h-4 w-4"
                  style={{ accentColor: 'var(--acid)' }}
                  title={item.completed ? 'Mark incomplete' : 'Mark complete'}
                  aria-label={item.completed ? 'Mark incomplete' : 'Mark complete'}
                />
              </td>
              <td className={CELL} style={{ borderColor: 'var(--line)', minWidth: 160 }}>
                <TitleCell
                  ref={(el) => {
                    titleRefs.current[index] = el
                  }}
                  value={item.title}
                  completed={item.completed}
                  onCommit={(title) => onRename(item.id, title)}
                />
              </td>
              <td className={CELL} style={{ borderColor: 'var(--line)' }}>
                <select
                  value={item.assigned_to ?? ''}
                  onChange={(e) => onAssign(item.id, e.target.value)}
                  className="cyber-input"
                  style={{ width: 'auto', padding: '4px 8px' }}
                  aria-label="Assignee"
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
              </td>
              {fieldDefs.map((d) => (
                <td key={d.id} className={CELL} style={{ borderColor: 'var(--line)' }}>
                  <CustomFieldControl
                    def={d}
                    value={item.custom_fields[d.id]}
                    members={members}
                    onChange={(v) => onSetCustomField(item.id, d.id, v)}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// Title cell: local draft committed on blur / Enter, mirroring the checklist
// row so the parent only PATCHes on commit. Forwards a ref so the grid's `e`
// shortcut can focus it.
const TitleCell = forwardRef<
  HTMLInputElement,
  { value: string; completed: boolean; onCommit: (title: string) => void }
>(function TitleCell({ value, completed, onCommit }, ref) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  useImperativeHandle(ref, () => inputRef.current as HTMLInputElement)
  const [draft, setDraft] = useState(value)
  useEffect(() => {
    setDraft(value)
  }, [value])

  function commit() {
    const next = draft.trim()
    if (next.length > 0 && next !== value) onCommit(next)
    else setDraft(value)
  }

  return (
    <input
      ref={inputRef}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
      }}
      className={`w-full bg-transparent focus:outline-none ${
        completed ? 'line-through text-[color:var(--ink-mute)]' : ''
      }`}
    />
  )
})

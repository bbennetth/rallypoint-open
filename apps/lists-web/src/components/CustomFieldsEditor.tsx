import { useEffect, useState } from 'react'
import type { FieldDefDto, GroupMemberDto } from '../lib/api.js'
import { activeChoices, multiValue, toggleSelection } from '../lib/field-form.js'

// Renders one inline control per custom field def for a single item, and
// reports edits back via onChange (fieldId → wire value, or null to clear
// the key). Shared by the standard list rows and the task cards so both
// surfaces edit typed values identically. The value encoding matches the
// server's `validateCustomFields`: text→string, number→number,
// date→ISO/yyyy-mm-dd, checkbox→bool, single→choice id, multi→choice ids,
// person→user id, url→string.

interface CustomFieldsEditorProps {
  defs: FieldDefDto[]
  values: Record<string, unknown>
  members: GroupMemberDto[]
  onChange: (fieldId: string, value: unknown | null) => void
}

export function CustomFieldsEditor({ defs, values, members, onChange }: CustomFieldsEditorProps) {
  if (defs.length === 0) return null
  return (
    <div className="flex flex-wrap items-start gap-3">
      {defs.map((def) => (
        <label
          key={def.id}
          className="flex flex-col gap-0.5 text-xs"
          style={{ color: 'var(--ink-dim)' }}
        >
          <span>
            {def.label}
            {def.required && <span style={{ color: 'var(--hot)' }}> *</span>}
          </span>
          <CustomFieldControl
            def={def}
            value={values[def.id]}
            members={members}
            onChange={(v) => onChange(def.id, v)}
          />
        </label>
      ))}
    </div>
  )
}

interface ControlProps {
  def: FieldDefDto
  value: unknown
  members: GroupMemberDto[]
  onChange: (value: unknown | null) => void
}

const COMPACT = { width: 'auto', padding: '4px 8px' } as const

// One bare control for a single def's value (no label wrapper). Exported so
// the grid view can render it as a cell editor, reusing the exact same
// per-type encoding the stacked editor uses.
export function CustomFieldControl({ def, value, members, onChange }: ControlProps) {
  switch (def.field_type) {
    case 'text':
      return <TextControl value={value} multiline={def.options.multiline === true} onChange={onChange} />
    case 'url':
      return <TextControl value={value} multiline={false} type="url" onChange={onChange} />
    case 'number':
      return <NumberControl value={value} onChange={onChange} />
    case 'date':
      return (
        <input
          type="date"
          value={typeof value === 'string' ? value.slice(0, 10) : ''}
          onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
          className="cyber-input"
          style={COMPACT}
        />
      )
    case 'checkbox':
      return (
        <input
          type="checkbox"
          checked={value === true}
          onChange={(e) => onChange(e.target.checked)}
          className="h-4 w-4"
          style={{ accentColor: 'var(--acid)' }}
        />
      )
    case 'single_select':
      return (
        <select
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
          className="cyber-input"
          style={COMPACT}
        >
          <option value="">—</option>
          {activeChoices(def).map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
      )
    case 'multi_select': {
      const selected = multiValue(value)
      return (
        <div className="flex flex-wrap gap-1">
          {activeChoices(def).map((c) => {
            const on = selected.includes(c.id)
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => {
                  const next = toggleSelection(selected, c.id)
                  onChange(next.length === 0 ? null : next)
                }}
                className="rounded-full border px-2 py-0.5 text-xs"
                style={{
                  borderColor: on ? 'var(--acid)' : 'var(--line)',
                  color: on ? 'var(--acid)' : 'var(--ink-dim)',
                }}
              >
                {c.label}
              </button>
            )
          })}
        </div>
      )
    }
    case 'person':
      return (
        <select
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
          className="cyber-input"
          style={COMPACT}
        >
          <option value="">Unassigned</option>
          {typeof value === 'string' && value && !members.some((m) => m.user_id === value) && (
            <option value={value}>{value}</option>
          )}
          {members.map((m) => (
            <option key={m.id} value={m.user_id}>
              {m.user_id}
            </option>
          ))}
        </select>
      )
  }
}

// Text/url control with local state committed on blur (mirrors the title
// input in ItemRow), so the parent only PATCHes on commit, not keystroke.
function TextControl({
  value,
  multiline,
  type,
  onChange,
}: {
  value: unknown
  multiline: boolean
  type?: string
  onChange: (value: unknown | null) => void
}) {
  const initial = typeof value === 'string' ? value : ''
  const [draft, setDraft] = useState(initial)
  useEffect(() => {
    setDraft(initial)
  }, [initial])

  function commit() {
    const next = draft.trim()
    if (next === initial) return
    onChange(next === '' ? null : next)
  }

  if (multiline) {
    return (
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        rows={2}
        className="cyber-input"
        style={{ minWidth: 180, padding: '4px 8px' }}
      />
    )
  }
  return (
    <input
      type={type ?? 'text'}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
      }}
      className="cyber-input"
      style={COMPACT}
    />
  )
}

// Number control with local state committed on blur. Empty clears (null);
// a non-numeric draft is ignored on commit (reverts to the last value).
function NumberControl({ value, onChange }: { value: unknown; onChange: (value: unknown | null) => void }) {
  const initial = typeof value === 'number' ? String(value) : ''
  const [draft, setDraft] = useState(initial)
  useEffect(() => {
    setDraft(initial)
  }, [initial])

  function commit() {
    if (draft.trim() === '') {
      if (initial !== '') onChange(null)
      return
    }
    const n = Number(draft)
    if (Number.isFinite(n)) {
      if (String(n) !== initial) onChange(n)
    } else {
      setDraft(initial)
    }
  }

  return (
    <input
      type="number"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
      }}
      className="cyber-input"
      style={COMPACT}
    />
  )
}

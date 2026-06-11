import { useEffect, useState } from 'react'
import type { FieldDefDto, SelectChoice } from '../lib/api.js'

// Per-task custom-field value editor (slice 13). Renders one inline control
// per field def for a single task and reports edits via onChange (fieldId →
// wire value, or null to clear the key). The value encoding matches the
// server's validateCustomFields: text→string, number→number, date→yyyy-mm-dd,
// checkbox→bool, single→choice id, multi→choice ids, person→user id,
// url→string. Planner lists are personal scope (no member roster), so the
// person type is a free-text user id rather than a member dropdown.

interface CustomFieldsEditorProps {
  defs: FieldDefDto[]
  values: Record<string, unknown>
  onChange: (fieldId: string, value: unknown | null) => void
}

const controlStyle: React.CSSProperties = {
  padding: '4px 8px',
  fontSize: 13,
  background: 'var(--bg)',
  color: 'var(--ink)',
  border: '1.5px solid var(--line)',
}

// The choices a user should see: archived choices stay stored (so historical
// values still resolve a label) but are hidden from the picker.
function activeChoices(def: FieldDefDto): SelectChoice[] {
  return (def.options.choices ?? []).filter((c) => !c.archived)
}

function multiValue(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : []
}

function toggleSelection(current: readonly string[], id: string): string[] {
  return current.includes(id) ? current.filter((v) => v !== id) : [...current, id]
}

export function CustomFieldsEditor({ defs, values, onChange }: CustomFieldsEditorProps) {
  if (defs.length === 0) return null
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', gap: 12 }}>
      {defs.map((def) => (
        <label
          key={def.id}
          style={{ display: 'grid', gap: 2, fontSize: 11, color: 'var(--ink-dim)' }}
        >
          <span>
            {def.label}
            {def.required && <span style={{ color: 'var(--danger, #c0392b)' }}> *</span>}
          </span>
          <CustomFieldControl def={def} value={values[def.id]} onChange={(v) => onChange(def.id, v)} />
        </label>
      ))}
    </div>
  )
}

interface ControlProps {
  def: FieldDefDto
  value: unknown
  onChange: (value: unknown | null) => void
}

export function CustomFieldControl({ def, value, onChange }: ControlProps) {
  switch (def.fieldType) {
    case 'text':
      return (
        <TextControl
          ariaLabel={`${def.label} value`}
          value={value}
          multiline={def.options.multiline === true}
          onChange={onChange}
        />
      )
    case 'url':
      return (
        <TextControl ariaLabel={`${def.label} value`} value={value} multiline={false} type="url" onChange={onChange} />
      )
    case 'person':
      return <TextControl ariaLabel={`${def.label} value`} value={value} multiline={false} onChange={onChange} />
    case 'number':
      return <NumberControl ariaLabel={`${def.label} value`} value={value} onChange={onChange} />
    case 'date':
      return (
        <input
          type="date"
          aria-label={`${def.label} value`}
          value={typeof value === 'string' ? value.slice(0, 10) : ''}
          onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
          style={controlStyle}
        />
      )
    case 'checkbox':
      return (
        <input
          type="checkbox"
          aria-label={`${def.label} value`}
          checked={value === true}
          onChange={(e) => onChange(e.target.checked)}
        />
      )
    case 'single_select':
      return (
        <select
          aria-label={`${def.label} value`}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
          style={controlStyle}
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
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {activeChoices(def).map((c) => {
            const on = selected.includes(c.id)
            return (
              <button
                key={c.id}
                type="button"
                aria-pressed={on}
                onClick={() => {
                  const next = toggleSelection(selected, c.id)
                  onChange(next.length === 0 ? null : next)
                }}
                style={{
                  padding: '2px 8px',
                  fontSize: 12,
                  cursor: 'pointer',
                  borderRadius: 999,
                  background: on ? 'var(--accent-soft)' : 'transparent',
                  color: on ? 'var(--ink)' : 'var(--ink-dim)',
                  border: '1.5px solid var(--line)',
                }}
              >
                {c.label}
              </button>
            )
          })}
        </div>
      )
    }
  }
}

// Text/url/person control with local state committed on blur, so the parent
// only PATCHes on commit, not per keystroke.
function TextControl({
  ariaLabel,
  value,
  multiline,
  type,
  onChange,
}: {
  ariaLabel: string
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
        aria-label={ariaLabel}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        rows={2}
        style={{ ...controlStyle, minWidth: 180 }}
      />
    )
  }
  return (
    <input
      type={type ?? 'text'}
      aria-label={ariaLabel}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
      }}
      style={controlStyle}
    />
  )
}

// Number control with local state committed on blur. Empty clears (null); a
// non-numeric draft reverts to the last value on commit.
function NumberControl({
  ariaLabel,
  value,
  onChange,
}: {
  ariaLabel: string
  value: unknown
  onChange: (value: unknown | null) => void
}) {
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
      aria-label={ariaLabel}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
      }}
      style={controlStyle}
    />
  )
}

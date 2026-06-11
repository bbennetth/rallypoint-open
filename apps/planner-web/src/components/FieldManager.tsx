import { useState } from 'react'
import {
  ApiError,
  createFieldDef,
  deleteFieldDef,
  updateFieldDef,
  type FieldDefDto,
  type FieldType,
} from '../lib/api.js'

// Field-def manager for the active task list (slice 13). Lets the user
// create, rename, retype-guard (fieldType is immutable), toggle required,
// edit select choices, and remove custom fields. All persistence goes
// through the planner-api BFF → Lists SDK; this component owns only the
// add-form draft and surfaces errors. The parent owns the def list and
// passes onChanged() to refetch after a mutation.

const FIELD_TYPE_LABELS: Record<FieldType, string> = {
  text: 'Text',
  number: 'Number',
  date: 'Date',
  checkbox: 'Checkbox',
  single_select: 'Single select',
  multi_select: 'Multi-select',
  person: 'Person',
  url: 'URL',
}

const SELECT_TYPES = new Set<FieldType>(['single_select', 'multi_select'])

const fieldStyle: React.CSSProperties = {
  padding: '6px 10px',
  fontSize: 14,
  background: 'var(--bg)',
  color: 'var(--ink)',
  border: '1.5px solid var(--line)',
}

function errMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message
  return 'Something went wrong. Please try again.'
}

interface FieldManagerProps {
  listId: string
  defs: FieldDefDto[]
  onChanged: () => void | Promise<void>
}

export function FieldManager({ listId, defs, onChanged }: FieldManagerProps) {
  const [label, setLabel] = useState('')
  const [fieldType, setFieldType] = useState<FieldType>('text')
  const [required, setRequired] = useState(false)
  const [multiline, setMultiline] = useState(false)
  const [choicesText, setChoicesText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const isSelect = SELECT_TYPES.has(fieldType)

  function resetForm() {
    setLabel('')
    setFieldType('text')
    setRequired(false)
    setMultiline(false)
    setChoicesText('')
  }

  async function onCreate(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = label.trim()
    if (!trimmed || busy) return
    setError(null)
    const input = {
      label: trimmed,
      fieldType,
      required,
      ...(fieldType === 'text' ? { multiline } : {}),
      ...(isSelect
        ? {
            choices: choicesText
              .split(',')
              .map((c) => c.trim())
              .filter(Boolean)
              .map((c) => ({ label: c })),
          }
        : {}),
    }
    setBusy(true)
    try {
      await createFieldDef(listId, input)
      resetForm()
      await onChanged()
    } catch (err) {
      setError(errMessage(err))
    } finally {
      setBusy(false)
    }
  }

  async function onRename(def: FieldDefDto, nextLabel: string) {
    const next = nextLabel.trim()
    if (!next || next === def.label) return
    setError(null)
    try {
      await updateFieldDef(listId, def.id, { label: next })
      await onChanged()
    } catch (err) {
      setError(errMessage(err))
    }
  }

  async function onToggleRequired(def: FieldDefDto) {
    setError(null)
    try {
      await updateFieldDef(listId, def.id, { required: !def.required })
      await onChanged()
    } catch (err) {
      setError(errMessage(err))
    }
  }

  async function onDelete(def: FieldDefDto) {
    setError(null)
    try {
      await deleteFieldDef(listId, def.id)
      await onChanged()
    } catch (err) {
      setError(errMessage(err))
    }
  }

  return (
    <section
      style={{
        display: 'grid',
        gap: 10,
        padding: 12,
        border: '1.5px solid var(--line)',
        background: 'var(--bg-soft, transparent)',
      }}
    >
      <h2 style={{ fontSize: 14, margin: 0, color: 'var(--ink)' }}>Custom fields</h2>

      {error && (
        <div role="alert" style={{ color: 'var(--danger, #c0392b)', fontSize: 13 }}>
          {error}
        </div>
      )}

      {defs.length > 0 && (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 6 }}>
          {defs.map((def) => (
            <li
              key={def.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                flexWrap: 'wrap',
                padding: '6px 10px',
                border: '1.5px solid var(--line)',
              }}
            >
              <input
                aria-label={`Field label for ${def.label}`}
                defaultValue={def.label}
                onBlur={(e) => void onRename(def, e.target.value)}
                style={{ ...fieldStyle, flex: 1, minWidth: 120 }}
              />
              <span
                style={{
                  fontSize: 11,
                  textTransform: 'uppercase',
                  letterSpacing: 0.5,
                  color: 'var(--ink-dim)',
                }}
              >
                {FIELD_TYPE_LABELS[def.fieldType]}
              </span>
              <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--ink-dim)' }}>
                <input
                  type="checkbox"
                  checked={def.required}
                  onChange={() => void onToggleRequired(def)}
                  aria-label={`Require ${def.label}`}
                />
                Required
              </label>
              <button
                type="button"
                onClick={() => void onDelete(def)}
                aria-label={`Remove field ${def.label}`}
                style={{
                  fontSize: 13,
                  color: 'var(--ink-dim)',
                  background: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                }}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={onCreate} style={{ display: 'grid', gap: 8 }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <input
            aria-label="New field label"
            placeholder="Field name…"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            style={{ ...fieldStyle, flex: 1, minWidth: 120 }}
          />
          <select
            aria-label="Field type"
            value={fieldType}
            onChange={(e) => setFieldType(e.target.value as FieldType)}
            style={fieldStyle}
          >
            {(Object.keys(FIELD_TYPE_LABELS) as FieldType[]).map((t) => (
              <option key={t} value={t}>
                {FIELD_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
          <button type="submit" className="btn-brutal" style={{ width: 'auto' }} disabled={busy}>
            Add field
          </button>
        </div>

        {isSelect && (
          <input
            aria-label="Choices (comma-separated)"
            placeholder="Choices, comma-separated…"
            value={choicesText}
            onChange={(e) => setChoicesText(e.target.value)}
            style={fieldStyle}
          />
        )}

        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 13, color: 'var(--ink-dim)' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input
              type="checkbox"
              checked={required}
              onChange={(e) => setRequired(e.target.checked)}
              aria-label="Required field"
            />
            Required
          </label>
          {fieldType === 'text' && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input
                type="checkbox"
                checked={multiline}
                onChange={(e) => setMultiline(e.target.checked)}
                aria-label="Multiline text"
              />
              Multiline
            </label>
          )}
        </div>
      </form>
    </section>
  )
}

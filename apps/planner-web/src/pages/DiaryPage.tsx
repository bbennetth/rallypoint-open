import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ApiError,
  deleteDiaryEntry,
  getDiaryList,
  listDiaryEntries,
  listFieldDefs,
  updateDiaryEntry,
  type DiaryEntryDto,
  type DiaryListDto,
  type FieldDefDto,
} from '../lib/api.js'
import {
  choiceLabel,
  dataPointFields,
  findMoodField,
  formatEntryDate,
  formatFieldValue,
  sortDiaryEntries,
  ymdFromDueDate,
} from '../lib/diary-helpers.js'
import { FieldManager } from '../components/FieldManager.js'
import { MoodPicker } from '../ui/MoodPicker.js'
import { SkeletonRows } from '../ui/Skeleton.js'
import { onCreated } from '../lib/refresh-bus.js'
import { Drawer } from '@rallypoint/ui'
import { Icon } from '../ui/icons.js'

// Diary surface (Phase B, capture-only). A single system-managed `diary` Lists
// list per user; entries are generic list items (notes = body, dueDate = the
// day, customFields = mood + metrics). All persistence goes through the Lists
// SDK via the planner-api BFF — the only diary-specific endpoint is the
// list provisioner; entry + field CRUD reuse the generic list routes.

function errMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message
  return 'Something went wrong. Please try again.'
}

function todayYmd(): string {
  return new Date().toLocaleDateString('en-CA') // YYYY-MM-DD in local time
}

// A by-type value input for a custom data-point field. The value is the raw
// stored shape (choice id for selects, string/number/bool otherwise).
function FieldValueInput({
  def,
  value,
  onChange,
  disabled,
}: {
  def: FieldDefDto
  value: unknown
  onChange: (value: unknown) => void
  disabled?: boolean
}) {
  if (def.fieldType === 'single_select' || def.fieldType === 'multi_select') {
    const choices = (def.options.choices ?? []).filter((c) => !c.archived)
    return (
      <select
        className="pl-input"
        disabled={disabled}
        value={typeof value === 'string' ? value : ''}
        onChange={(e) => onChange(e.target.value || null)}
        aria-label={def.label}
      >
        <option value="">—</option>
        {choices.map((c) => (
          <option key={c.id} value={c.id}>
            {c.label}
          </option>
        ))}
      </select>
    )
  }
  if (def.fieldType === 'number') {
    return (
      <input
        className="pl-input"
        type="number"
        disabled={disabled}
        value={value == null ? '' : String(value)}
        onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
        aria-label={def.label}
      />
    )
  }
  if (def.fieldType === 'checkbox') {
    return (
      <input
        type="checkbox"
        disabled={disabled}
        checked={value === true}
        onChange={(e) => onChange(e.target.checked)}
        aria-label={def.label}
        style={{ width: 18, height: 18 }}
      />
    )
  }
  if (def.fieldType === 'date') {
    return (
      <input
        className="pl-input"
        type="date"
        disabled={disabled}
        value={typeof value === 'string' ? value.slice(0, 10) : ''}
        onChange={(e) => onChange(e.target.value || null)}
        aria-label={def.label}
      />
    )
  }
  return (
    <input
      className="pl-input"
      type={def.fieldType === 'url' ? 'url' : 'text'}
      disabled={disabled}
      value={typeof value === 'string' ? value : ''}
      onChange={(e) => onChange(e.target.value || null)}
      aria-label={def.label}
    />
  )
}

// Edit/delete form for one entry, rendered in a Drawer. Keyed by entry id by
// the parent so its draft resets when a different entry is opened.
function EntryEditor({
  listId,
  entry,
  defs,
  onSaved,
  onClose,
}: {
  listId: string
  entry: DiaryEntryDto
  defs: FieldDefDto[]
  onSaved: () => void
  onClose: () => void
}) {
  const moodField = useMemo(() => findMoodField(defs), [defs])
  const points = useMemo(() => dataPointFields(defs), [defs])
  const [date, setDate] = useState(ymdFromDueDate(entry.dueDate) || todayYmd())
  const [body, setBody] = useState(entry.notes ?? '')
  const [fields, setFields] = useState<Record<string, unknown>>(entry.customFields)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const mood = moodField ? ((fields[moodField.id] as string | undefined) ?? null) : null

  function setFieldValue(id: string, value: unknown) {
    setFields((prev) => ({ ...prev, [id]: value }))
  }

  async function save() {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await updateDiaryEntry(listId, entry.id, {
        title: formatEntryDate(date),
        notes: body.trim() ? body.trim() : null,
        dueDate: date,
        customFields: fields,
      })
      onSaved()
      onClose()
    } catch (err) {
      setError(errMessage(err))
      setBusy(false)
    }
  }

  async function remove() {
    if (busy) return
    if (!window.confirm('Delete this diary entry? This cannot be undone.')) return
    setBusy(true)
    setError(null)
    try {
      await deleteDiaryEntry(listId, entry.id)
      onSaved()
      onClose()
    } catch (err) {
      setError(errMessage(err))
      setBusy(false)
    }
  }

  return (
    <form
      className="pl-fab-form"
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
    >
      <label className="pl-fab-label">
        Date
        <input
          className="pl-input"
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          aria-label="Entry date"
          disabled={busy}
        />
      </label>

      {moodField && (
        <div className="pl-fab-label">
          {moodField.label}
          <MoodPicker
            field={moodField}
            value={mood}
            onChange={(id) => setFieldValue(moodField.id, id)}
            disabled={busy}
          />
        </div>
      )}

      <label className="pl-fab-label">
        Entry
        <textarea
          className="pl-input"
          rows={6}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          aria-label="Entry body"
          disabled={busy}
          style={{ resize: 'vertical' }}
        />
      </label>

      {points.map((def) => (
        <label className="pl-fab-label" key={def.id}>
          {def.label}
          <FieldValueInput
            def={def}
            value={fields[def.id]}
            onChange={(v) => setFieldValue(def.id, v)}
            disabled={busy}
          />
        </label>
      ))}

      {error && (
        <p role="alert" className="pl-fab-error">
          {error}
        </p>
      )}

      <button className="pl-btn" type="submit" disabled={busy}>
        Save entry
      </button>
      <button className="pl-btn ghost" type="button" onClick={() => void remove()} disabled={busy}>
        Delete entry
      </button>
    </form>
  )
}

export function DiaryPage() {
  const [list, setList] = useState<DiaryListDto | null>(null)
  const [entries, setEntries] = useState<DiaryEntryDto[]>([])
  const [defs, setDefs] = useState<FieldDefDto[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [editing, setEditing] = useState<DiaryEntryDto | null>(null)
  const [fieldsOpen, setFieldsOpen] = useState(false)

  const moodField = useMemo(() => findMoodField(defs), [defs])
  const points = useMemo(() => dataPointFields(defs), [defs])
  const sorted = useMemo(() => sortDiaryEntries(entries), [entries])

  const refreshEntries = useCallback(async (listId: string) => {
    try {
      setEntries(await listDiaryEntries(listId))
    } catch (err) {
      setError(errMessage(err))
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
    let cancelled = false
    setLoading(true)
    void getDiaryList()
      .then(async (l) => {
        if (cancelled) return
        setList(l)
        await Promise.all([refreshEntries(l.id), refreshDefs(l.id)])
      })
      .catch((err) => {
        if (!cancelled) setError(errMessage(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [refreshEntries, refreshDefs])

  // A diary entry added from the global quick-add FAB refreshes the list.
  useEffect(
    () =>
      onCreated('diary', () => {
        if (list) void refreshEntries(list.id)
      }),
    [list, refreshEntries],
  )

  return (
    <>
      <div className="pg-head">
        <div>
          <h1>Diary</h1>
        </div>
        <button
          type="button"
          className="pl-iconbtn"
          aria-label="Manage data points"
          title="Manage data points"
          onClick={() => setFieldsOpen(true)}
        >
          <Icon name="gear" size={15} />
        </button>
      </div>

      {error && (
        <p role="alert" style={{ color: 'var(--hot)', fontSize: 13, marginTop: 0 }}>
          {error}
        </p>
      )}

      {loading ? (
        <SkeletonRows count={4} height={72} label="Loading diary" />
      ) : list == null ? (
        <p className="meta" style={{ color: 'var(--ink-mute)' }}>
          Couldn’t load your diary. Please refresh.
        </p>
      ) : (
        <div style={{ display: 'grid', gap: 16, minWidth: 0 }}>
          {sorted.length === 0 ? (
            <p className="meta" style={{ color: 'var(--ink-mute)' }}>
              No entries yet — use the + button to add one.
            </p>
          ) : (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 10 }}>
              {sorted.map((entry) => {
                const moodLabel = choiceLabel(
                  moodField,
                  moodField ? entry.customFields[moodField.id] : null,
                )
                const chips = points
                  .map((def) => {
                    const value = formatFieldValue(def, entry.customFields[def.id])
                    return value ? { key: def.id, name: def.label, value } : null
                  })
                  .filter((x): x is { key: string; name: string; value: string } => x !== null)
                return (
                  <li
                    key={entry.id}
                    className="pl-card"
                    style={{ padding: 14, display: 'grid', gap: 8 }}
                  >
                    <div
                      style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}
                    >
                      <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--ink)' }}>
                        {formatEntryDate(ymdFromDueDate(entry.dueDate))}
                      </span>
                      {moodLabel && <span className="pl-chip accent">{moodLabel}</span>}
                      <span style={{ flex: 1 }} />
                      <button
                        type="button"
                        className="pl-iconbtn"
                        onClick={() => setEditing(entry)}
                        aria-label="Edit entry"
                        title="Edit"
                      >
                        <Icon name="pencil" size={13} />
                      </button>
                    </div>
                    {entry.notes && (
                      <p
                        style={{
                          margin: 0,
                          fontSize: 13.5,
                          color: 'var(--ink-dim)',
                          whiteSpace: 'pre-wrap',
                        }}
                      >
                        {entry.notes}
                      </p>
                    )}
                    {chips.length > 0 && (
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {chips.map((c) => (
                          <span key={c.key} className="pl-chip">
                            <b
                              style={{ color: 'var(--ink-mute)', fontWeight: 700, marginRight: 4 }}
                            >
                              {c.name}
                            </b>
                            {c.value}
                          </span>
                        ))}
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}

      <Drawer
        open={editing !== null}
        onClose={() => setEditing(null)}
        title="Diary entry"
        mobileSheet
      >
        {editing && list && (
          <EntryEditor
            key={editing.id}
            listId={list.id}
            entry={editing}
            defs={defs}
            onSaved={() => {
              if (list) void refreshEntries(list.id)
            }}
            onClose={() => setEditing(null)}
          />
        )}
      </Drawer>

      <Drawer
        open={fieldsOpen}
        onClose={() => setFieldsOpen(false)}
        title="Data points"
        width={420}
        mobileSheet
      >
        {list && (
          <FieldManager listId={list.id} defs={defs} onChanged={() => refreshDefs(list.id)} />
        )}
      </Drawer>
    </>
  )
}

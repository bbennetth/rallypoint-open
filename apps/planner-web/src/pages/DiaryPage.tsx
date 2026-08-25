import { useEffect, useMemo, useState } from 'react'
import {
  ApiError,
  deleteDiaryEntry,
  diaryEntriesQuery,
  diaryListQuery,
  fieldDefsQuery,
  updateDiaryEntry,
  type DiaryEntryDto,
  type FieldDefDto,
} from '../lib/api.js'
import { useCachedQuery } from '../lib/offline/use-cached-query.js'
import {
  choiceLabel,
  dataPointFields,
  entryTimeLabel,
  findMoodField,
  formatEntryDate,
  formatFieldValue,
  isDayOnlyDueDate,
  sortDiaryEntries,
  ymdFromDueDate,
} from '../lib/diary-helpers.js'
import { combineDueDateTime, instantToTimeInput } from '../lib/planner-helpers.js'
import { FieldManager } from '../components/FieldManager.js'
import { MoodPicker } from '../ui/MoodPicker.js'
import { SkeletonRows } from '../ui/Skeleton.js'
import { onCreated } from '../lib/refresh-bus.js'
import { Drawer } from '@rallypoint/ui'
import { Icon } from '../ui/icons.js'
import { QuickAdd } from '../ui/QuickAdd.js'

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
  // Prefills from the stored instant for timed entries; day-only entries
  // leave it blank (clearing it turns a timed entry back into day-only).
  const [time, setTime] = useState(
    isDayOnlyDueDate(entry.dueDate) ? '' : instantToTimeInput(entry.dueDate),
  )
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
        // Timed entries store a true local instant; an empty time keeps the
        // legacy day-only shape (raw date string → midnight-UTC).
        dueDate: date && time ? combineDueDateTime(date, time) : date,
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
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            className="pl-input"
            type="date"
            value={date}
            onChange={(e) => {
              setDate(e.target.value)
              // A time with no date is meaningless — clear it with the date.
              if (!e.target.value) setTime('')
            }}
            aria-label="Entry date"
            disabled={busy}
          />
          <input
            className="pl-input"
            type="time"
            value={time}
            onChange={(e) => setTime(e.target.value)}
            aria-label="Entry time"
            disabled={busy || !date}
          />
        </div>
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
  // Render-from-cache: all three reads paint the last-known value instantly
  // (skeletons only on a true cold cache miss) and re-render on every cache
  // write. Entry/field-def mutations are request-response (not local-first),
  // so they still explicitly refetch below.
  const listQ = useCachedQuery(useMemo(() => diaryListQuery(), []))
  const list = listQ.data ?? null
  const listId = list?.id ?? null
  const entriesQ = useCachedQuery(useMemo(() => (listId ? diaryEntriesQuery(listId) : null), [listId]))
  const defsQ = useCachedQuery(useMemo(() => (listId ? fieldDefsQuery(listId) : null), [listId]))
  const entries = useMemo(() => entriesQ.data ?? [], [entriesQ.data])
  const defs = useMemo(() => defsQ.data ?? [], [defsQ.data])
  const [error, setError] = useState<string | null>(null)

  const [editing, setEditing] = useState<DiaryEntryDto | null>(null)
  const [fieldsOpen, setFieldsOpen] = useState(false)

  const moodField = useMemo(() => findMoodField(defs), [defs])
  const points = useMemo(() => dataPointFields(defs), [defs])
  const sorted = useMemo(() => sortDiaryEntries(entries), [entries])

  const loading = listQ.status === 'loading'

  useEffect(() => {
    if (listQ.status === 'error') setError(errMessage(listQ.error))
    else if (entriesQ.status === 'error') setError(errMessage(entriesQ.error))
    else if (defsQ.status === 'error') setError(errMessage(defsQ.error))
  }, [listQ.status, listQ.error, entriesQ.status, entriesQ.error, defsQ.status, defsQ.error])

  // A diary entry added from the global quick-add FAB refreshes the list.
  const refetchEntries = entriesQ.refetch
  const refetchDefs = defsQ.refetch
  useEffect(() => onCreated('diary', () => void refetchEntries()), [refetchEntries])

  return (
    <>
      <div className="pg-head pl-wide">
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
            <ul className="diary-grid">
              {sorted.map((entry) => {
                const moodLabel = choiceLabel(
                  moodField,
                  moodField ? entry.customFields[moodField.id] : null,
                )
                // The Ink kit's `.pl-mood` is a 26px accent-soft circle
                // showing a single emoji glyph. Planner-web's seeded mood
                // choices carry a leading emoji + space + text (e.g.
                // "😄 Great"), so slicing the first character gives the
                // emoji for free. For custom field labels without a
                // leading emoji, the CSS's `text-transform: uppercase`
                // capitalizes the letter so plain-text fields still
                // degrade gracefully. The full label still shows in the
                // trailing chip on the right.
                const moodGlyph = moodLabel ? moodLabel.slice(0, 1) : null
                const chips = points
                  .map((def) => {
                    const value = formatFieldValue(def, entry.customFields[def.id])
                    return value ? { key: def.id, name: def.label, value } : null
                  })
                  .filter((x): x is { key: string; name: string; value: string } => x !== null)
                return (
                  <li key={entry.id} className="pl-diary">
                    <div className="pl-diary-hd">
                      {moodGlyph && (
                        <span className="pl-mood" aria-hidden>
                          {moodGlyph}
                        </span>
                      )}
                      <span className="pl-diary-date">
                        {formatEntryDate(ymdFromDueDate(entry.dueDate))}
                      </span>
                      {entryTimeLabel(entry.dueDate) && (
                        <span className="meta" style={{ color: 'var(--ink-mute)', fontSize: 12 }}>
                          {entryTimeLabel(entry.dueDate)}
                        </span>
                      )}
                      {/* Stable trailing slot: one container owns marginLeft:auto,
                          so the pencil's anchor doesn't hop between elements
                          depending on whether a mood chip renders. */}
                      <span
                        style={{
                          marginLeft: 'auto',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                        }}
                      >
                        {moodLabel && <span className="pl-chip accent">{moodLabel}</span>}
                        <button
                          type="button"
                          className="pl-iconbtn"
                          onClick={() => setEditing(entry)}
                          aria-label="Edit entry"
                          title="Edit"
                        >
                          <Icon name="pencil" size={13} />
                        </button>
                      </span>
                    </div>
                    {entry.notes && (
                      <p className="pl-diary-body">{entry.notes}</p>
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
            onSaved={() => void refetchEntries()}
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
          <FieldManager listId={list.id} defs={defs} onChanged={() => void refetchDefs()} />
        )}
      </Drawer>
      <QuickAdd anchor="float" />
    </>
  )
}

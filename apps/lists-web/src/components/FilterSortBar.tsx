import { useEffect, useRef, useState } from 'react'
import {
  opsForKind,
  type FilterKind,
  type FilterOp,
  type FilterSpec,
  type SortSpec,
} from '@rallypoint/lists-shared'

// Filter & sort bar for the standard list view (Lists v2 slice 4). Builds
// the same FilterSpec/SortSpec shapes the API parses; the page encodes
// them into repeatable `filter`/`sort` query params via listItems(). The
// bar only ever emits specs validateListQuery would keep (op restricted
// to the field's kind), so a stale spec can't reach the wire from here.

export interface FilterableField {
  field: string
  label: string
  kind: FilterKind
  // Present for select/multi kinds backed by a custom field, so the value
  // picker offers the choice labels instead of raw option ids.
  choices?: { id: string; label: string }[]
}

const OP_LABEL: Record<FilterOp, string> = {
  eq: 'is',
  neq: 'is not',
  contains: 'contains',
  gt: '>',
  gte: '≥',
  lt: '<',
  lte: '≤',
  is_empty: 'is empty',
  has_any: 'has',
}

export interface FilterSortValue {
  filters: FilterSpec[]
  sort: SortSpec[]
}

interface FilterSortBarProps {
  fields: FilterableField[]
  value: FilterSortValue
  onChange: (next: FilterSortValue) => void
}

export function FilterSortBar({ fields, value, onChange }: FilterSortBarProps) {
  // Stable per-row ids so editing or removing a filter doesn't reconcile
  // the remaining rows by array index and misfocus a text input (#242).
  // Managed in lockstep with add/remove (removeFilter drops the same index
  // from both arrays, preserving every other row's id). The reconcile below
  // only fires on a length change, so a parent that swaps filters
  // out-of-band for a DIFFERENT count (e.g. loading a saved view) gets fresh
  // ids; a same-count swap intentionally keeps the existing ids (positional
  // rows, no remount, no focus loss). Hooks run before the early return to
  // respect hook order.
  const rowSeq = useRef(0)
  const [rowIds, setRowIds] = useState<number[]>(() => value.filters.map(() => rowSeq.current++))
  useEffect(() => {
    setRowIds((ids) =>
      ids.length === value.filters.length ? ids : value.filters.map(() => rowSeq.current++),
    )
  }, [value.filters.length])

  if (fields.length === 0) return null
  const byField = new Map(fields.map((f) => [f.field, f]))

  function addFilter() {
    const first = fields[0]!
    const op = opsForKind(first.kind)[0]!
    const spec: FilterSpec = { field: first.field, op }
    if (op !== 'is_empty') spec.value = ''
    setRowIds((ids) => [...ids, rowSeq.current++])
    onChange({ ...value, filters: [...value.filters, spec] })
  }

  function updateFilter(index: number, spec: FilterSpec) {
    const next = value.filters.slice()
    next[index] = spec
    onChange({ ...value, filters: next })
  }

  function removeFilter(index: number) {
    setRowIds((ids) => ids.filter((_, i) => i !== index))
    onChange({ ...value, filters: value.filters.filter((_, i) => i !== index) })
  }

  // Field change resets op to the new kind's first op and clears the value
  // (a number value makes no sense once the field is a select, etc.).
  function changeField(index: number, field: string) {
    const meta = byField.get(field)!
    const op = opsForKind(meta.kind)[0]!
    const spec: FilterSpec = { field, op }
    if (op !== 'is_empty') spec.value = defaultValueFor(meta)
    updateFilter(index, spec)
  }

  function changeOp(index: number, op: FilterOp) {
    const cur = value.filters[index]!
    const meta = byField.get(cur.field)!
    const spec: FilterSpec = { field: cur.field, op }
    if (op !== 'is_empty') spec.value = cur.value ?? defaultValueFor(meta)
    updateFilter(index, spec)
  }

  function changeSort(field: string) {
    if (field === '') {
      onChange({ ...value, sort: [] })
      return
    }
    const dir = value.sort[0]?.dir ?? 'asc'
    onChange({ ...value, sort: [{ field, dir }] })
  }

  function toggleDir() {
    const cur = value.sort[0]
    if (!cur) return
    onChange({ ...value, sort: [{ field: cur.field, dir: cur.dir === 'asc' ? 'desc' : 'asc' }] })
  }

  // Multi-select can't be sorted (no total order) — drop it from the sort
  // field options.
  const sortFields = fields.filter((f) => f.kind !== 'multi')
  const sortField = value.sort[0]?.field ?? ''

  return (
    <div
      className="flex flex-col gap-2 p-3"
      style={{ border: '1.5px solid var(--line)', background: 'var(--surface)' }}
    >
      {value.filters.map((f, i) => {
        const meta = byField.get(f.field) ?? fields[0]!
        return (
          <div key={rowIds[i] ?? i} className="flex flex-wrap items-center gap-2">
            <select
              value={f.field}
              onChange={(e) => changeField(i, e.target.value)}
              className="cyber-input"
              style={{ width: 'auto' }}
              aria-label="Filter field"
            >
              {fields.map((opt) => (
                <option key={opt.field} value={opt.field}>
                  {opt.label}
                </option>
              ))}
            </select>
            <select
              value={f.op}
              onChange={(e) => changeOp(i, e.target.value as FilterOp)}
              className="cyber-input"
              style={{ width: 'auto' }}
              aria-label="Filter operator"
            >
              {opsForKind(meta.kind).map((op) => (
                <option key={op} value={op}>
                  {OP_LABEL[op]}
                </option>
              ))}
            </select>
            {f.op !== 'is_empty' && (
              <ValueInput
                meta={meta}
                value={f.value ?? ''}
                onChange={(v) => updateFilter(i, { field: f.field, op: f.op, value: v })}
              />
            )}
            <button
              type="button"
              onClick={() => removeFilter(i)}
              className="text-sm underline"
              style={{ color: 'var(--ink-dim)' }}
              aria-label="Remove filter"
            >
              ✕
            </button>
          </div>
        )
      })}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={addFilter}
          className="text-sm underline"
          style={{ color: 'var(--ink-dim)' }}
        >
          + Add filter
        </button>
        <span className="ml-auto flex items-center gap-2 text-sm" style={{ color: 'var(--ink-dim)' }}>
          Sort
          <select
            value={sortField}
            onChange={(e) => changeSort(e.target.value)}
            className="cyber-input"
            style={{ width: 'auto' }}
            aria-label="Sort field"
          >
            <option value="">None</option>
            {sortFields.map((opt) => (
              <option key={opt.field} value={opt.field}>
                {opt.label}
              </option>
            ))}
          </select>
          {sortField !== '' && (
            <button
              type="button"
              onClick={toggleDir}
              className="btn-ghost"
              style={{ width: 'auto' }}
              aria-label="Toggle sort direction"
            >
              {value.sort[0]?.dir === 'desc' ? 'Desc ↓' : 'Asc ↑'}
            </button>
          )}
        </span>
      </div>
    </div>
  )
}

function defaultValueFor(meta: FilterableField): string {
  if (meta.kind === 'bool') return 'true'
  if ((meta.kind === 'select' || meta.kind === 'multi') && meta.choices?.length)
    return meta.choices[0]!.id
  return ''
}

function ValueInput({
  meta,
  value,
  onChange,
}: {
  meta: FilterableField
  value: string
  onChange: (v: string) => void
}) {
  if (meta.kind === 'bool') {
    return (
      <select
        value={value || 'true'}
        onChange={(e) => onChange(e.target.value)}
        className="cyber-input"
        style={{ width: 'auto' }}
        aria-label="Filter value"
      >
        <option value="true">Yes</option>
        <option value="false">No</option>
      </select>
    )
  }
  // Custom select/multi with known choices → pick a label, store its id.
  if ((meta.kind === 'select' || meta.kind === 'multi') && meta.choices?.length) {
    return (
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="cyber-input"
        style={{ width: 'auto' }}
        aria-label="Filter value"
      >
        {meta.choices.map((c) => (
          <option key={c.id} value={c.id}>
            {c.label}
          </option>
        ))}
      </select>
    )
  }
  const type = meta.kind === 'number' ? 'number' : meta.kind === 'date' ? 'date' : 'text'
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder="value"
      className="cyber-input"
      style={{ width: 'auto' }}
      aria-label="Filter value"
    />
  )
}

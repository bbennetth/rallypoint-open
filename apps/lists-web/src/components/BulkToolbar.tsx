import { useState } from 'react'
import { bulkItems, type BulkItemPatch, type FieldDefDto, type GroupMemberDto } from '../lib/api.js'
import { CustomFieldsEditor } from './CustomFieldsEditor.js'

type BulkAction =
  | { action: 'update'; itemIds: string[]; patch: BulkItemPatch }
  | { action: 'delete'; itemIds: string[] }

// Bulk action bar for the standard checklist (Lists v2 slice 6). Appears
// when one or more rows are selected and applies a single action across
// the whole selection via the bulk endpoint (one request, one realtime
// frame). On success it calls onDone so the page clears the selection and
// refetches; failures bubble up through onError.

interface BulkToolbarProps {
  listId: string
  selectedIds: string[]
  members: GroupMemberDto[]
  fieldDefs: FieldDefDto[]
  onDone: () => void
  onError: (err: unknown) => void
  onClear: () => void
}

export function BulkToolbar({
  listId,
  selectedIds,
  members,
  fieldDefs,
  onDone,
  onError,
  onClear,
}: BulkToolbarProps) {
  const [busy, setBusy] = useState(false)
  // The custom field currently chosen for a bulk set, and the staged value
  // for it. null fieldId = the set-field control is closed.
  const [setFieldId, setSetFieldId] = useState<string | null>(null)
  const [stagedValue, setStagedValue] = useState<unknown>(undefined)

  async function run(action: BulkAction) {
    if (busy || selectedIds.length === 0) return
    setBusy(true)
    try {
      await bulkItems(listId, action)
      setSetFieldId(null)
      setStagedValue(undefined)
      onDone()
    } catch (err) {
      onError(err)
    } finally {
      setBusy(false)
    }
  }

  const chosenDef = fieldDefs.find((d) => d.id === setFieldId)

  return (
    <div
      className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm"
      style={{ border: '1.5px solid var(--acid)', background: 'var(--surface)' }}
    >
      <span style={{ color: 'var(--ink)' }}>{selectedIds.length} selected</span>

      <button
        type="button"
        disabled={busy}
        onClick={() => void run({ action: 'update', itemIds: selectedIds, patch: { completed: true } })}
        className="btn-ghost"
        style={{ width: 'auto' }}
      >
        Complete
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => void run({ action: 'update', itemIds: selectedIds, patch: { completed: false } })}
        className="btn-ghost"
        style={{ width: 'auto' }}
      >
        Mark incomplete
      </button>

      <select
        value="__assign__"
        disabled={busy}
        onChange={(e) => {
          const v = e.target.value
          if (v === '__assign__') return
          const assignedTo = v === '__unassigned__' ? null : v
          void run({ action: 'update', itemIds: selectedIds, patch: { assignedTo } })
        }}
        className="cyber-input"
        style={{ width: 'auto', padding: '4px 8px' }}
        aria-label="Assign selected"
      >
        <option value="__assign__" disabled hidden>
          Assign…
        </option>
        <option value="__unassigned__">Unassigned</option>
        {members.map((m) => (
          <option key={m.id} value={m.user_id}>
            {m.user_id}
          </option>
        ))}
      </select>

      {fieldDefs.length > 0 && (
        <select
          value={setFieldId ?? ''}
          disabled={busy}
          onChange={(e) => {
            setSetFieldId(e.target.value === '' ? null : e.target.value)
            setStagedValue(undefined)
          }}
          className="cyber-input"
          style={{ width: 'auto', padding: '4px 8px' }}
          aria-label="Set a field"
        >
          <option value="">Set field…</option>
          {fieldDefs.map((d) => (
            <option key={d.id} value={d.id}>
              {d.label}
            </option>
          ))}
        </select>
      )}

      {chosenDef && (
        <div className="flex items-center gap-2">
          <CustomFieldsEditor
            defs={[chosenDef]}
            values={{ [chosenDef.id]: stagedValue }}
            members={members}
            onChange={(_fieldId, value) => setStagedValue(value)}
          />
          <button
            type="button"
            disabled={busy || stagedValue === undefined}
            onClick={() =>
              void run({
                action: 'update',
                itemIds: selectedIds,
                patch: { customFields: { [chosenDef.id]: stagedValue } },
              })
            }
            className="btn-ghost"
            style={{ width: 'auto' }}
          >
            Apply
          </button>
        </div>
      )}

      <button
        type="button"
        disabled={busy}
        onClick={() => {
          if (window.confirm(`Delete ${selectedIds.length} item(s)?`)) {
            void run({ action: 'delete', itemIds: selectedIds })
          }
        }}
        className="btn-ghost"
        style={{ width: 'auto', color: 'var(--hot)' }}
      >
        Delete
      </button>

      <button
        type="button"
        disabled={busy}
        onClick={onClear}
        className="ml-auto underline"
        style={{ color: 'var(--ink-dim)' }}
      >
        Clear
      </button>
    </div>
  )
}

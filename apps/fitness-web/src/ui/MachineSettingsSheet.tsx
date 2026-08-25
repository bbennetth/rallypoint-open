// Bottom-sheet editor for a single exercise's per-user machine settings —
// flexible name/value notes ("Cable height" -> "4", "Handle" -> "rope")
// so the actor doesn't have to re-discover machine positions every
// session. Opened from the strength-session exercise block header (gear
// affordance) and from the Library exercise detail actions. Same
// Drawer + `fit-startbtn` styling as AddExerciseSheet.

import { useEffect, useState } from 'react'
import { Banner, Drawer } from '@rallypoint/ui'
import type { MachineSettingEntry } from '@rallypoint/fitness-shared'
import { ApiError, getMachineSettings, putMachineSettings } from '../lib/api.js'

export interface MachineSettingsSheetProps {
  exerciseId: string
  exerciseName: string
  onClose: () => void
  /** Called after a successful save with the entries actually saved. */
  onSaved?: (entries: MachineSettingEntry[]) => void
}

interface DraftRow {
  name: string
  value: string
}

export function MachineSettingsSheet({
  exerciseId,
  exerciseName,
  onClose,
  onSaved,
}: MachineSettingsSheetProps) {
  const [rows, setRows] = useState<DraftRow[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    getMachineSettings(exerciseId)
      .then((res) => {
        if (cancelled) return
        setRows(res.entries.length > 0 ? res.entries.map((e) => ({ ...e })) : [{ name: '', value: '' }])
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(
          err instanceof ApiError
            ? err.message
            : err instanceof Error
              ? err.message
              : 'Could not load machine settings.',
        )
        setRows([{ name: '', value: '' }])
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [exerciseId])

  function updateRow(index: number, field: 'name' | 'value', text: string) {
    setRows((cur) => cur.map((r, i) => (i === index ? { ...r, [field]: text } : r)))
  }

  function addRow() {
    setRows((cur) => (cur.length >= 12 ? cur : [...cur, { name: '', value: '' }]))
  }

  function removeRow(index: number) {
    setRows((cur) => cur.filter((_, i) => i !== index))
  }

  async function handleSave() {
    setError(null)
    const entries = rows
      .map((r) => ({ name: r.name.trim(), value: r.value.trim() }))
      .filter((r) => r.name.length > 0 && r.value.length > 0)
    if (entries.length > 12) {
      setError('Up to 12 machine settings per exercise.')
      return
    }
    setSaving(true)
    try {
      const res = await putMachineSettings(exerciseId, entries)
      onSaved?.(res.entries)
      onClose()
    } catch (err: unknown) {
      setError(
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Could not save machine settings.',
      )
    } finally {
      setSaving(false)
    }
  }

  const fieldLabel = { fontSize: 11, color: 'var(--ink-dim)', fontWeight: 500 } as const

  return (
    <Drawer open mobileSheet title={`Machine settings — ${exerciseName}`} onClose={onClose}>
      <div style={{ display: 'grid', gap: 14 }}>
        {error && <Banner tone="error">{error}</Banner>}

        {loading ? (
          <div style={{ fontSize: 13, color: 'var(--ink-dim)' }}>Loading…</div>
        ) : (
          <div style={{ display: 'grid', gap: 8 }}>
            {rows.map((row, i) => (
              <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 8 }}>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {i === 0 && <span style={fieldLabel}>Name</span>}
                  <input
                    className="pl-input"
                    type="text"
                    value={row.name}
                    onChange={(e) => updateRow(i, 'name', e.target.value)}
                    placeholder="e.g. Cable height"
                    maxLength={40}
                  />
                </label>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {i === 0 && <span style={fieldLabel}>Value</span>}
                  <input
                    className="pl-input"
                    type="text"
                    value={row.value}
                    onChange={(e) => updateRow(i, 'value', e.target.value)}
                    placeholder="e.g. 4"
                    maxLength={60}
                  />
                </label>
                <button
                  type="button"
                  className="fit-startbtn ghost"
                  onClick={() => removeRow(i)}
                  disabled={saving}
                  aria-label="Remove row"
                  style={{
                    alignSelf: i === 0 ? 'end' : 'center',
                    marginTop: i === 0 ? 20 : 0,
                    padding: '4px 10px',
                  }}
                >
                  ✕
                </button>
              </div>
            ))}

            <button
              type="button"
              className="fit-startbtn ghost"
              onClick={addRow}
              disabled={saving || rows.length >= 12}
            >
              + Add row
            </button>
          </div>
        )}

        <div className="btn-row">
          <button type="button" className="fit-startbtn ghost" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button
            type="button"
            className="fit-startbtn"
            onClick={handleSave}
            disabled={saving || loading}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </Drawer>
  )
}

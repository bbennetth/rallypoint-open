// Shared "Save as template" sheet used by three call sites — the WOD
// live session done overlay, the strength live session done overlay,
// and the History detail sheet. Asks the user for a name (defaulted
// from whatever context the caller supplies — e.g. the original
// template name) and POSTs to `createWodTemplate`.
//
// When the caller knows the workout came from a user-owned custom
// template (`updateTarget`), the sheet also offers an "Update" mode
// that PATCHes the source template in place instead of cloning it.
//
// The caller owns the shape of the payload (WOD body or strength
// body); this component only owns the mode choice + name input + the
// API call.

import { useEffect, useState } from 'react'
import { Banner, Drawer } from '@rallypoint/ui'
import { createWodTemplate, patchWodTemplate, ApiError } from '../lib/api.js'
import type { PatchWodTemplateInput } from '@rallypoint/fitness-shared'

/** The payload-builder receives the user-chosen name and returns the
 *  body to POST. Returning a falsy value skips the save (e.g. when
 *  reconstructing from a workout that has no recoverable body). */
export type SaveAsTemplatePayloadBuilder = (
  name: string,
) => Parameters<typeof createWodTemplate>[0] | null

/** Builds the PATCH payload for update mode. The dialog adds `name`
 *  itself when the user renamed the template; builders should return
 *  only the structural fields (body, and wodType for WODs). Returning
 *  a falsy value skips the save, same as the create builder. */
export type UpdateTemplatePayloadBuilder = () => PatchWodTemplateInput | null

export interface SaveAsTemplateDialogProps {
  open: boolean
  /** Default name shown in the input — usually the source workout's
   *  templateName or title. Empty string is fine. */
  defaultName?: string
  /** Pre-rendered chips / summary line shown above the input so the
   *  user knows what they're saving. Optional. */
  summary?: React.ReactNode
  /** Build the create payload from the user-chosen name. */
  build: SaveAsTemplatePayloadBuilder
  /** When set, the workout is known to come from this user-owned
   *  custom template and the sheet offers updating it in place
   *  (default mode) alongside saving a new copy. */
  updateTarget?: { id: string; name: string } | null
  /** Build the PATCH payload for update mode. Required to actually
   *  perform an update; without it `updateTarget` is ignored. */
  buildPatch?: UpdateTemplatePayloadBuilder
  onClose: () => void
  /** Called after a successful save with the saved template id (the
   *  source template's id in update mode). */
  onSaved?: (templateId: string) => void
}

export function SaveAsTemplateDialog({
  open,
  defaultName = '',
  summary,
  build,
  updateTarget = null,
  buildPatch,
  onClose,
  onSaved,
}: SaveAsTemplateDialogProps) {
  const canUpdate = updateTarget != null && buildPatch != null
  const [name, setName] = useState(defaultName)
  const [mode, setMode] = useState<'update' | 'create'>(canUpdate ? 'update' : 'create')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // True once the user typed a name or picked a mode this open — from
  // then on their input wins over any late-arriving defaults.
  const [dirty, setDirty] = useState(false)

  // Reset on re-open (the open transition only) so a previous attempt's
  // name + error don't bleed into a fresh open.
  useEffect(() => {
    if (open) {
      setName(defaultName)
      setMode(canUpdate ? 'update' : 'create')
      setError(null)
      setDirty(false)
    }
    // defaultName/canUpdate are deliberately read-latest, not deps: the
    // History sheet resolves its update target asynchronously, and a
    // resolution landing mid-typing must not clobber the user's input.
  }, [open])

  // A late-resolving update target (History sheet: getWodTemplate lands
  // after the dialog opened) is adopted only while the form is pristine.
  useEffect(() => {
    if (open && !dirty) {
      setName(defaultName)
      setMode(canUpdate ? 'update' : 'create')
    }
  }, [defaultName, canUpdate])

  if (!open) return null

  const updating = canUpdate && mode === 'update'

  async function handleSave() {
    const trimmed = name.trim()
    if (!trimmed) {
      setError('Give the workout a name.')
      return
    }
    setError(null)
    setSaving(true)
    try {
      if (updating) {
        const patch = buildPatch!()
        if (!patch) {
          setError("Couldn't rebuild the workout shape from this session.")
          return
        }
        // Only send a rename when the user actually changed the name.
        const renamed = trimmed !== updateTarget!.name
        const res = await patchWodTemplate(updateTarget!.id, {
          ...patch,
          ...(renamed ? { name: trimmed } : {}),
        })
        onSaved?.(res.id)
      } else {
        const payload = build(trimmed)
        if (!payload) {
          setError("Couldn't rebuild the workout shape from this session.")
          return
        }
        const res = await createWodTemplate(payload)
        onSaved?.(res.id)
      }
      onClose()
    } catch (err: unknown) {
      setError(
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Could not save that workout.',
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <Drawer
      open
      mobileSheet
      title={canUpdate ? 'Save template' : 'Save as template'}
      onClose={onClose}
    >
      <div style={{ display: 'grid', gap: 14 }}>
        {summary}
        {error && <Banner tone="error">{error}</Banner>}
        {canUpdate && (
          <div role="radiogroup" aria-label="Save mode" style={{ display: 'grid', gap: 6 }}>
            {(
              [
                ['update', `Update “${updateTarget!.name}”`],
                ['create', 'Save as a new template'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={mode === value}
                className="fit-startbtn ghost"
                onClick={() => {
                  setMode(value)
                  setDirty(true)
                }}
                disabled={saving}
                // .ghost is borderless — mark the selected mode with an
                // inset ring instead of a border it doesn't have.
                style={mode === value ? { boxShadow: 'inset 0 0 0 2px var(--acid)' } : undefined}
              >
                {label}
              </button>
            ))}
          </div>
        )}
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span className="cmp-label">NAME</span>
          <input
            className="pl-input"
            value={name}
            onChange={(e) => {
              setName(e.target.value)
              setDirty(true)
            }}
            placeholder="e.g. Tuesday squats"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleSave()
            }}
            style={{ fontSize: 16 }}
          />
        </label>
        <div className="btn-row">
          <button
            type="button"
            className="fit-startbtn ghost"
            onClick={onClose}
            disabled={saving}
          >
            Cancel
          </button>
          <button
            type="button"
            className="fit-startbtn"
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? 'Saving…' : updating ? 'Update template' : 'Save to library'}
          </button>
        </div>
      </div>
    </Drawer>
  )
}

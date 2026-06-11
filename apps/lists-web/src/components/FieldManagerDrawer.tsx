import { useEffect, useState } from 'react'
import { Button, Drawer, useToast } from '@rallypoint/ui'
import { FIELD_TYPES, type CreateFieldDefInput, type FieldType } from '@rallypoint/lists-shared'
import {
  ApiError,
  createFieldDef,
  deleteFieldDef,
  listFieldDefs,
  updateFieldDef,
  type FieldDefDto,
} from '../lib/api.js'
import {
  activeChoices,
  fieldTypeHasChoices,
  fieldTypeLabel,
  planFieldReorder,
} from '../lib/field-form.js'

// Lists v2 — field-manager surface. Only the list creator can open it
// (the API enforces the same with a 403). Add custom field definitions
// (columns), rename/toggle-required/reorder/soft-delete them, and manage
// select-field options. Field type is immutable after creation, so an
// existing field shows its type read-only. Option edits echo the option
// id (rename) or omit it (new); removal archives (never drops) so stored
// values keep resolving a label. Mutations publish list_field_defs
// envelopes server-side, so other viewers refetch live.

export interface FieldManagerDrawerProps {
  open: boolean
  onClose: () => void
  listId: string
  listName: string
}

const STATUS_LOADING = 'loading' as const
const STATUS_READY = 'ready' as const
const STATUS_ERROR = 'error' as const

type LoadState =
  | { status: typeof STATUS_LOADING }
  | { status: typeof STATUS_READY; defs: FieldDefDto[] }
  | { status: typeof STATUS_ERROR; message: string }

// A choice in the add-field form. The id is a client-only render key
// (the server mints the real opt_ id on create) and is never sent.
interface ChoiceDraft {
  id: string
  value: string
}

let choiceDraftSeq = 0
function newChoiceDraft(value = ''): ChoiceDraft {
  choiceDraftSeq += 1
  return { id: `draft_${choiceDraftSeq}`, value }
}

export function FieldManagerDrawer({ open, onClose, listId, listName }: FieldManagerDrawerProps) {
  const toast = useToast()
  const [state, setState] = useState<LoadState>({ status: STATUS_LOADING })
  // Add-field form.
  const [label, setLabel] = useState('')
  const [fieldType, setFieldType] = useState<FieldType>('text')
  const [required, setRequired] = useState(false)
  const [multiline, setMultiline] = useState(false)
  // Stable per-draft ids so removing a non-last choice doesn't make
  // React reuse the wrong controlled input by array index.
  const [choiceDrafts, setChoiceDrafts] = useState<ChoiceDraft[]>(() => [newChoiceDraft()])
  const [submitting, setSubmitting] = useState(false)

  async function load() {
    setState({ status: STATUS_LOADING })
    try {
      const page = await listFieldDefs(listId)
      setState({ status: STATUS_READY, defs: page.items })
    } catch (err) {
      setState({
        status: STATUS_ERROR,
        message: err instanceof ApiError ? `${err.code}: ${err.message}` : 'Failed to load fields.',
      })
    }
  }

  useEffect(() => {
    if (!open) return
    void load()
    resetForm()
  }, [open, listId])

  function resetForm() {
    setLabel('')
    setFieldType('text')
    setRequired(false)
    setMultiline(false)
    setChoiceDrafts([newChoiceDraft()])
  }

  function reportError(err: unknown, fallback: string) {
    toast({ tone: 'error', body: err instanceof ApiError ? err.message : fallback })
  }

  const hasChoices = fieldTypeHasChoices(fieldType)
  const liveChoiceDrafts = choiceDrafts.map((c) => c.value.trim()).filter((c) => c.length > 0)
  const canSubmit =
    label.trim().length > 0 && (!hasChoices || liveChoiceDrafts.length > 0) && !submitting

  async function handleAddField(e: React.FormEvent) {
    e.preventDefault()
    if (!canSubmit) return
    setSubmitting(true)
    try {
      const input: CreateFieldDefInput = {
        label: label.trim(),
        fieldType,
        required,
      }
      if (fieldType === 'text' && multiline) input.multiline = true
      if (hasChoices) input.choices = liveChoiceDrafts.map((l) => ({ label: l }))
      await createFieldDef(listId, input)
      resetForm()
      await load()
      toast({ tone: 'success', body: `Field "${input.label}" added.` })
    } catch (err) {
      reportError(err, 'Failed to add field.')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleRename(def: FieldDefDto, next: string) {
    const trimmed = next.trim()
    if (trimmed.length === 0 || trimmed === def.label) return
    try {
      await updateFieldDef(listId, def.id, { label: trimmed })
      await load()
    } catch (err) {
      reportError(err, 'Failed to rename field.')
    }
  }

  async function handleToggleRequired(def: FieldDefDto) {
    try {
      await updateFieldDef(listId, def.id, { required: !def.required })
      await load()
    } catch (err) {
      reportError(err, 'Failed to update field.')
    }
  }

  async function handleReorder(defs: FieldDefDto[], index: number, dir: -1 | 1) {
    const patches = planFieldReorder(defs, index, dir)
    if (!patches) return
    try {
      await Promise.all(
        patches.map((p) => updateFieldDef(listId, p.id, { position: p.position })),
      )
      await load()
    } catch (err) {
      reportError(err, 'Failed to reorder fields.')
    }
  }

  async function handleDelete(def: FieldDefDto) {
    try {
      await deleteFieldDef(listId, def.id)
      await load()
      toast({ tone: 'success', body: `Field "${def.label}" removed.` })
    } catch (err) {
      reportError(err, 'Failed to remove field.')
    }
  }

  // Option mutations send a single-choice patch; the server preserves
  // every omitted existing choice (anti-orphan merge), so we never resend
  // the whole array.
  async function handleAddOption(def: FieldDefDto, optionLabel: string) {
    const trimmed = optionLabel.trim()
    if (trimmed.length === 0) return
    try {
      await updateFieldDef(listId, def.id, { choices: [{ label: trimmed }] })
      await load()
    } catch (err) {
      reportError(err, 'Failed to add option.')
    }
  }

  async function handleRenameOption(def: FieldDefDto, optionId: string, next: string) {
    const trimmed = next.trim()
    if (trimmed.length === 0) return
    try {
      await updateFieldDef(listId, def.id, { choices: [{ id: optionId, label: trimmed }] })
      await load()
    } catch (err) {
      reportError(err, 'Failed to rename option.')
    }
  }

  async function handleArchiveOption(def: FieldDefDto, optionId: string, optionLabel: string) {
    try {
      await updateFieldDef(listId, def.id, {
        choices: [{ id: optionId, label: optionLabel, archived: true }],
      })
      await load()
    } catch (err) {
      reportError(err, 'Failed to remove option.')
    }
  }

  return (
    <Drawer open={open} onClose={onClose} title={`Fields · "${listName}"`} width={420}>
      <div className="space-y-5">
        <p className="text-sm text-[color:var(--ink-dim)]">
          Custom fields add typed columns to this list. Only you (the
          creator) can change them. A field's type can't change after
          it's created.
        </p>

        <form onSubmit={(e) => void handleAddField(e)} className="space-y-3">
          <h3 style={{ fontSize: 12, color: 'var(--ink-dim)' }}>Add a field</h3>
          <label className="block text-sm text-[color:var(--ink-dim)]">
            Label
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. Budget"
              className="cyber-input mt-1"
              maxLength={60}
            />
          </label>
          <label className="block text-sm text-[color:var(--ink-dim)]">
            Type
            <select
              value={fieldType}
              onChange={(e) => setFieldType(e.target.value as FieldType)}
              className="cyber-input mt-1"
            >
              {FIELD_TYPES.map((t) => (
                <option key={t} value={t}>
                  {fieldTypeLabel(t)}
                </option>
              ))}
            </select>
          </label>

          {fieldType === 'text' && (
            <label className="flex items-center gap-2 text-sm text-[color:var(--ink-dim)]">
              <input
                type="checkbox"
                checked={multiline}
                onChange={(e) => setMultiline(e.target.checked)}
                className="h-4 w-4"
                style={{ accentColor: 'var(--acid)' }}
              />
              Multi-line text
            </label>
          )}

          {hasChoices && (
            <div className="space-y-2">
              <span className="block text-sm text-[color:var(--ink-dim)]">Choices</span>
              {choiceDrafts.map((c, i) => (
                <div key={c.id} className="flex items-center gap-2">
                  <input
                    value={c.value}
                    onChange={(e) => {
                      const value = e.target.value
                      setChoiceDrafts((prev) =>
                        prev.map((d) => (d.id === c.id ? { ...d, value } : d)),
                      )
                    }}
                    placeholder={`Option ${i + 1}`}
                    className="cyber-input"
                    maxLength={60}
                  />
                  {choiceDrafts.length > 1 && (
                    <button
                      type="button"
                      onClick={() =>
                        setChoiceDrafts((prev) => prev.filter((d) => d.id !== c.id))
                      }
                      aria-label="Remove option"
                      className="rounded px-1.5 py-0.5"
                      style={{ color: 'var(--hot)' }}
                    >
                      ✕
                    </button>
                  )}
                </div>
              ))}
              <Button
                variant="ghost"
                onClick={() => setChoiceDrafts((prev) => [...prev, newChoiceDraft()])}
              >
                + Add option
              </Button>
            </div>
          )}

          <label className="flex items-center gap-2 text-sm text-[color:var(--ink-dim)]">
            <input
              type="checkbox"
              checked={required}
              onChange={(e) => setRequired(e.target.checked)}
              className="h-4 w-4"
              style={{ accentColor: 'var(--acid)' }}
            />
            Required
          </label>

          <Button variant="brutal" type="submit" disabled={!canSubmit}>
            {submitting ? 'Adding…' : 'Add field'}
          </Button>
        </form>

        {state.status === STATUS_LOADING && (
          <p className="text-sm text-[color:var(--ink-dim)]">Loading…</p>
        )}
        {state.status === STATUS_ERROR && (
          <p className="text-sm" style={{ color: 'var(--hot)' }}>
            {state.message}
          </p>
        )}

        {state.status === STATUS_READY && (
          <section className="space-y-2">
            <h3 style={{ fontSize: 12, color: 'var(--ink-dim)' }}>
              Fields ({state.defs.length})
            </h3>
            {state.defs.length === 0 ? (
              <p className="text-sm" style={{ color: 'var(--ink-dim)' }}>
                No custom fields yet.
              </p>
            ) : (
              <ul className="space-y-2">
                {state.defs.map((def, index) => (
                  <FieldRow
                    key={def.id}
                    def={def}
                    canMoveUp={index > 0}
                    canMoveDown={index < state.defs.length - 1}
                    onRename={(next) => void handleRename(def, next)}
                    onToggleRequired={() => void handleToggleRequired(def)}
                    onMoveUp={() => void handleReorder(state.defs, index, -1)}
                    onMoveDown={() => void handleReorder(state.defs, index, 1)}
                    onDelete={() => void handleDelete(def)}
                    onAddOption={(l) => void handleAddOption(def, l)}
                    onRenameOption={(id, l) => void handleRenameOption(def, id, l)}
                    onArchiveOption={(id, l) => void handleArchiveOption(def, id, l)}
                  />
                ))}
              </ul>
            )}
          </section>
        )}
      </div>
    </Drawer>
  )
}

interface FieldRowProps {
  def: FieldDefDto
  canMoveUp: boolean
  canMoveDown: boolean
  onRename: (next: string) => void
  onToggleRequired: () => void
  onMoveUp: () => void
  onMoveDown: () => void
  onDelete: () => void
  onAddOption: (label: string) => void
  onRenameOption: (optionId: string, label: string) => void
  onArchiveOption: (optionId: string, label: string) => void
}

function FieldRow({
  def,
  canMoveUp,
  canMoveDown,
  onRename,
  onToggleRequired,
  onMoveUp,
  onMoveDown,
  onDelete,
  onAddOption,
  onRenameOption,
  onArchiveOption,
}: FieldRowProps) {
  const [label, setLabel] = useState(def.label)
  const [newOption, setNewOption] = useState('')

  useEffect(() => {
    setLabel(def.label)
  }, [def.label])

  const choices = activeChoices(def)
  const isSelect = fieldTypeHasChoices(def.field_type)
  // Mirror the server guard (#258): a required select must keep ≥1 active
  // choice, else its required-field gate can never clear and Add locks up.
  // So you can't turn `required` on while a select has no active choices,
  // and you can't archive the last active choice of a required select.
  const requiredLockedOff = isSelect && choices.length === 0 && !def.required
  const archiveLastLocked = def.required && choices.length === 1

  return (
    <li
      className="space-y-2 px-3 py-2"
      style={{ border: '1.5px solid var(--line)', background: 'var(--surface)' }}
    >
      <div className="flex items-center gap-2">
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onBlur={() => {
            if (label.trim().length > 0) onRename(label)
            else setLabel(def.label)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          }}
          className="flex-1 bg-transparent text-sm focus:outline-none"
          aria-label="Field label"
        />
        <span
          className="mono"
          style={{ fontSize: 9, color: 'var(--ink-mute)', whiteSpace: 'nowrap' }}
        >
          {fieldTypeLabel(def.field_type)}
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onMoveUp}
            disabled={!canMoveUp}
            aria-label="Move up"
            className="rounded px-1.5 py-0.5 text-[color:var(--ink-dim)] hover:text-[color:var(--ink)] disabled:opacity-30"
          >
            ↑
          </button>
          <button
            type="button"
            onClick={onMoveDown}
            disabled={!canMoveDown}
            aria-label="Move down"
            className="rounded px-1.5 py-0.5 text-[color:var(--ink-dim)] hover:text-[color:var(--ink)] disabled:opacity-30"
          >
            ↓
          </button>
          <button
            type="button"
            onClick={onDelete}
            aria-label="Remove field"
            className="rounded px-1.5 py-0.5"
            style={{ color: 'var(--hot)' }}
          >
            ✕
          </button>
        </div>
      </div>

      <label className="flex items-center gap-2" style={{ fontSize: 11, color: 'var(--ink-dim)' }}>
        <input
          type="checkbox"
          checked={def.required}
          onChange={onToggleRequired}
          disabled={requiredLockedOff}
          title={requiredLockedOff ? 'Add a choice before making this field required.' : undefined}
          className="h-3.5 w-3.5 disabled:opacity-40"
          style={{ accentColor: 'var(--acid)' }}
        />
        Required
        {requiredLockedOff && (
          <span style={{ fontSize: 10, color: 'var(--ink-mute)' }}>(add a choice first)</span>
        )}
      </label>

      {isSelect && (
        <div className="space-y-1.5 pl-2" style={{ borderLeft: '1.5px solid var(--line)' }}>
          {choices.map((c) => (
            <OptionRow
              key={c.id}
              label={c.label}
              onRename={(next) => onRenameOption(c.id, next)}
              onArchive={() => onArchiveOption(c.id, c.label)}
              disableArchive={archiveLastLocked}
            />
          ))}
          <div className="flex items-center gap-2">
            <input
              value={newOption}
              onChange={(e) => setNewOption(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  if (newOption.trim().length > 0) {
                    onAddOption(newOption)
                    setNewOption('')
                  }
                }
              }}
              placeholder="New option"
              className="cyber-input"
              style={{ fontSize: 12, padding: '4px 8px' }}
              maxLength={60}
            />
            <Button
              variant="ghost"
              onClick={() => {
                if (newOption.trim().length > 0) {
                  onAddOption(newOption)
                  setNewOption('')
                }
              }}
            >
              Add
            </Button>
          </div>
        </div>
      )}
    </li>
  )
}

interface OptionRowProps {
  label: string
  onRename: (next: string) => void
  onArchive: () => void
  // True when this is the last active choice of a REQUIRED select, where
  // archiving it would strand the field (#258) — block it client-side too.
  disableArchive?: boolean
}

function OptionRow({ label, onRename, onArchive, disableArchive }: OptionRowProps) {
  const [value, setValue] = useState(label)

  useEffect(() => {
    setValue(label)
  }, [label])

  return (
    <div className="flex items-center gap-2">
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => {
          if (value.trim().length > 0 && value.trim() !== label) onRename(value)
          else setValue(label)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        }}
        className="flex-1 bg-transparent focus:outline-none"
        style={{ fontSize: 12, color: 'var(--ink)' }}
        aria-label="Option label"
      />
      <button
        type="button"
        onClick={onArchive}
        disabled={disableArchive}
        title={disableArchive ? 'A required field must keep at least one choice.' : undefined}
        aria-label="Remove option"
        className="rounded px-1.5 disabled:opacity-30 disabled:cursor-not-allowed"
        style={{ color: 'var(--hot)', fontSize: 12 }}
      >
        ✕
      </button>
    </div>
  )
}

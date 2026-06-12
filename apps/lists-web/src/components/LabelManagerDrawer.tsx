import { useEffect, useState } from 'react'
import { Button, Drawer, useToast } from '@rallypoint/ui'
import {
  ApiError,
  createLabel,
  deleteLabel,
  listLabels,
  updateLabel,
  type LabelDto,
} from '../lib/api.js'
import { STATUS_COLOR_KEYS, statusColorStyle, type StatusColorKey } from '../lib/status-colors.js'

// Manage-labels surface (RPL v1.0.0 S12 UI), modeled on StatusManagerDrawer.
// Only the list creator can open it (the API enforces the same with a 403).
// Add / rename / recolor / delete the per-list labels; deleting a label
// purges its item attachments server-side.

export interface LabelManagerDrawerProps {
  open: boolean
  onClose: () => void
  listId: string
  listName: string
}

const LOADING = 'loading' as const
const READY = 'ready' as const
const ERROR = 'error' as const

type LoadState =
  | { status: typeof LOADING }
  | { status: typeof READY; labels: LabelDto[] }
  | { status: typeof ERROR; message: string }

export function LabelManagerDrawer({ open, onClose, listId, listName }: LabelManagerDrawerProps) {
  const toast = useToast()
  const [state, setState] = useState<LoadState>({ status: LOADING })
  const [name, setName] = useState('')
  const [color, setColor] = useState<StatusColorKey>('sky')
  const [submitting, setSubmitting] = useState(false)

  async function load() {
    setState({ status: LOADING })
    try {
      const page = await listLabels(listId)
      setState({ status: READY, labels: page.items })
    } catch (err) {
      setState({
        status: ERROR,
        message: err instanceof ApiError ? `${err.code}: ${err.message}` : 'Failed to load labels.',
      })
    }
  }

  useEffect(() => {
    if (!open) return
    void load()
    setName('')
    setColor('sky')
  }, [open, listId])

  function reportError(err: unknown, fallback: string) {
    toast({ tone: 'error', body: err instanceof ApiError ? err.message : fallback })
  }

  const canSubmit = name.trim().length > 0 && !submitting

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault()
    if (!canSubmit) return
    const trimmedName = name.trim()
    setSubmitting(true)
    try {
      await createLabel(listId, { name: trimmedName, color })
      setName('')
      await load()
      toast({ tone: 'success', body: `Label "${trimmedName}" added.` })
    } catch (err) {
      reportError(err, 'Failed to add label.')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleRename(l: LabelDto, next: string) {
    const trimmed = next.trim()
    if (trimmed.length === 0 || trimmed === l.name) return
    try {
      await updateLabel(listId, l.id, { name: trimmed })
      await load()
    } catch (err) {
      reportError(err, 'Failed to rename label.')
    }
  }

  async function handleColor(l: LabelDto, next: StatusColorKey) {
    if (next === l.color) return
    try {
      await updateLabel(listId, l.id, { color: next })
      await load()
    } catch (err) {
      reportError(err, 'Failed to recolor label.')
    }
  }

  async function handleDelete(l: LabelDto) {
    if (!window.confirm(`Delete label "${l.name}"? It will be removed from all items.`)) return
    try {
      await deleteLabel(listId, l.id)
      await load()
      toast({ tone: 'success', body: `Label "${l.name}" removed.` })
    } catch (err) {
      reportError(err, 'Failed to remove label.')
    }
  }

  return (
    <Drawer open={open} onClose={onClose} title={`Labels · "${listName}"`} width={420}>
      <div className="space-y-5">
        <p className="text-sm text-[color:var(--ink-dim)]">
          Labels tag items with a colored chip. Only you (the creator) can
          manage them; deleting a label removes it from every item.
        </p>

        <form onSubmit={(e) => void handleAdd(e)} className="space-y-3">
          <h3 style={{ fontSize: 12, color: 'var(--ink-dim)' }}>Add a label</h3>
          <label className="block text-sm text-[color:var(--ink-dim)]">
            Name
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. bug"
              className="cyber-input mt-1"
              maxLength={60}
            />
          </label>
          <div className="space-y-1.5">
            <span className="block text-sm text-[color:var(--ink-dim)]">Color</span>
            <SwatchPicker value={color} onChange={setColor} />
          </div>
          <Button variant="brutal" type="submit" disabled={!canSubmit}>
            {submitting ? 'Adding…' : 'Add label'}
          </Button>
        </form>

        {state.status === LOADING && <p className="text-sm text-[color:var(--ink-dim)]">Loading…</p>}
        {state.status === ERROR && (
          <p className="text-sm" style={{ color: 'var(--hot)' }}>
            {state.message}
          </p>
        )}

        {state.status === READY && (
          <section className="space-y-2">
            <h3 style={{ fontSize: 12, color: 'var(--ink-dim)' }}>Labels ({state.labels.length})</h3>
            {state.labels.length === 0 ? (
              <p className="text-sm" style={{ color: 'var(--ink-dim)' }}>
                No labels yet.
              </p>
            ) : (
              <ul className="space-y-2">
                {state.labels.map((l) => (
                  <LabelRow
                    key={l.id}
                    label={l}
                    onRename={(next) => void handleRename(l, next)}
                    onColor={(next) => void handleColor(l, next)}
                    onDelete={() => void handleDelete(l)}
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

interface LabelRowProps {
  label: LabelDto
  onRename: (next: string) => void
  onColor: (next: StatusColorKey) => void
  onDelete: () => void
}

function LabelRow({ label, onRename, onColor, onDelete }: LabelRowProps) {
  const [name, setName] = useState(label.name)

  useEffect(() => {
    setName(label.name)
  }, [label.name])

  return (
    <li
      className="space-y-2 px-3 py-2"
      style={{ border: '1.5px solid var(--line)', background: 'var(--surface)' }}
    >
      <div className="flex items-center gap-2">
        <span
          className="truncate rounded-full border px-2 py-0.5 text-xs"
          style={statusColorStyle(label.color)}
        >
          {label.name}
        </span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => {
            if (name.trim().length > 0) onRename(name)
            else setName(label.name)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          }}
          className="flex-1 bg-transparent text-sm focus:outline-none"
          aria-label="Label name"
        />
        <button
          type="button"
          onClick={onDelete}
          aria-label="Remove label"
          className="rounded px-1.5 py-0.5"
          style={{ color: 'var(--hot)' }}
        >
          ✕
        </button>
      </div>
      <SwatchPicker value={(label.color as StatusColorKey) ?? 'sky'} onChange={onColor} />
    </li>
  )
}

function SwatchPicker({
  value,
  onChange,
}: {
  value: StatusColorKey
  onChange: (next: StatusColorKey) => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {STATUS_COLOR_KEYS.map((key) => (
        <button
          key={key}
          type="button"
          onClick={() => onChange(key)}
          aria-label={key}
          aria-pressed={key === value}
          title={key}
          className="h-5 w-5 rounded-full"
          style={{
            background: statusColorStyle(key).borderColor,
            outline: key === value ? '2px solid var(--ink)' : 'none',
            outlineOffset: 1,
          }}
        />
      ))}
    </div>
  )
}

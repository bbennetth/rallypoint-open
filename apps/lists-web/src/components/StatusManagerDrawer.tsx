import { useEffect, useState } from 'react'
import { Button, Drawer, useToast } from '@rallypoint/ui'
import { STATUS_CATEGORIES, type StatusCategory } from '@rallypoint/lists-shared'
import {
  ApiError,
  createStatus,
  deleteStatus,
  listStatuses,
  reorderStatuses,
  updateStatus,
  type ListStatusDto,
} from '../lib/api.js'
import { STATUS_COLOR_KEYS, statusColorStyle, type StatusColorKey } from '../lib/status-colors.js'

// Manage-statuses surface (RPL v1.0.0 S2), modeled on FieldManagerDrawer.
// Only the list creator can open it (the API enforces the same with a 403).
// Add / rename / recolor / recategorize / reorder / delete the per-list
// kanban statuses. `category` is the load-bearing classifier; the server
// keeps a list completable (rejects deleting / recategorizing away the last
// `done` status), surfaced here as an error toast.

export interface StatusManagerDrawerProps {
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
  | { status: typeof STATUS_READY; statuses: ListStatusDto[] }
  | { status: typeof STATUS_ERROR; message: string }

const CATEGORY_LABEL: Record<StatusCategory, string> = {
  todo: 'To do',
  in_progress: 'In progress',
  done: 'Done',
}

export function StatusManagerDrawer({ open, onClose, listId, listName }: StatusManagerDrawerProps) {
  const toast = useToast()
  const [state, setState] = useState<LoadState>({ status: STATUS_LOADING })
  // Add-status form.
  const [name, setName] = useState('')
  const [category, setCategory] = useState<StatusCategory>('todo')
  const [color, setColor] = useState<StatusColorKey>('slate')
  const [submitting, setSubmitting] = useState(false)

  async function load() {
    setState({ status: STATUS_LOADING })
    try {
      const page = await listStatuses(listId)
      setState({ status: STATUS_READY, statuses: page.items })
    } catch (err) {
      setState({
        status: STATUS_ERROR,
        message: err instanceof ApiError ? `${err.code}: ${err.message}` : 'Failed to load statuses.',
      })
    }
  }

  useEffect(() => {
    if (!open) return
    void load()
    resetForm()
  }, [open, listId])

  function resetForm() {
    setName('')
    setCategory('todo')
    setColor('slate')
  }

  function reportError(err: unknown, fallback: string) {
    toast({ tone: 'error', body: err instanceof ApiError ? err.message : fallback })
  }

  const canSubmit = name.trim().length > 0 && !submitting

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault()
    if (!canSubmit) return
    setSubmitting(true)
    try {
      await createStatus(listId, { name: name.trim(), category, color })
      resetForm()
      await load()
      toast({ tone: 'success', body: `Status "${name.trim()}" added.` })
    } catch (err) {
      reportError(err, 'Failed to add status.')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleRename(s: ListStatusDto, next: string) {
    const trimmed = next.trim()
    if (trimmed.length === 0 || trimmed === s.name) return
    try {
      await updateStatus(listId, s.id, { name: trimmed })
      await load()
    } catch (err) {
      reportError(err, 'Failed to rename status.')
    }
  }

  async function handleCategory(s: ListStatusDto, next: StatusCategory) {
    if (next === s.category) return
    try {
      await updateStatus(listId, s.id, { category: next })
      await load()
    } catch (err) {
      reportError(err, 'Failed to change category.')
    }
  }

  async function handleColor(s: ListStatusDto, next: StatusColorKey) {
    if (next === s.color) return
    try {
      await updateStatus(listId, s.id, { color: next })
      await load()
    } catch (err) {
      reportError(err, 'Failed to recolor status.')
    }
  }

  async function handleReorder(statuses: ListStatusDto[], index: number, dir: -1 | 1) {
    const other = index + dir
    if (other < 0 || other >= statuses.length) return
    const ids = statuses.map((s) => s.id)
    ;[ids[index], ids[other]] = [ids[other]!, ids[index]!]
    try {
      await reorderStatuses(listId, { orderedIds: ids })
      await load()
    } catch (err) {
      reportError(err, 'Failed to reorder statuses.')
    }
  }

  async function handleDelete(s: ListStatusDto) {
    try {
      await deleteStatus(listId, s.id)
      await load()
      toast({ tone: 'success', body: `Status "${s.name}" removed.` })
    } catch (err) {
      reportError(err, 'Failed to remove status.')
    }
  }

  return (
    <Drawer open={open} onClose={onClose} title={`Statuses · "${listName}"`} width={420}>
      <div className="space-y-5">
        <p className="text-sm text-[color:var(--ink-dim)]">
          Statuses are this board's columns. The category (To do / In
          progress / Done) drives completion and ordering; a list always
          keeps at least one Done status.
        </p>

        <form onSubmit={(e) => void handleAdd(e)} className="space-y-3">
          <h3 style={{ fontSize: 12, color: 'var(--ink-dim)' }}>Add a status</h3>
          <label className="block text-sm text-[color:var(--ink-dim)]">
            Name
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. In review"
              className="cyber-input mt-1"
              maxLength={80}
            />
          </label>
          <label className="block text-sm text-[color:var(--ink-dim)]">
            Category
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value as StatusCategory)}
              className="cyber-input mt-1"
            >
              {STATUS_CATEGORIES.map((cat) => (
                <option key={cat} value={cat}>
                  {CATEGORY_LABEL[cat]}
                </option>
              ))}
            </select>
          </label>
          <div className="space-y-1.5">
            <span className="block text-sm text-[color:var(--ink-dim)]">Color</span>
            <SwatchPicker value={color} onChange={setColor} />
          </div>
          <Button variant="brutal" type="submit" disabled={!canSubmit}>
            {submitting ? 'Adding…' : 'Add status'}
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
              Statuses ({state.statuses.length})
            </h3>
            <ul className="space-y-2">
              {state.statuses.map((s, index) => (
                <StatusRow
                  key={s.id}
                  status={s}
                  canMoveUp={index > 0}
                  canMoveDown={index < state.statuses.length - 1}
                  onRename={(next) => void handleRename(s, next)}
                  onCategory={(next) => void handleCategory(s, next)}
                  onColor={(next) => void handleColor(s, next)}
                  onMoveUp={() => void handleReorder(state.statuses, index, -1)}
                  onMoveDown={() => void handleReorder(state.statuses, index, 1)}
                  onDelete={() => void handleDelete(s)}
                />
              ))}
            </ul>
          </section>
        )}
      </div>
    </Drawer>
  )
}

interface StatusRowProps {
  status: ListStatusDto
  canMoveUp: boolean
  canMoveDown: boolean
  onRename: (next: string) => void
  onCategory: (next: StatusCategory) => void
  onColor: (next: StatusColorKey) => void
  onMoveUp: () => void
  onMoveDown: () => void
  onDelete: () => void
}

function StatusRow({
  status,
  canMoveUp,
  canMoveDown,
  onRename,
  onCategory,
  onColor,
  onMoveUp,
  onMoveDown,
  onDelete,
}: StatusRowProps) {
  const [name, setName] = useState(status.name)

  useEffect(() => {
    setName(status.name)
  }, [status.name])

  return (
    <li
      className="space-y-2 px-3 py-2"
      style={{ border: '1.5px solid var(--line)', background: 'var(--surface)' }}
    >
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className="h-3 w-3 shrink-0 rounded-full"
          style={{ background: statusColorStyle(status.color).borderColor }}
        />
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => {
            if (name.trim().length > 0) onRename(name)
            else setName(status.name)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          }}
          className="flex-1 bg-transparent text-sm focus:outline-none"
          aria-label="Status name"
        />
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
            aria-label="Remove status"
            className="rounded px-1.5 py-0.5"
            style={{ color: 'var(--hot)' }}
          >
            ✕
          </button>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <select
          value={status.category}
          onChange={(e) => onCategory(e.target.value as StatusCategory)}
          aria-label="Category"
          className="cyber-input"
          style={{ width: 'auto', padding: '4px 8px', fontSize: 12 }}
        >
          {STATUS_CATEGORIES.map((cat) => (
            <option key={cat} value={cat}>
              {CATEGORY_LABEL[cat]}
            </option>
          ))}
        </select>
        <SwatchPicker value={(status.color as StatusColorKey) ?? 'slate'} onChange={onColor} />
      </div>
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
      {STATUS_COLOR_KEYS.map((key) => {
        const selected = key === value
        return (
          <button
            key={key}
            type="button"
            onClick={() => onChange(key)}
            aria-label={key}
            aria-pressed={selected}
            title={key}
            className="h-5 w-5 rounded-full"
            style={{
              background: statusColorStyle(key).borderColor,
              outline: selected ? '2px solid var(--ink)' : 'none',
              outlineOffset: 1,
            }}
          />
        )
      })}
    </div>
  )
}

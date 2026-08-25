import { useState } from 'react'

// Inline add-sub-item input, opened under a parent row. Indented to match
// its parent's children; Enter or the Add button creates, Esc or ✕ cancels.
export function AddSubItemRow({
  depth,
  submitting,
  onCancel,
  onSubmit,
}: {
  depth: number
  submitting: boolean
  onCancel: () => void
  onSubmit: (title: string) => void
}) {
  const [title, setTitle] = useState('')
  return (
    <li
      className="flex items-center gap-2 px-3 py-2"
      style={{
        border: '1.5px dashed var(--line)',
        background: 'var(--surface)',
        marginLeft: depth * 20,
      }}
    >
      <input
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && title.trim().length > 0) onSubmit(title)
          else if (e.key === 'Escape') onCancel()
        }}
        placeholder="Sub-item title…"
        className="cyber-input flex-1"
        style={{ padding: '4px 8px' }}
      />
      <button
        type="button"
        onClick={() => title.trim().length > 0 && onSubmit(title)}
        disabled={title.trim().length === 0 || submitting}
        className="btn-ghost"
        style={{ width: 'auto' }}
      >
        Add
      </button>
      <button
        type="button"
        onClick={onCancel}
        aria-label="Cancel"
        className="rounded px-1.5 py-0.5"
        style={{ color: 'var(--ink-dim)' }}
      >
        ✕
      </button>
    </li>
  )
}

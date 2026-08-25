import { Fragment } from 'react'

export function ListUndoBar({
  actionError,
  lastDeleted,
  onUndo,
}: {
  actionError: string | null
  lastDeleted: string | null
  onUndo: () => void
}) {
  return (
    <Fragment>
      {actionError && (
        <p className="text-sm" style={{ color: 'var(--hot)' }}>
          {actionError}
        </p>
      )}

      {lastDeleted && (
        <div
          className="flex items-center justify-between gap-3 px-4 py-2 text-sm text-[color:var(--ink)]"
          style={{ border: '1.5px solid var(--line)', background: 'var(--surface)' }}
        >
          <span>Item deleted.</span>
          <button
            type="button"
            onClick={onUndo}
            className="underline"
            style={{ color: 'var(--ink-dim)' }}
          >
            Undo
          </button>
        </div>
      )}
    </Fragment>
  )
}

import type { ListDto } from '../lib/api.js'

export function ListDetailHeader({
  list,
  readOnly,
  selfUserId,
  onStatusesOpen,
  onLabelsOpen,
  onFieldsOpen,
  onShareOpen,
  onDeleteList,
}: {
  list: ListDto
  readOnly: boolean
  selfUserId: string
  onStatusesOpen: () => void
  onLabelsOpen: () => void
  onFieldsOpen: () => void
  onShareOpen: () => void
  onDeleteList: () => void
}) {
  return (
    <header className="flex items-start justify-between gap-3 flex-wrap">
      <div>
        <p className="text-xs capitalize" style={{ color: 'var(--ink-dim)' }}>
          {list.list_type} · {list.visibility}
        </p>
        <h1 className="display text-2xl mt-1">{list.name}</h1>
      </div>
      <div className="flex items-center gap-2">
        {readOnly && (
          <span className="chip" style={{ color: 'var(--ink-dim)' }}>
            Planner · read-only
          </span>
        )}
        {/* Statuses button — board columns; creator-only on a
            tasks list (the API enforces the same). */}
        {!readOnly &&
          list.list_type === 'tasks' &&
          list.created_by === selfUserId && (
            <button
              type="button"
              onClick={onStatusesOpen}
              className="btn-ghost"
              style={{ width: 'auto' }}
            >
              Statuses
            </button>
          )}
        {/* Labels button — creator-only (the API enforces the
            same); labels apply to any list type. */}
        {!readOnly && list.created_by === selfUserId && (
          <button
            type="button"
            onClick={onLabelsOpen}
            className="btn-ghost"
            style={{ width: 'auto' }}
          >
            Labels
          </button>
        )}
        {/* Fields button — only the list creator can define
            custom columns (the API enforces the same). */}
        {!readOnly && list.created_by === selfUserId && (
          <button
            type="button"
            onClick={onFieldsOpen}
            className="btn-ghost"
            style={{ width: 'auto' }}
          >
            Fields
          </button>
        )}
        {/* Share button — only the creator of a 'private' list
            can mint share invites. 'all' lists are scope-wide
            already; no separate sharing surface. */}
        {!readOnly &&
          list.visibility === 'private' &&
          list.created_by === selfUserId && (
            <button
              type="button"
              onClick={onShareOpen}
              className="btn-ghost"
              style={{ width: 'auto' }}
            >
              Share
            </button>
          )}
        {/* Delete list — creator-only; the API enforces the same. */}
        {!readOnly && list.created_by === selfUserId && (
          <button
            type="button"
            onClick={onDeleteList}
            className="btn-ghost"
            style={{ width: 'auto', color: 'var(--hot)', borderColor: 'var(--hot)' }}
          >
            Delete list
          </button>
        )}
      </div>
    </header>
  )
}

import { useEffect, useState } from 'react'
import { Button, Drawer, useToast } from '@rallypoint/ui'
import {
  ApiError,
  createComment,
  deleteComment,
  listComments,
  updateComment,
  type CommentDto,
} from '../lib/api.js'
import { canManageComment, relativeTime } from '../lib/comments.js'

// Item comments thread (RPL v1.0.0 S7 UI). Any reader can post; edit and
// delete are author-only (the API enforces the same with a 403). Opens from
// the comments affordance on a checklist row or kanban card.

export interface ItemCommentsDrawerProps {
  open: boolean
  onClose: () => void
  listId: string
  itemId: string
  itemTitle: string
  selfUserId: string | null
}

const LOADING = 'loading' as const
const READY = 'ready' as const
const ERROR = 'error' as const

type LoadState =
  | { status: typeof LOADING }
  | { status: typeof READY; comments: CommentDto[] }
  | { status: typeof ERROR; message: string }

export function ItemCommentsDrawer({
  open,
  onClose,
  listId,
  itemId,
  itemTitle,
  selfUserId,
}: ItemCommentsDrawerProps) {
  const toast = useToast()
  const [state, setState] = useState<LoadState>({ status: LOADING })
  const [draft, setDraft] = useState('')
  const [posting, setPosting] = useState(false)

  async function load() {
    setState({ status: LOADING })
    try {
      const page = await listComments(listId, itemId)
      setState({ status: READY, comments: page.items })
    } catch (err) {
      setState({
        status: ERROR,
        message: err instanceof ApiError ? `${err.code}: ${err.message}` : 'Failed to load comments.',
      })
    }
  }

  useEffect(() => {
    if (!open) return
    setDraft('')
    void load()
  }, [open, listId, itemId])

  function reportError(err: unknown, fallback: string) {
    toast({ tone: 'error', body: err instanceof ApiError ? err.message : fallback })
  }

  async function handlePost(e: React.FormEvent) {
    e.preventDefault()
    if (posting || draft.trim().length === 0) return
    setPosting(true)
    try {
      await createComment(listId, itemId, draft.trim())
      setDraft('')
      await load()
    } catch (err) {
      reportError(err, 'Failed to post comment.')
    } finally {
      setPosting(false)
    }
  }

  // Returns true on success so the row only leaves edit mode when the save
  // actually landed (a failed save keeps the user's draft visible).
  async function handleEdit(comment: CommentDto, body: string): Promise<boolean> {
    const trimmed = body.trim()
    if (trimmed.length === 0 || trimmed === comment.body) return true
    try {
      await updateComment(listId, itemId, comment.id, trimmed)
      await load()
      return true
    } catch (err) {
      reportError(err, 'Failed to edit comment.')
      return false
    }
  }

  async function handleDelete(comment: CommentDto) {
    if (!window.confirm('Delete this comment?')) return
    try {
      await deleteComment(listId, itemId, comment.id)
      await load()
      toast({ tone: 'success', body: 'Comment deleted.' })
    } catch (err) {
      reportError(err, 'Failed to delete comment.')
    }
  }

  const now = Date.now()

  return (
    <Drawer open={open} onClose={onClose} title={`Comments · "${itemTitle}"`} width={420}>
      <div className="space-y-4">
        <form onSubmit={(e) => void handlePost(e)} className="space-y-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Add a comment…"
            rows={3}
            maxLength={4000}
            className="cyber-input w-full"
            style={{ resize: 'vertical' }}
          />
          <Button variant="brutal" type="submit" disabled={posting || draft.trim().length === 0}>
            {posting ? 'Posting…' : 'Comment'}
          </Button>
        </form>

        {state.status === LOADING && (
          <p className="text-sm text-[color:var(--ink-dim)]">Loading…</p>
        )}
        {state.status === ERROR && (
          <p className="text-sm" style={{ color: 'var(--hot)' }}>
            {state.message}
          </p>
        )}
        {state.status === READY && state.comments.length === 0 && (
          <p className="text-sm text-[color:var(--ink-dim)]">No comments yet.</p>
        )}
        {state.status === READY && state.comments.length > 0 && (
          <ul className="space-y-3">
            {state.comments.map((comment) => (
              <CommentRow
                key={comment.id}
                comment={comment}
                now={now}
                canManage={canManageComment(comment.author_id, selfUserId)}
                onEdit={(body) => handleEdit(comment, body)}
                onDelete={() => void handleDelete(comment)}
              />
            ))}
          </ul>
        )}
      </div>
    </Drawer>
  )
}

interface CommentRowProps {
  comment: CommentDto
  now: number
  canManage: boolean
  onEdit: (body: string) => Promise<boolean>
  onDelete: () => void
}

function CommentRow({ comment, now, canManage, onEdit, onDelete }: CommentRowProps) {
  const [editing, setEditing] = useState(false)
  const [body, setBody] = useState(comment.body)

  useEffect(() => {
    setBody(comment.body)
  }, [comment.body])

  const edited = comment.updated_at !== comment.created_at

  return (
    <li
      className="space-y-1 px-3 py-2"
      style={{ border: '1.5px solid var(--line)', background: 'var(--surface)' }}
    >
      <div className="flex items-center justify-between gap-2 text-xs" style={{ color: 'var(--ink-dim)' }}>
        <span className="truncate font-semibold" title={comment.author_id}>
          {comment.author_id}
        </span>
        <span className="shrink-0">
          {relativeTime(comment.created_at, now)}
          {edited && ' · edited'}
        </span>
      </div>

      {editing ? (
        <div className="space-y-2">
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={3}
            maxLength={4000}
            className="cyber-input w-full"
            style={{ resize: 'vertical' }}
          />
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              onClick={() => {
                void onEdit(body).then((ok) => {
                  if (ok) setEditing(false)
                })
              }}
            >
              Save
            </Button>
            <button
              type="button"
              onClick={() => {
                setBody(comment.body)
                setEditing(false)
              }}
              className="text-xs underline"
              style={{ color: 'var(--ink-dim)' }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <p className="whitespace-pre-wrap text-sm" style={{ color: 'var(--ink)' }}>
          {comment.body}
        </p>
      )}

      {canManage && !editing && (
        <div className="flex items-center gap-3 text-xs">
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="underline"
            style={{ color: 'var(--ink-dim)' }}
          >
            Edit
          </button>
          <button
            type="button"
            onClick={onDelete}
            className="underline"
            style={{ color: 'var(--hot)' }}
          >
            Delete
          </button>
        </div>
      )}
    </li>
  )
}

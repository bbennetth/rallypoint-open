import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Drawer } from '@rallypoint/ui'
import {
  ApiError,
  createNote,
  deleteNote,
  listNotes,
  updateNote,
  type NoteDto,
} from '../lib/api.js'
import { splitQuickNote, resolveNoteTitle } from '../lib/planner-helpers.js'
import { onCreated } from '../lib/refresh-bus.js'
import { Icon } from '../ui/icons.js'

// Quick Notes surface. Notes are stored in Lists as items of a hidden per-user
// `notes` list (resolved by the notes BFF) — a note's first line is its title
// and the rest is the body. A thin view over the BFF: list / jot / delete / edit.
// Listens on the refresh-bus so a note added from the global quick-add FAB
// shows up here without a manual reload.

function errMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message
  return 'Something went wrong. Please try again.'
}

function dateLabel(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function NotesPage() {
  const [notes, setNotes] = useState<NoteDto[]>([])
  const [text, setText] = useState('')
  const [viewing, setViewing] = useState<NoteDto | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  // Draft fields for the open drawer — kept in sync when `viewing` changes.
  const [editTitle, setEditTitle] = useState('')
  const [editBody, setEditBody] = useState('')
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setNotes(await listNotes())
    } catch (err) {
      setError(errMessage(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // A note added via the global FAB while this page is open should appear.
  useEffect(() => onCreated('note', () => void refresh()), [refresh])

  // Seed the edit fields when the drawer opens a note.
  useEffect(() => {
    if (viewing) {
      setEditTitle(viewing.title)
      setEditBody(viewing.notes ?? '')
    }
  }, [viewing?.id]) // only re-seed when the *note* changes, not on field edits

  // Clear pending save timer on unmount.
  useEffect(
    () => () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    },
    [],
  )

  async function onCreate(e: FormEvent) {
    e.preventDefault()
    const note = splitQuickNote(text)
    if (!note || busy) return
    setBusy(true)
    setError(null)
    try {
      const created = await createNote(note)
      setNotes((cur) => [created, ...cur])
      setText('')
    } catch (err) {
      setError(errMessage(err))
    } finally {
      setBusy(false)
    }
  }

  async function onDelete(id: string) {
    const prev = notes
    setNotes((cur) => cur.filter((n) => n.id !== id))
    setViewing((cur) => (cur?.id === id ? null : cur))
    try {
      await deleteNote(id)
    } catch (err) {
      setError(errMessage(err))
      setNotes(prev)
    }
  }

  function showToast(msg: string) {
    setToast(msg)
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    toastTimerRef.current = setTimeout(() => setToast(null), 2000)
  }

  // Persist current edit fields for the open note. Called on blur (with debounce)
  // and directly on close so we don't lose the last keystroke.
  async function saveEdits(id: string, title: string, body: string) {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    const resolvedTitle = resolveNoteTitle(title, body)
    const patch: { title?: string; notes?: string | null } = {
      title: resolvedTitle,
      notes: body.trim() || null,
    }
    try {
      const updated = await updateNote(id, patch)
      setNotes((cur) => cur.map((n) => (n.id === id ? updated : n)))
      setViewing((cur) => (cur?.id === id ? updated : cur))
      showToast('Saved')
    } catch (err) {
      setError(errMessage(err))
    }
  }

  function scheduleSave(id: string, title: string, body: string) {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      void saveEdits(id, title, body)
    }, 500)
  }

  return (
    <>
      <div className="pg-head">
        <div>
          <div className="eyebrow">Notes</div>
          <h1>Quick notes</h1>
          <div className="sub">Jot something down — the first line becomes the title.</div>
        </div>
      </div>

      <form
        className="pl-card"
        style={{ padding: 12, display: 'grid', gap: 10, maxWidth: 640 }}
        onSubmit={onCreate}
      >
        <textarea
          className="pl-input"
          style={{ resize: 'vertical', minHeight: 96, lineHeight: 1.5 }}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Write a note…"
          aria-label="New note"
          rows={4}
        />
        {error && <p role="alert" className="pl-fab-error">{error}</p>}
        <div>
          <button className="pl-btn" type="submit" disabled={busy || splitQuickNote(text) === null}>
            <Icon name="plus" size={13} />
            Save note
          </button>
        </div>
      </form>

      <div style={{ display: 'grid', gap: 10, maxWidth: 640, marginTop: 14 }}>
        {loading ? (
          <p className="pl-fab-hint">Loading notes…</p>
        ) : notes.length === 0 ? (
          <p className="pl-fab-hint">No notes yet. Jot your first one above.</p>
        ) : (
          notes.map((n) => (
            <div key={n.id} className="pl-card pl-note">
              <div className="pl-note-title" title={n.title}>
                {n.title}
              </div>
              <div className="pl-note-meta">
                <span className="pl-note-date">{dateLabel(n.createdAt)}</span>
                <button
                  type="button"
                  className="pl-btn ghost pl-note-view"
                  onClick={() => setViewing(n)}
                >
                  View
                </button>
                <button
                  type="button"
                  className="pl-note-del"
                  aria-label="Delete note"
                  onClick={() => onDelete(n.id)}
                >
                  ×
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      <Drawer
        open={viewing !== null}
        onClose={() => {
          // Flush edits before closing — autosave fires on blur, but closing
          // the drawer (backdrop/button) without first blurring an input would
          // otherwise drop the change. Save whenever the content is dirty.
          if (viewing) {
            const dirty =
              editTitle !== viewing.title || editBody !== (viewing.notes ?? '')
            if (dirty) {
              void saveEdits(viewing.id, editTitle, editBody)
            } else if (saveTimerRef.current) {
              clearTimeout(saveTimerRef.current)
              saveTimerRef.current = null
            }
          }
          setViewing(null)
        }}
        title="Note"
        mobileSheet
      >
        {viewing && (
          <div style={{ display: 'grid', gap: 12 }}>
            <input
              className="pl-input"
              style={{ fontWeight: 600 }}
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              onBlur={() => scheduleSave(viewing.id, editTitle, editBody)}
              placeholder="Title"
              aria-label="Note title"
            />
            <textarea
              className="pl-input pl-note-text"
              style={{ resize: 'vertical', minHeight: 120, lineHeight: 1.5 }}
              value={editBody}
              onChange={(e) => setEditBody(e.target.value)}
              onBlur={() => scheduleSave(viewing.id, editTitle, editBody)}
              placeholder="Note body…"
              aria-label="Note body"
              rows={5}
            />
            <div className="pl-note-date">{dateLabel(viewing.createdAt)}</div>
            <div>
              <button
                type="button"
                className="pl-btn ghost"
                onClick={() => onDelete(viewing.id)}
              >
                Delete note
              </button>
            </div>
          </div>
        )}
      </Drawer>

      {toast && <div className="pl-toast">{toast}</div>}
    </>
  )
}

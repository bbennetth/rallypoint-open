import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Drawer } from '@rallypoint/ui'
import {
  ApiError,
  createNoteFolder,
  deleteNote,
  deleteNoteFolder,
  listNoteFolders,
  listNotes,
  moveNote,
  updateNote,
  type NoteDto,
  type NoteFolderDto,
} from '../lib/api.js'
import { countNotesByFolder, orderFolders, resolveNoteTitle } from '../lib/planner-helpers.js'
import { onCreated } from '../lib/refresh-bus.js'
import { Icon } from '../ui/icons.js'
import { SkeletonRows } from '../ui/Skeleton.js'

// Quick Notes surface. Notes are stored in Lists as items of hidden per-user
// `notes` lists (resolved by the notes BFF). Since #549 notes live in FOLDERS
// (each folder is a notes list); a folder rail filters the view, notes can be
// moved between folders, and empty non-default folders can be deleted. A
// note's first line is its title and the rest is the body. Listens on the
// refresh-bus so a note added from the global quick-add FAB shows up here.

function errMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message
  return 'Something went wrong. Please try again.'
}

function dateLabel(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

// `null` = the "All notes" pseudo-folder (cross-folder view).
type FolderFilter = string | null

export function NotesPage() {
  const [notes, setNotes] = useState<NoteDto[]>([])
  const [folders, setFolders] = useState<NoteFolderDto[]>([])
  const [activeFolder, setActiveFolder] = useState<FolderFilter>(null)
  const [viewing, setViewing] = useState<NoteDto | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [newFolderName, setNewFolderName] = useState('')
  const [creatingFolder, setCreatingFolder] = useState(false)
  const [foldersOpen, setFoldersOpen] = useState(false)

  // Draft fields for the open drawer — kept in sync when `viewing` changes.
  const [editTitle, setEditTitle] = useState('')
  const [editBody, setEditBody] = useState('')
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const [n, f] = await Promise.all([listNotes(), listNoteFolders()])
      setNotes(n)
      setFolders(f)
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

  // Clear pending timers on unmount.
  useEffect(
    () => () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    },
    [],
  )

  function showToast(msg: string) {
    setToast(msg)
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    toastTimerRef.current = setTimeout(() => setToast(null), 2000)
  }

  const orderedFolders = orderFolders(folders)
  const counts = countNotesByFolder(notes)
  const visibleNotes = activeFolder === null ? notes : notes.filter((n) => n.folderId === activeFolder)
  const defaultFolderId = folders.find((f) => f.isDefault)?.id ?? null

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

  async function onCreateFolder(e: FormEvent) {
    e.preventDefault()
    const name = newFolderName.trim()
    if (!name || creatingFolder) return
    setCreatingFolder(true)
    setError(null)
    try {
      const folder = await createNoteFolder(name)
      setFolders((cur) => [...cur, folder])
      setNewFolderName('')
      setActiveFolder(folder.id)
    } catch (err) {
      setError(errMessage(err))
    } finally {
      setCreatingFolder(false)
    }
  }

  async function onDeleteFolder(folderId: string) {
    setError(null)
    try {
      await deleteNoteFolder(folderId)
      setFolders((cur) => cur.filter((f) => f.id !== folderId))
      if (activeFolder === folderId) setActiveFolder(null)
    } catch (err) {
      setError(errMessage(err))
    }
  }

  async function onMove(id: string, folderId: string) {
    setError(null)
    try {
      const moved = await moveNote(id, folderId)
      setNotes((cur) => cur.map((n) => (n.id === id ? moved : n)))
      setViewing((cur) => (cur?.id === id ? moved : cur))
      showToast('Moved')
    } catch (err) {
      setError(errMessage(err))
    }
  }

  // Persist current edit fields for the open note (debounced on blur, flushed on close).
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
        </div>
        <button
          type="button"
          className="pl-iconbtn"
          aria-label="Manage folders"
          title="Manage folders"
          onClick={() => setFoldersOpen(true)}
        >
          <Icon name="gear" size={15} />
        </button>
      </div>

      {error && (
        <p role="alert" style={{ color: 'var(--hot)', fontSize: 13, marginTop: 0 }}>
          {error}
        </p>
      )}

      {/* Folder filter rail (create/delete moved to the gear → Manage folders) */}
      <div className="pl-note-folders" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
        <button
          type="button"
          className={`pl-btn ghost${activeFolder === null ? ' active' : ''}`}
          onClick={() => setActiveFolder(null)}
        >
          All notes ({notes.length})
        </button>
        {orderedFolders.map((f) => (
          <button
            key={f.id}
            type="button"
            className={`pl-btn ghost${activeFolder === f.id ? ' active' : ''}`}
            onClick={() => setActiveFolder(f.id)}
          >
            {f.name} ({counts[f.id] ?? 0})
          </button>
        ))}
      </div>

      <div style={{ display: 'grid', gap: 10, maxWidth: 640 }}>
        {loading ? (
          <SkeletonRows count={5} height={48} label="Loading notes" />
        ) : visibleNotes.length === 0 ? (
          <p className="pl-fab-hint">No notes here yet. Use the + button to add one.</p>
        ) : (
          visibleNotes.map((n) => (
            <div key={n.id} className="pl-card pl-note">
              <div className="pl-note-title" title={n.title}>
                {n.title}
              </div>
              <div className="pl-note-meta">
                <span className="pl-note-date">{dateLabel(n.createdAt)}</span>
                <button
                  type="button"
                  className="pl-btn ghost sm"
                  onClick={() => setViewing(n)}
                >
                  View
                </button>
                <button
                  type="button"
                  className="pl-iconbtn danger"
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
          if (viewing) {
            const dirty = editTitle !== viewing.title || editBody !== (viewing.notes ?? '')
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
            {folders.length > 1 && (
              <label style={{ display: 'grid', gap: 4 }}>
                <span className="pl-note-date">Folder</span>
                <select
                  className="pl-input"
                  value={viewing.folderId}
                  aria-label="Move to folder"
                  onChange={(e) => void onMove(viewing.id, e.target.value)}
                >
                  {orderedFolders.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                      {f.id === defaultFolderId ? ' (default)' : ''}
                    </option>
                  ))}
                </select>
              </label>
            )}
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

      <Drawer
        open={foldersOpen}
        onClose={() => setFoldersOpen(false)}
        title="Manage folders"
        mobileSheet
      >
        <div style={{ display: 'grid', gap: 14 }}>
          <form onSubmit={onCreateFolder} style={{ display: 'flex', gap: 8 }}>
            <input
              className="pl-input"
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              placeholder="New folder…"
              aria-label="New folder name"
            />
            <button
              className="pl-btn grow"
              type="submit"
              disabled={creatingFolder || !newFolderName.trim()}
            >
              <Icon name="plus" size={13} />
              Add
            </button>
          </form>

          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 6 }}>
            {orderedFolders.map((f) => (
              <li
                key={f.id}
                className="pl-row"
                style={{ gridTemplateColumns: '1fr auto', alignItems: 'center', gap: 8 }}
              >
                <span style={{ fontSize: 14, color: 'var(--ink)', display: 'flex', alignItems: 'center', gap: 8 }}>
                  {f.name}
                  <span className="meta" style={{ color: 'var(--ink-mute)' }}>
                    {counts[f.id] ?? 0}
                  </span>
                  {f.isDefault && <span className="pl-chip">Default</span>}
                </span>
                {!f.isDefault && (counts[f.id] ?? 0) === 0 && (
                  <button
                    type="button"
                    className="pl-iconbtn danger"
                    aria-label={`Delete folder ${f.name}`}
                    title="Delete empty folder"
                    onClick={() => onDeleteFolder(f.id)}
                  >
                    ×
                  </button>
                )}
              </li>
            ))}
          </ul>
          <p className="meta" style={{ color: 'var(--ink-mute)' }}>
            Only empty, non-default folders can be deleted.
          </p>
        </div>
      </Drawer>

      {toast && <div className="pl-toast">{toast}</div>}
    </>
  )
}

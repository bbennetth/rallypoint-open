import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { useBlocker } from 'react-router-dom'
import { ConfirmDialog, Drawer, SubBar, SubBarSeg } from '@rallypoint/ui'
import {
  ApiError,
  createNoteFolder,
  deleteNote,
  deleteNoteFolder,
  deletedNotesQuery,
  noteFoldersQuery,
  notesQuery,
  restoreNote,
  updateNote,
  type DeletedNoteDto,
  type NoteDto,
  type NoteFolderDto,
} from '../lib/api.js'
import { useCachedQuery } from '../lib/offline/use-cached-query.js'
import { countNotesByFolder, orderFolders, resolveNoteTitle } from '../lib/planner-helpers.js'
import { onCreated } from '../lib/refresh-bus.js'
import { Check } from '../ui/bits.js'
import { Icon } from '../ui/icons.js'
import { SkeletonRows } from '../ui/Skeleton.js'
import { QuickAdd } from '../ui/QuickAdd.js'

type FolderFilter = string | null
type NotesView = 'active' | 'closed' | 'deleted'

// Mirrors the server's ITEM_RESTORE_GRACE_MS (apps/lists-api/src/lib/item-restore.ts).
// Kept as a local literal rather than imported across the app boundary; the
// Deleted view only needs it to show an approximate countdown.
const RESTORE_GRACE_DAYS = 30

function errMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message
  return 'Something went wrong. Please try again.'
}

function dateLabel(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

// Whole days left in the 30-day restore window for a note deleted at `iso`.
// Clamped at 0; the server is the source of truth on the exact cutoff.
function restoreDaysLeft(iso: string): number {
  const deleted = new Date(iso)
  if (Number.isNaN(deleted.getTime())) return 0
  const expires = deleted.getTime() + RESTORE_GRACE_DAYS * 24 * 60 * 60 * 1000
  return Math.max(0, Math.ceil((expires - Date.now()) / (24 * 60 * 60 * 1000)))
}

function daysLeftLabel(iso: string): string {
  const n = restoreDaysLeft(iso)
  return n === 1 ? '1 day left' : `${n} days left`
}

function liveNote(note: NoteDto): NoteDto {
  // Cached DTOs from before completed notes shipped do not carry these two
  // fields. Normalize at the page boundary so an app upgrade treats them as
  // active notes rather than hiding them from both views.
  return {
    ...note,
    completed: note.completed ?? false,
    completedAt: note.completedAt ?? null,
  }
}

export function NotesPage() {
  const notesQ = useCachedQuery(useMemo(() => notesQuery(), []))
  const deletedQ = useCachedQuery(useMemo(() => deletedNotesQuery(), []))
  const foldersQ = useCachedQuery(useMemo(() => noteFoldersQuery(), []))

  const notes = useMemo(() => (notesQ.data ?? []).map(liveNote), [notesQ.data])
  const deletedNotes = deletedQ.data ?? []
  const [folders, setFolders] = useState<NoteFolderDto[]>([])
  useEffect(() => setFolders(foldersQ.data ?? []), [foldersQ.data])

  const [view, setView] = useState<NotesView>('active')
  const [activeFolder, setActiveFolder] = useState<FolderFilter>(null)
  const [viewing, setViewing] = useState<NoteDto | null>(null)
  const [deletedViewing, setDeletedViewing] = useState<DeletedNoteDto | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [editBody, setEditBody] = useState('')
  const [editFolderId, setEditFolderId] = useState('')
  const [saving, setSaving] = useState(false)
  const [unsavedOpen, setUnsavedOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [newFolderName, setNewFolderName] = useState('')
  const [creatingFolder, setCreatingFolder] = useState(false)
  const [foldersOpen, setFoldersOpen] = useState(false)
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (notesQ.status === 'error') setError(errMessage(notesQ.error))
    else if (deletedQ.status === 'error') setError(errMessage(deletedQ.error))
    else if (foldersQ.status === 'error') setError(errMessage(foldersQ.error))
  }, [
    notesQ.status,
    notesQ.error,
    deletedQ.status,
    deletedQ.error,
    foldersQ.status,
    foldersQ.error,
  ])

  const refetchNotes = notesQ.refetch
  const refetchDeleted = deletedQ.refetch
  const refetchFolders = foldersQ.refetch
  useEffect(
    () =>
      onCreated('note', () => {
        void Promise.all([refetchNotes(), refetchDeleted(), refetchFolders()])
      }),
    [refetchNotes, refetchDeleted, refetchFolders],
  )

  useEffect(
    () => () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    },
    [],
  )

  function showToast(msg: string) {
    setToast(msg)
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    toastTimerRef.current = setTimeout(() => setToast(null), 2000)
  }

  function openNote(note: NoteDto) {
    const normalized = liveNote(note)
    setViewing(normalized)
    setEditTitle(normalized.title)
    setEditBody(normalized.notes ?? '')
    setEditFolderId(normalized.folderId)
    setError(null)
  }

  const dirty =
    viewing !== null &&
    (editTitle !== viewing.title ||
      editBody !== (viewing.notes ?? '') ||
      editFolderId !== viewing.folderId)

  // Warn before a hard unload (tab close / refresh) with unsaved editor edits.
  useEffect(() => {
    if (!dirty) return
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [dirty])

  // Block in-app navigation (nav bar / links) while the editor is dirty and
  // route the decision through the same Save / Discard / Go back prompt.
  const blocker = useBlocker(dirty)
  const blocking = blocker.state === 'blocked'

  function closeEditor() {
    setUnsavedOpen(false)
    setViewing(null)
  }

  function requestCloseEditor() {
    if (saving) return
    if (dirty) setUnsavedOpen(true)
    else closeEditor()
  }

  // The title/body/folder deltas between the edit fields and `base`. Shared by
  // Save and by a dirty Close/Reopen so both persist the same staged changes.
  function buildEditPatch(base: NoteDto): {
    patch: { title?: string; notes?: string | null; folderId?: string }
    title: string
    body: string | null
  } {
    const title = resolveNoteTitle(editTitle, editBody).slice(0, 200)
    const body = editBody.trim() || null
    const patch: { title?: string; notes?: string | null; folderId?: string } = {}
    if (title !== base.title) patch.title = title
    if (body !== base.notes) patch.notes = body
    if (editFolderId !== base.folderId) patch.folderId = editFolderId
    return { patch, title, body }
  }

  // Returns true when the note is saved (or there was nothing to save), false
  // when the write failed — the navigation blocker uses this to decide whether
  // to proceed or stay put.
  async function saveEdits(closeAfter = false): Promise<boolean> {
    if (!viewing || saving) return false
    if (!dirty) {
      if (closeAfter) closeEditor()
      return true
    }
    setSaving(true)
    setError(null)
    try {
      const { patch, title, body } = buildEditPatch(viewing)
      const updated =
        Object.keys(patch).length > 0
          ? liveNote(await updateNote(viewing.id, patch))
          : { ...viewing, title, notes: body }
      setViewing(updated)
      setEditTitle(updated.title)
      setEditBody(updated.notes ?? '')
      setEditFolderId(updated.folderId)
      void refetchNotes()
      showToast('Saved')
      if (closeAfter) closeEditor()
      return true
    } catch (err) {
      setError(errMessage(err))
      setUnsavedOpen(false)
      return false
    } finally {
      setSaving(false)
    }
  }

  async function onToggle(note: NoteDto) {
    if (saving) return
    const fromEditor = viewing?.id === note.id
    const withEdits = fromEditor && dirty
    setSaving(true)
    setError(null)
    try {
      const patch: {
        title?: string
        notes?: string | null
        folderId?: string
        completed?: boolean
      } = { completed: !note.completed }
      // Toggling from the open editor while dirty persists the staged edits in
      // the same request so the text isn't silently left unsaved.
      if (withEdits && viewing) Object.assign(patch, buildEditPatch(viewing).patch)
      const updated = liveNote(await updateNote(note.id, patch))
      if (fromEditor) {
        setViewing(updated)
        setEditTitle(updated.title)
        setEditBody(updated.notes ?? '')
        setEditFolderId(updated.folderId)
      }
      void refetchNotes()
      const state = updated.completed ? 'Note closed' : 'Note reopened'
      showToast(withEdits ? `Saved · ${state}` : state)
    } catch (err) {
      setError(errMessage(err))
    } finally {
      setSaving(false)
    }
  }

  async function onDelete(note: NoteDto) {
    setError(null)
    if (viewing?.id === note.id) closeEditor()
    try {
      await deleteNote(note.id)
      void Promise.all([refetchNotes(), refetchDeleted()])
      showToast('Moved to Deleted')
    } catch (err) {
      setError(errMessage(err))
    }
  }

  async function onRestore(note: DeletedNoteDto) {
    setError(null)
    try {
      const restored = await restoreNote(note.id)
      if (deletedViewing?.id === note.id) setDeletedViewing(null)
      void Promise.all([refetchNotes(), refetchDeleted()])
      const folderName = folders.find((folder) => folder.id === restored.folderId)?.name
      showToast(folderName ? `Restored to ${folderName}` : 'Note restored')
    } catch (err) {
      setError(errMessage(err))
    }
  }

  // Unsaved-changes prompt actions, shared by the drawer-close path
  // (`unsavedOpen`) and the in-app navigation blocker (`blocking`).
  async function onPromptSave() {
    const saved = await saveEdits(!blocking)
    if (blocking) {
      if (saved) blocker.proceed?.()
      else blocker.reset?.()
    }
  }

  function onPromptDiscard() {
    closeEditor()
    if (blocking) blocker.proceed?.()
  }

  function onPromptGoBack() {
    if (blocking) blocker.reset?.()
    else setUnsavedOpen(false)
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
      setFolders((cur) => cur.filter((folder) => folder.id !== folderId))
      if (activeFolder === folderId) setActiveFolder(null)
    } catch (err) {
      setError(errMessage(err))
    }
  }

  const orderedFolders = orderFolders(folders)
  const folderById = new Map(folders.map((folder) => [folder.id, folder]))
  const defaultFolderId = folders.find((folder) => folder.isDefault)?.id ?? null
  const notesForView = notes.filter((note) =>
    view === 'closed' ? note.completed : !note.completed,
  )
  const counts = countNotesByFolder(notesForView)
  const allLiveCounts = countNotesByFolder(notes)
  const deletedCounts = countNotesByFolder(deletedNotes)
  const visibleNotes =
    activeFolder === null
      ? notesForView
      : notesForView.filter((note) => note.folderId === activeFolder)
  const loading = view === 'deleted' ? deletedQ.status === 'loading' : notesQ.status === 'loading'

  return (
    <>
      <div className="pg-head pl-wide">
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

      <SubBar label="Notes view" fab={<QuickAdd anchor="subbar" />}>
        <SubBarSeg active={view === 'active'} onClick={() => setView('active')}>
          Active
        </SubBarSeg>
        <SubBarSeg active={view === 'closed'} onClick={() => setView('closed')}>
          Closed
        </SubBarSeg>
        <SubBarSeg active={view === 'deleted'} onClick={() => setView('deleted')}>
          Deleted
        </SubBarSeg>
      </SubBar>

      {error && (
        <p role="alert" style={{ color: 'var(--hot)', fontSize: 13, marginTop: 0 }}>
          {error}
        </p>
      )}

      {view !== 'deleted' && (
        <div className="pl-note-folders">
          <button
            type="button"
            className={`pl-btn ghost${activeFolder === null ? ' active' : ''}`}
            onClick={() => setActiveFolder(null)}
          >
            All notes ({notesForView.length})
          </button>
          {orderedFolders.map((folder) => (
            <button
              key={folder.id}
              type="button"
              className={`pl-btn ghost${activeFolder === folder.id ? ' active' : ''}`}
              onClick={() => setActiveFolder(folder.id)}
            >
              {folder.name} ({counts[folder.id] ?? 0})
            </button>
          ))}
        </div>
      )}

      <div className="nt-list">
        {loading ? (
          <SkeletonRows count={5} height={48} label="Loading notes" />
        ) : view === 'deleted' ? (
          deletedNotes.length === 0 ? (
            <p className="pl-fab-hint">No deleted notes. Deleted notes remain restorable for 30 days.</p>
          ) : (
            deletedNotes.map((note) => (
              <div
                key={note.id}
                role="button"
                tabIndex={0}
                className="pl-card pl-note"
                style={{ cursor: 'pointer' }}
                onClick={() => setDeletedViewing(note)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    setDeletedViewing(note)
                  }
                }}
              >
                <span aria-hidden style={{ display: 'inline-flex', color: 'var(--ink-mute)' }}>
                  <Icon name="file" size={15} />
                </span>
                <div className="pl-note-title" title={note.title}>
                  {note.title}
                </div>
                <div className="pl-note-meta">
                  <span className="pl-note-date">
                    {folderById.get(note.folderId)?.name ?? 'Notes'} · {dateLabel(note.deletedAt)}{' '}
                    · {daysLeftLabel(note.deletedAt)}
                  </span>
                  <button
                    type="button"
                    className="pl-btn ghost"
                    onClick={(e) => {
                      e.stopPropagation()
                      void onRestore(note)
                    }}
                  >
                    Restore
                  </button>
                </div>
              </div>
            ))
          )
        ) : visibleNotes.length === 0 ? (
          <p className="pl-fab-hint">
            {view === 'closed'
              ? 'No closed notes here.'
              : 'No active notes here yet. Use the + button to add one.'}
          </p>
        ) : (
          visibleNotes.map((note) => (
            <div
              key={note.id}
              role="button"
              tabIndex={0}
              className="pl-card pl-note"
              style={{ cursor: 'pointer' }}
              onClick={() => openNote(note)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  openNote(note)
                }
              }}
            >
              <span onClick={(e) => e.stopPropagation()}>
                <Check
                  done={note.completed}
                  onClick={() => void onToggle(note)}
                  sz={18}
                  label={note.completed ? `Reopen note ${note.title}` : `Close note ${note.title}`}
                />
              </span>
              <div
                className="pl-note-title"
                title={note.title}
                style={{ textDecoration: note.completed ? 'line-through' : 'none' }}
              >
                {note.title}
              </div>
              <div className="pl-note-meta">
                <span className="pl-note-date">{dateLabel(note.createdAt)}</span>
                <button
                  type="button"
                  className="pl-iconbtn danger"
                  aria-label="Delete note"
                  onClick={(e) => {
                    e.stopPropagation()
                    void onDelete(note)
                  }}
                >
                  ×
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      <Drawer open={viewing !== null} onClose={requestCloseEditor} title="Note" mobileSheet>
        {viewing && (
          <div style={{ display: 'grid', gap: 12 }}>
            <input
              className="pl-input"
              style={{ fontWeight: 600 }}
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              placeholder="Title"
              aria-label="Note title"
              maxLength={200}
            />
            <textarea
              className="pl-input pl-note-text"
              style={{ resize: 'vertical', minHeight: 120, lineHeight: 1.5 }}
              value={editBody}
              onChange={(e) => setEditBody(e.target.value)}
              placeholder="Note body…"
              aria-label="Note body"
              rows={5}
              maxLength={2000}
            />
            {folders.length > 1 && (
              <label style={{ display: 'grid', gap: 4 }}>
                <span className="pl-note-date">Folder</span>
                <select
                  className="pl-input"
                  value={editFolderId}
                  aria-label="Move to folder"
                  onChange={(e) => setEditFolderId(e.target.value)}
                >
                  {orderedFolders.map((folder) => (
                    <option key={folder.id} value={folder.id}>
                      {folder.name}
                      {folder.id === defaultFolderId ? ' (default)' : ''}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <div className="pl-note-date">{dateLabel(viewing.createdAt)}</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button
                type="button"
                className="pl-btn grow"
                disabled={!dirty || saving}
                onClick={() => void saveEdits()}
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
              <button
                type="button"
                className="pl-btn ghost"
                disabled={saving}
                onClick={() => void onToggle(viewing)}
              >
                {viewing.completed ? 'Reopen note' : 'Close note'}
              </button>
              <button
                type="button"
                className="pl-btn ghost"
                disabled={saving}
                onClick={() => void onDelete(viewing)}
              >
                Delete note
              </button>
            </div>
          </div>
        )}
      </Drawer>

      <ConfirmDialog
        open={unsavedOpen || blocking}
        title="Unsaved changes"
        body="Save your changes before closing this note?"
        confirmLabel="Save"
        cancelLabel="Go back"
        onConfirm={onPromptSave}
        onCancel={onPromptGoBack}
        extraAction={{
          label: 'Discard edits',
          variant: 'hot',
          onAction: onPromptDiscard,
        }}
        busy={saving}
      />

      <Drawer
        open={deletedViewing !== null}
        onClose={() => setDeletedViewing(null)}
        title="Deleted note"
        mobileSheet
      >
        {deletedViewing && (
          <div style={{ display: 'grid', gap: 12 }}>
            <h3 style={{ margin: 0 }}>{deletedViewing.title}</h3>
            {deletedViewing.notes && (
              <p style={{ margin: 0, whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>
                {deletedViewing.notes}
              </p>
            )}
            <div className="pl-note-date">
              {folderById.get(deletedViewing.folderId)?.name ?? 'Notes'} · Deleted{' '}
              {dateLabel(deletedViewing.deletedAt)} · {daysLeftLabel(deletedViewing.deletedAt)}
              {deletedViewing.completed ? ' · Closed' : ''}
            </div>
            <div>
              <button
                type="button"
                className="pl-btn grow"
                onClick={() => void onRestore(deletedViewing)}
              >
                Restore note
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
            {orderedFolders.map((folder) => {
              const liveCount = allLiveCounts[folder.id] ?? 0
              const deletedCount = deletedCounts[folder.id] ?? 0
              return (
                <li
                  key={folder.id}
                  className="pl-row"
                  style={{ gridTemplateColumns: '1fr auto', alignItems: 'center', gap: 8 }}
                >
                  <span
                    style={{
                      fontSize: 14,
                      color: 'var(--ink)',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                    }}
                  >
                    {folder.name}
                    <span className="meta" style={{ color: 'var(--ink-mute)' }}>
                      {liveCount}
                      {deletedCount > 0 ? ` + ${deletedCount} deleted` : ''}
                    </span>
                    {folder.isDefault && <span className="pl-chip">Default</span>}
                  </span>
                  {!folder.isDefault && liveCount === 0 && deletedCount === 0 && (
                    <button
                      type="button"
                      className="pl-iconbtn danger"
                      aria-label={`Delete folder ${folder.name}`}
                      title="Delete empty folder"
                      onClick={() => void onDeleteFolder(folder.id)}
                    >
                      ×
                    </button>
                  )}
                </li>
              )
            })}
          </ul>
          <p className="meta" style={{ color: 'var(--ink-mute)' }}>
            Only non-default folders without active, closed, or restorable deleted notes can be
            deleted.
          </p>
        </div>
      </Drawer>

      {toast && <div className="pl-toast">{toast}</div>}
    </>
  )
}

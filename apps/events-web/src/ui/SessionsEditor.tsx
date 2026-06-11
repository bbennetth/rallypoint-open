import { useEffect, useMemo, useState } from 'react'
import {
  ApiError,
  bulkApplySessions,
  createSession,
  deleteSession,
  listDays,
  listSessions,
  setSessionApproval,
  type BulkSessionCreate,
  type DayDto,
  type SessionApprovalStatus,
  type SessionDtoFull,
  type SessionVisibility,
} from '../lib/api.js'
import { SnapshotHistory } from './SnapshotHistory.js'
import { CsvImportPanel, type CsvPreview } from './CsvImportPanel.js'
import { planSessionsImport, sessionsTemplateCsv } from '../lib/sessions-csv.js'

// --- Bulk grid types --------------------------------------------------

interface DraftRow {
  /** Stable local key (not sent to server for new rows) */
  key: string
  /** Undefined = new row (create), string = existing session id (update) */
  existingId?: string
  title: string
  description: string
  location: string
  category: string
  host: string
  dayId: string
  startTime: string
  endTime: string
  visibility: SessionVisibility
  /** Marked for deletion — only valid when existingId is set */
  pendingDelete: boolean
}

function rowFromSession(s: SessionDtoFull): DraftRow {
  return {
    key: s.id,
    existingId: s.id,
    title: s.title,
    description: s.description ?? '',
    location: s.location ?? '',
    category: s.category ?? '',
    host: s.host ?? '',
    dayId: s.day_id ?? '',
    startTime: s.start_time ?? '',
    endTime: s.end_time ?? '',
    visibility: s.visibility,
    pendingDelete: false,
  }
}

function emptyDraftRow(): DraftRow {
  return {
    key: `new_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    title: '',
    description: '',
    location: '',
    category: '',
    host: '',
    dayId: '',
    startTime: '',
    endTime: '',
    visibility: 'group',
    pendingDelete: false,
  }
}

// Diff the draft grid against the loaded sessions into the bulk-apply
// payload. Shared by the Save handler and the dirty-check so the button's
// enabled state and the actual save use the exact same notion of "changed".
function computeBulkOps(draftRows: DraftRow[], sessions: SessionDtoFull[]) {
  const creates: BulkSessionCreate[] = draftRows
    .filter((r) => !r.existingId && !r.pendingDelete && r.title.trim().length > 0)
    .map((r) => ({
      title: r.title.trim(),
      ...(r.description.trim() ? { description: r.description.trim() } : {}),
      ...(r.location.trim() ? { location: r.location.trim() } : {}),
      ...(r.category.trim() ? { category: r.category.trim() } : {}),
      ...(r.host.trim() ? { host: r.host.trim() } : {}),
      ...(r.dayId ? { dayId: r.dayId } : {}),
      ...(r.startTime ? { startTime: r.startTime } : {}),
      ...(r.endTime ? { endTime: r.endTime } : {}),
      visibility: r.visibility,
    }))

  const updates = draftRows
    .filter((r) => r.existingId && !r.pendingDelete)
    .flatMap((r) => {
      const orig = sessions.find((s) => s.id === r.existingId)
      if (!orig) return []
      const patch: Record<string, unknown> = {}
      if (r.title.trim() !== orig.title) patch.title = r.title.trim()
      if (r.description.trim() !== (orig.description ?? '')) patch.description = r.description.trim() || null
      if (r.location.trim() !== (orig.location ?? '')) patch.location = r.location.trim() || null
      if (r.category.trim() !== (orig.category ?? '')) patch.category = r.category.trim() || null
      if (r.host.trim() !== (orig.host ?? '')) patch.host = r.host.trim() || null
      if (r.dayId !== (orig.day_id ?? '')) patch.dayId = r.dayId || null
      if (r.startTime !== (orig.start_time ?? '')) patch.startTime = r.startTime || null
      if (r.endTime !== (orig.end_time ?? '')) patch.endTime = r.endTime || null
      if (r.visibility !== orig.visibility) patch.visibility = r.visibility
      if (Object.keys(patch).length === 0) return []
      return [{ id: r.existingId!, patch }]
    })

  const deletes = draftRows
    .filter((r) => r.existingId && r.pendingDelete)
    .map((r) => r.existingId!)

  return { creates, updates, deletes }
}

function StatusBadge({ status }: { status: SessionApprovalStatus }) {
  if (status === 'approved') {
    return (
      <span className="chip" style={{ color: 'var(--map-highlight)' }}>
        approved
      </span>
    )
  }
  if (status === 'pending') {
    return (
      <span className="chip" style={{ color: 'var(--ink-dim)' }}>
        pending
      </span>
    )
  }
  return (
    <span className="chip" style={{ color: 'var(--hot)' }}>
      rejected
    </span>
  )
}

export function SessionsEditor({
  eventId,
  isOwner,
}: {
  eventId: string
  isOwner: boolean
}) {
  const [sessions, setSessions] = useState<SessionDtoFull[]>([])
  const [days, setDays] = useState<DayDto[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [filterStatus, setFilterStatus] = useState<SessionApprovalStatus | ''>('')

  // Create form
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [location, setLocation] = useState('')
  const [category, setCategory] = useState('')
  const [host, setHost] = useState('')
  const [sessionDayId, setSessionDayId] = useState('')
  const [startTime, setStartTime] = useState('')
  const [endTime, setEndTime] = useState('')
  const [createError, setCreateError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  // Bulk grid
  const [draftRows, setDraftRows] = useState<DraftRow[]>([])
  const [bulkSaving, setBulkSaving] = useState(false)
  const [bulkError, setBulkError] = useState<string | null>(null)
  const [bulkMode, setBulkMode] = useState(false)

  const bulkDirty = useMemo(() => {
    const { creates, updates, deletes } = computeBulkOps(draftRows, sessions)
    return creates.length > 0 || updates.length > 0 || deletes.length > 0
  }, [draftRows, sessions])

  useEffect(() => {
    let cancelled = false
    Promise.all([listSessions(eventId), listDays(eventId)])
      .then(([s, d]) => {
        if (cancelled) return
        setSessions(s)
        setDays(d)
        setDraftRows(s.map(rowFromSession))
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setLoadError(err instanceof ApiError ? err.message : 'Failed to load sessions.')
      })
    return () => {
      cancelled = true
    }
  }, [eventId])

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    setCreateError(null)
    setCreating(true)
    try {
      const session = await createSession(eventId, {
        title: title.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(location.trim() ? { location: location.trim() } : {}),
        ...(category.trim() ? { category: category.trim() } : {}),
        ...(host.trim() ? { host: host.trim() } : {}),
        ...(sessionDayId ? { dayId: sessionDayId } : {}),
        ...(startTime ? { startTime } : {}),
        ...(endTime ? { endTime } : {}),
        // Sessions are always attendee-visible; the visibility column is
        // retained at 'group' for forward-compat but no longer surfaced.
        visibility: 'group',
      })
      setSessions((prev) => [session, ...prev])
      setTitle('')
      setDescription('')
      setLocation('')
      setCategory('')
      setHost('')
      setSessionDayId('')
      setStartTime('')
      setEndTime('')
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.message : 'Failed to create session.')
    } finally {
      setCreating(false)
    }
  }

  async function handleDelete(sessionId: string) {
    try {
      await deleteSession(eventId, sessionId)
      setSessions((prev) => prev.filter((s) => s.id !== sessionId))
    } catch (err) {
      alert(err instanceof ApiError ? err.message : 'Failed to delete session.')
    }
  }

  async function handleApproval(
    sessionId: string,
    action: 'approve' | 'reject' | 'submit',
  ) {
    try {
      const updated = await setSessionApproval(eventId, sessionId, action)
      setSessions((prev) => prev.map((s) => (s.id === sessionId ? updated : s)))
    } catch (err) {
      alert(err instanceof ApiError ? err.message : `Failed to ${action} session.`)
    }
  }

  // ---- Bulk grid helpers ----

  function updateDraftRow(key: string, changes: Partial<DraftRow>) {
    setDraftRows((prev) =>
      prev.map((r) => (r.key === key ? { ...r, ...changes } : r)),
    )
  }

  function addDraftRow() {
    setDraftRows((prev) => [...prev, emptyDraftRow()])
  }

  function removeDraftRow(key: string) {
    setDraftRows((prev) => prev.filter((r) => r.key !== key))
  }

  async function handleBulkSave() {
    setBulkError(null)
    setBulkSaving(true)
    try {
      const { creates, updates, deletes } = computeBulkOps(draftRows, sessions)

      if (creates.length === 0 && updates.length === 0 && deletes.length === 0) {
        setBulkSaving(false)
        return
      }

      await bulkApplySessions(eventId, { creates, updates, deletes })

      // Refetch after bulk save.
      const [freshSessions, freshDays] = await Promise.all([
        listSessions(eventId),
        listDays(eventId),
      ])
      setSessions(freshSessions)
      setDays(freshDays)
      setDraftRows(freshSessions.map(rowFromSession))
      setBulkMode(false)
    } catch (err) {
      setBulkError(err instanceof ApiError ? err.message : 'Bulk save failed.')
    } finally {
      setBulkSaving(false)
    }
  }

  async function refetchSessions() {
    const [freshSessions, freshDays] = await Promise.all([
      listSessions(eventId),
      listDays(eventId),
    ])
    setSessions(freshSessions)
    setDays(freshDays)
    setDraftRows(freshSessions.map(rowFromSession))
  }

  // CSV import: client-side dry-run preview, then an apply that POSTs the
  // assembled creates/updates/deletes to the snapshot-protected bulk endpoint
  // (revertible from Version history below).
  function sessionsPreview(text: string, replace: boolean): CsvPreview {
    const p = planSessionsImport({ text, days, currentSessions: sessions, replace })
    const titleById = new Map(sessions.map((s) => [s.id, s.title]))
    return {
      summary: p.summary,
      errors: p.errors,
      rowLabels: [
        ...p.rows.map(
          (r) => `${r.action === 'create' ? '+' : '~'} ${r.title}${r.dayLabel ? ` — ${r.dayLabel}` : ''}`,
        ),
        ...p.deletes.map((id) => `− ${titleById.get(id) ?? id}`),
      ],
    }
  }

  async function applySessionsCsv(text: string, replace: boolean) {
    const p = planSessionsImport({ text, days, currentSessions: sessions, replace })
    if (p.summary.error > 0) throw new Error('Fix the errors in the preview before importing.')
    await bulkApplySessions(eventId, { creates: p.creates, updates: p.updates, deletes: p.deletes })
    await refetchSessions()
  }

  if (loadError) {
    return (
      <div
        role="alert"
        className="p-3 text-sm text-[color:var(--ink)]"
        style={{
          border: '1.5px solid var(--hot)',
          background: 'color-mix(in srgb, var(--hot) 12%, transparent)',
        }}
      >
        {loadError}
      </div>
    )
  }

  const dayMap = new Map(days.map((d) => [d.id, d]))

  const displayed =
    filterStatus
      ? sessions.filter((s) => s.approval_status === filterStatus)
      : sessions

  return (
    <div className="p-4 space-y-6" style={{ border: '1.5px solid var(--line)', background: 'var(--surface)' }}>
      {/* Create form */}
      <div className="space-y-3">
        <h3 className="text-xs font-medium text-[color:var(--ink-mute)]">Create session</h3>
        <form onSubmit={(e) => void handleCreate(e)} className="space-y-3">
          <div className="space-y-1">
            <label htmlFor="session-title" className="block text-xs font-medium text-[color:var(--ink-mute)]">
              Title <span style={{ color: 'var(--hot)' }}>*</span>
            </label>
            <input
              id="session-title"
              type="text"
              required
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Session title"
              className="w-full cyber-input"
            />
          </div>

          <div className="space-y-1">
            <label htmlFor="session-description" className="block text-xs font-medium text-[color:var(--ink-mute)]">
              Description
            </label>
            <textarea
              id="session-description"
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional description"
              className="w-full resize-y cyber-input"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label htmlFor="session-location" className="block text-xs font-medium text-[color:var(--ink-mute)]">
                Location
              </label>
              <input
                id="session-location"
                type="text"
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                placeholder="Optional location"
                className="w-full cyber-input"
              />
            </div>
            <div className="space-y-1">
              <label htmlFor="session-category" className="block text-xs font-medium text-[color:var(--ink-mute)]">
                Category
              </label>
              <input
                id="session-category"
                type="text"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                placeholder="Optional category"
                className="w-full cyber-input"
              />
            </div>
          </div>

          <div className="space-y-1">
            <label htmlFor="session-host" className="block text-xs font-medium text-[color:var(--ink-mute)]">
              Host
            </label>
            <input
              id="session-host"
              type="text"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="Optional host"
              className="w-full cyber-input"
            />
          </div>

          <div className="space-y-1">
            <label htmlFor="session-day-select" className="block text-xs font-medium text-[color:var(--ink-mute)]">
              Day
            </label>
            <select
              id="session-day-select"
              value={sessionDayId}
              onChange={(e) => setSessionDayId(e.target.value)}
              className="w-full cyber-input"
            >
              <option value="">No day</option>
              {days.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.day_label}
                </option>
              ))}
            </select>
          </div>

          <div className="flex gap-3 items-center">
            <div className="space-y-1">
              <label className="block text-xs font-medium text-[color:var(--ink-mute)]">Start time</label>
              <input
                type="time"
                value={startTime}
                onChange={(e) => setStartTime(e.target.value)}
                className="cyber-input"
              />
            </div>
            <div className="space-y-1">
              <label className="block text-xs font-medium text-[color:var(--ink-mute)]">End time</label>
              <input
                type="time"
                value={endTime}
                onChange={(e) => setEndTime(e.target.value)}
                className="cyber-input"
              />
            </div>
          </div>

          {createError && (
            <div
              role="alert"
              className="p-3 text-sm text-[color:var(--ink)]"
              style={{
                border: '1.5px solid var(--hot)',
                background: 'color-mix(in srgb, var(--hot) 12%, transparent)',
              }}
            >
              {createError}
            </div>
          )}

          <button type="submit" disabled={creating} className="btn-brutal" style={{ width: 'auto' }}>
            {creating ? 'Creating…' : 'Create session'}
          </button>
        </form>
      </div>

      {/* Bulk edit grid */}
      <div className="space-y-3">
        <div className="flex items-center gap-3">
          <h3 className="text-xs font-medium text-[color:var(--ink-mute)]">Bulk edit</h3>
          <button
            type="button"
            onClick={() => setBulkMode((v) => !v)}
            className="btn-ghost"
            style={{ width: 'auto' }}
          >
            {bulkMode ? 'Hide grid' : 'Open grid'}
          </button>
        </div>

        {bulkMode && (
          <div className="space-y-2">
            <div className="overflow-x-auto">
              <table className="w-full text-xs" style={{ borderCollapse: 'collapse' }}>
                <thead>
                  <tr className="text-[color:var(--ink-mute)] mono uppercase tracking-wide">
                    <th className="text-left p-1" style={{ minWidth: 140 }}>Title</th>
                    <th className="text-left p-1" style={{ minWidth: 80 }}>Day</th>
                    <th className="text-left p-1" style={{ minWidth: 70 }}>Start</th>
                    <th className="text-left p-1" style={{ minWidth: 70 }}>End</th>
                    <th className="text-left p-1" style={{ minWidth: 100 }}>Location</th>
                    <th className="text-left p-1" style={{ minWidth: 90 }}>Category</th>
                    <th className="text-left p-1" style={{ minWidth: 90 }}>Host</th>
                    <th className="p-1" style={{ minWidth: 60 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {draftRows.map((row) => (
                    <tr
                      key={row.key}
                      style={{
                        opacity: row.pendingDelete ? 0.4 : 1,
                        background: row.pendingDelete
                          ? 'color-mix(in srgb, var(--hot) 8%, transparent)'
                          : row.existingId
                          ? 'transparent'
                          : 'color-mix(in srgb, var(--map-highlight) 6%, transparent)',
                      }}
                    >
                      <td className="p-1">
                        <input
                          type="text"
                          value={row.title}
                          disabled={row.pendingDelete}
                          onChange={(e) => updateDraftRow(row.key, { title: e.target.value })}
                          className="w-full cyber-input"
                          style={{ padding: '2px 6px', fontSize: '0.75rem' }}
                          placeholder="Title"
                        />
                      </td>
                      <td className="p-1">
                        <select
                          value={row.dayId}
                          disabled={row.pendingDelete}
                          onChange={(e) => updateDraftRow(row.key, { dayId: e.target.value })}
                          className="w-full cyber-input"
                          style={{ padding: '2px 6px', fontSize: '0.75rem' }}
                        >
                          <option value="">—</option>
                          {days.map((d) => (
                            <option key={d.id} value={d.id}>{d.day_label}</option>
                          ))}
                        </select>
                      </td>
                      <td className="p-1">
                        <input
                          type="time"
                          value={row.startTime}
                          disabled={row.pendingDelete}
                          onChange={(e) => updateDraftRow(row.key, { startTime: e.target.value })}
                          className="cyber-input"
                          style={{ padding: '2px 6px', fontSize: '0.75rem', width: 90 }}
                        />
                      </td>
                      <td className="p-1">
                        <input
                          type="time"
                          value={row.endTime}
                          disabled={row.pendingDelete}
                          onChange={(e) => updateDraftRow(row.key, { endTime: e.target.value })}
                          className="cyber-input"
                          style={{ padding: '2px 6px', fontSize: '0.75rem', width: 90 }}
                        />
                      </td>
                      <td className="p-1">
                        <input
                          type="text"
                          value={row.location}
                          disabled={row.pendingDelete}
                          onChange={(e) => updateDraftRow(row.key, { location: e.target.value })}
                          className="w-full cyber-input"
                          style={{ padding: '2px 6px', fontSize: '0.75rem' }}
                          placeholder="Location"
                        />
                      </td>
                      <td className="p-1">
                        <input
                          type="text"
                          value={row.category}
                          disabled={row.pendingDelete}
                          onChange={(e) => updateDraftRow(row.key, { category: e.target.value })}
                          className="w-full cyber-input"
                          style={{ padding: '2px 6px', fontSize: '0.75rem' }}
                          placeholder="Category"
                        />
                      </td>
                      <td className="p-1">
                        <input
                          type="text"
                          value={row.host}
                          disabled={row.pendingDelete}
                          onChange={(e) => updateDraftRow(row.key, { host: e.target.value })}
                          className="w-full cyber-input"
                          style={{ padding: '2px 6px', fontSize: '0.75rem' }}
                          placeholder="Host"
                        />
                      </td>
                      <td className="p-1 text-center">
                        {row.existingId ? (
                          <button
                            type="button"
                            title={row.pendingDelete ? 'Undo delete' : 'Mark for delete'}
                            onClick={() =>
                              updateDraftRow(row.key, { pendingDelete: !row.pendingDelete })
                            }
                            className="btn-ghost"
                            style={{
                              width: 'auto',
                              padding: '2px 8px',
                              fontSize: '0.7rem',
                              color: row.pendingDelete ? 'var(--map-highlight)' : 'var(--hot)',
                              borderColor: row.pendingDelete ? 'var(--map-highlight)' : 'var(--hot)',
                            }}
                          >
                            {row.pendingDelete ? 'Undo' : 'Del'}
                          </button>
                        ) : (
                          <button
                            type="button"
                            title="Remove new row"
                            onClick={() => removeDraftRow(row.key)}
                            className="btn-ghost"
                            style={{
                              width: 'auto',
                              padding: '2px 8px',
                              fontSize: '0.7rem',
                              color: 'var(--hot)',
                              borderColor: 'var(--hot)',
                            }}
                          >
                            ×
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex items-center gap-3 flex-wrap">
              <button
                type="button"
                onClick={addDraftRow}
                className="btn-ghost"
                style={{ width: 'auto' }}
              >
                + Add row
              </button>
              <button
                type="button"
                onClick={() => void handleBulkSave()}
                disabled={bulkSaving || !bulkDirty}
                className="btn-hot"
                style={{ width: 'auto' }}
              >
                {bulkSaving ? 'Saving…' : 'Save changes'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setDraftRows(sessions.map(rowFromSession))
                  setBulkError(null)
                }}
                className="btn-ghost"
                style={{ width: 'auto' }}
                disabled={bulkSaving}
              >
                Reset
              </button>
            </div>

            {bulkError && (
              <div
                role="alert"
                className="p-3 text-sm text-[color:var(--ink)]"
                style={{
                  border: '1.5px solid var(--hot)',
                  background: 'color-mix(in srgb, var(--hot) 12%, transparent)',
                }}
              >
                {bulkError}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Sessions list */}
      <div className="space-y-3">
        <div className="flex items-center gap-3">
          <h3 className="text-xs font-medium text-[color:var(--ink-mute)]">Sessions</h3>
          <select
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value as SessionApprovalStatus | '')}
            className="cyber-input"
            style={{ width: 'auto' }}
          >
            <option value="">All statuses</option>
            <option value="approved">Approved</option>
            <option value="pending">Pending</option>
            <option value="rejected">Rejected</option>
          </select>
        </div>

        {displayed.length === 0 && (
          <p className="text-xs text-[color:var(--ink-mute)]">No sessions found.</p>
        )}

        <ul className="space-y-2">
          {displayed.map((session) => {
            const day = session.day_id ? dayMap.get(session.day_id) : undefined
            return (
              <li
                key={session.id}
                className="p-3 space-y-2"
                style={{ border: '1.5px solid var(--line)', background: 'var(--surface)' }}
              >
                <div className="flex items-start gap-2">
                  <div className="flex-1 space-y-0.5">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium">{session.title}</span>
                      <StatusBadge status={session.approval_status} />
                    </div>
                    <div className="flex items-center gap-2 flex-wrap text-xs text-[color:var(--ink-dim)]">
                      {day && <span>{day.day_label}</span>}
                      {session.start_time && (
                        <span>
                          {session.start_time}
                          {session.end_time ? `–${session.end_time}` : ''}
                        </span>
                      )}
                      {session.location && <span>📍 {session.location}</span>}
                      {session.category && <span>{session.category}</span>}
                      {session.host && <span>Host: {session.host}</span>}
                    </div>
                    {session.description && (
                      <p className="text-xs text-[color:var(--ink-dim)] mt-1 leading-relaxed">
                        {session.description}
                      </p>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-2 flex-wrap">
                  {isOwner && session.approval_status !== 'approved' && (
                    <>
                      <button
                        type="button"
                        onClick={() => void handleApproval(session.id, 'approve')}
                        className="btn-ghost"
                        style={{ width: 'auto', color: 'var(--map-highlight)', borderColor: 'var(--map-highlight)' }}
                      >
                        Approve
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleApproval(session.id, 'reject')}
                        className="btn-hot"
                        style={{ width: 'auto' }}
                      >
                        Reject
                      </button>
                    </>
                  )}
                  {!isOwner && session.approval_status === 'rejected' && (
                    <button
                      type="button"
                      onClick={() => void handleApproval(session.id, 'submit')}
                      className="btn-ghost"
                      style={{ width: 'auto' }}
                    >
                      Submit for approval
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => void handleDelete(session.id)}
                    className="btn-ghost"
                    style={{ width: 'auto', color: 'var(--hot)', borderColor: 'var(--hot)' }}
                  >
                    Delete
                  </button>
                </div>
              </li>
            )
          })}
        </ul>
      </div>

      <CsvImportPanel
        label="sessions"
        templateCsv={() => sessionsTemplateCsv(days)}
        templateFilename="sessions-template.csv"
        replaceHint="Delete sessions not present in the file"
        buildPreview={sessionsPreview}
        onApply={applySessionsCsv}
      />

      <SnapshotHistory eventId={eventId} kind="sessions" onRestored={refetchSessions} />
    </div>
  )
}

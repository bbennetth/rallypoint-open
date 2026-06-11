import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { shouldRefetch, subscribeEventStream } from '../lib/realtime.js'
import {
  ApiError,
  createInvite,
  deleteEvent,
  getEvent,
  getEventWeather,
  listEventAttendees,
  patchEvent,
  removeEventAttendee,
  restoreEvent,
  transferOwnership,
  type AssignableRole,
  type AttendeeDto,
  type EventDto,
  type InviteDto,
  type PatchEventInput,
  type PrivacyMode,
} from '../lib/api.js'
import { LineupEditor } from '../ui/LineupEditor.js'
import { SessionsEditor } from '../ui/SessionsEditor.js'
import { WeatherSection } from './PublicEventPage.js'

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; event: EventDto }
  | { status: 'error'; code: string; message: string }

function formatDate(d: string | null): string {
  if (!d) return '—'
  return new Date(d).toLocaleDateString(undefined, { dateStyle: 'long' })
}

// --- Edit form -------------------------------------------------------

interface EditFormProps {
  event: EventDto
  onSave: (updated: EventDto) => void
  onCancel: () => void
}

function EditForm({ event, onSave, onCancel }: EditFormProps) {
  const [name, setName] = useState(event.name)
  const [description, setDescription] = useState(event.description ?? '')
  const [startDate, setStartDate] = useState(event.start_date ?? '')
  const [endDate, setEndDate] = useState(event.end_date ?? '')
  const [locationLabel, setLocationLabel] = useState(event.location_label ?? '')
  const [privacyMode, setPrivacyMode] = useState<PrivacyMode>(event.privacy_mode)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setSaving(true)
    const fields: PatchEventInput = {
      ...(name.trim() !== event.name ? { name: name.trim() } : {}),
      ...(description.trim() !== (event.description ?? '')
        ? description.trim()
          ? { description: description.trim() }
          : { description: '' }
        : {}),
      ...(startDate !== (event.start_date ?? '')
        ? startDate
          ? { startDate }
          : {}
        : {}),
      ...(endDate !== (event.end_date ?? '')
        ? endDate
          ? { endDate }
          : {}
        : {}),
      ...(locationLabel.trim() !== (event.location_label ?? '')
        ? locationLabel.trim()
          ? { locationLabel: locationLabel.trim() }
          : {}
        : {}),
      ...(privacyMode !== event.privacy_mode ? { privacyMode } : {}),
    }

    if (Object.keys(fields).length === 0) {
      onCancel()
      return
    }

    try {
      const updated = await patchEvent(event.id, fields)
      onSave(updated)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Save failed.')
      setSaving(false)
    }
  }

  return (
    <form onSubmit={(e) => void handleSave(e)} className="space-y-4">
      {error && (
        <div
          role="alert"
          className="p-3 text-sm text-white/80"
          style={{ border: '1.5px solid var(--hot)', background: 'color-mix(in srgb, var(--hot) 12%, transparent)' }}
        >
          {error}
        </div>
      )}

      <div className="space-y-1">
        <label htmlFor="edit-name" className="block text-xs font-medium text-[color:var(--ink-mute)]">
          Name
        </label>
        <input
          id="edit-name"
          type="text"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="cyber-input"
        />
      </div>

      <div className="space-y-1">
        <label htmlFor="edit-description" className="block text-xs font-medium text-[color:var(--ink-mute)]">
          Description
        </label>
        <textarea
          id="edit-description"
          rows={3}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="cyber-input resize-y"
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <label htmlFor="edit-startDate" className="block text-xs font-medium text-[color:var(--ink-mute)]">
            Start date
          </label>
          <input
            id="edit-startDate"
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            className="cyber-input"
          />
        </div>
        <div className="space-y-1">
          <label htmlFor="edit-endDate" className="block text-xs font-medium text-[color:var(--ink-mute)]">
            End date
          </label>
          <input
            id="edit-endDate"
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            className="cyber-input"
          />
        </div>
      </div>

      <div className="space-y-1">
        <label htmlFor="edit-location" className="block text-xs font-medium text-[color:var(--ink-mute)]">
          Location
        </label>
        <input
          id="edit-location"
          type="text"
          value={locationLabel}
          onChange={(e) => setLocationLabel(e.target.value)}
          className="cyber-input"
        />
      </div>

      <div className="space-y-1">
        <label htmlFor="edit-privacy" className="block text-xs font-medium text-[color:var(--ink-mute)]">
          Privacy
        </label>
        <select
          id="edit-privacy"
          value={privacyMode}
          onChange={(e) => setPrivacyMode(e.target.value as PrivacyMode)}
          className="cyber-input"
        >
          <option value="public">Public</option>
          <option value="unlisted">Unlisted</option>
          <option value="private">Private</option>
        </select>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={saving}
          className="btn-brutal"
          style={{ width: 'auto' }}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="text-sm text-white/60 hover:text-white/80 transition-colors"
        >
          Cancel
        </button>
      </div>
    </form>
  )
}

// --- Invite section --------------------------------------------------

interface InviteSectionProps {
  eventId: string
}

export function InviteSection({ eventId }: InviteSectionProps) {
  const [role, setRole] = useState<AssignableRole>('viewer')
  const [email, setEmail] = useState('')
  const [creating, setCreating] = useState(false)
  const [created, setCreated] = useState<InviteDto | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setCreating(true)
    try {
      const invite = await createInvite(eventId, {
        role,
        ...(email.trim() ? { invitedEmail: email.trim() } : {}),
      })
      setCreated(invite)
      setEmail('')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create invite.')
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="p-4 space-y-3" style={{ border: '1.5px solid var(--line)', background: 'var(--surface)' }}>
      <h3 className="text-sm font-medium">Invite someone</h3>

      {error && (
        <p className="text-sm text-white/80">{error}</p>
      )}

      {created && (
        <div className="p-3 space-y-1" style={{ border: '1.5px solid var(--line)', background: 'var(--surface-2)' }}>
          <p className="text-xs text-white/60">Invite created — share this code:</p>
          <p className="font-mono text-sm text-[color:var(--ink)] break-all">{created.code}</p>
          <p className="text-xs text-white/40">
            Expires {new Date(created.expires_at).toLocaleDateString(undefined, { dateStyle: 'medium' })}
            {' · '}{created.role}
          </p>
          <button
            type="button"
            onClick={() => setCreated(null)}
            className="text-xs text-white/40 hover:text-white/80 underline"
          >
            Create another
          </button>
        </div>
      )}

      {!created && (
        <form onSubmit={(e) => void handleCreate(e)} className="space-y-3">
          <div className="flex gap-3">
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as AssignableRole)}
              className="cyber-input"
              style={{ width: 'auto' }}
            >
              <option value="editor">Editor</option>
              <option value="viewer">Viewer</option>
            </select>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Email (optional)"
              className="cyber-input flex-1"
            />
          </div>
          <button
            type="submit"
            disabled={creating}
            className="btn-brutal"
            style={{ width: 'auto' }}
          >
            {creating ? 'Creating…' : 'Create invite'}
          </button>
        </form>
      )}
    </div>
  )
}

// --- Transfer ownership section --------------------------------------

interface TransferSectionProps {
  eventId: string
  onTransferred: (updated: EventDto) => void
}

export function TransferSection({ eventId, onTransferred }: TransferSectionProps) {
  const [newOwnerUserId, setNewOwnerUserId] = useState('')
  const [currentPassword, setCurrentPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleTransfer(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      const updated = await transferOwnership(eventId, {
        newOwnerUserId: newOwnerUserId.trim(),
        currentPassword,
      })
      onTransferred(updated)
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === 'transfer_target_not_editor') {
          setError('The new owner must already be an editor on this event.')
        } else if (err.status === 401) {
          setError('Password re-authentication failed. Check your current password.')
        } else {
          setError(err.message)
        }
      } else {
        setError('Transfer failed.')
      }
      setSubmitting(false)
    }
  }

  return (
    <div className="p-4 space-y-3" style={{ border: '1.5px solid var(--hot)', background: 'color-mix(in srgb, var(--hot) 12%, transparent)' }}>
      <h3 className="text-sm font-medium text-white/80">Transfer ownership</h3>
      <p className="text-xs text-white/60">
        The new owner must already be an editor. You will become an editor after the transfer.
      </p>

      {error && (
        <p className="text-sm text-white/80">{error}</p>
      )}

      <form onSubmit={(e) => void handleTransfer(e)} className="space-y-3">
        <input
          type="text"
          required
          value={newOwnerUserId}
          onChange={(e) => setNewOwnerUserId(e.target.value)}
          placeholder="New owner user ID"
          className="cyber-input"
        />
        <input
          type="password"
          required
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          placeholder="Your current password"
          className="cyber-input"
        />
        <button
          type="submit"
          disabled={submitting}
          className="btn-hot"
          style={{ width: 'auto' }}
        >
          {submitting ? 'Transferring…' : 'Transfer ownership'}
        </button>
      </form>
    </div>
  )
}

// --- Attendees section ------------------------------------------------
//
// Phase 1 of the platform/v-1.1 redesign (issue #16): the owner-side
// `<GroupsSection>` that previously listed groups + members + join
// codes is GONE. Under the privacy rule, event owners must not see
// groups or group-internal data. The new minimal inline section reads
// from the Phase-0 attendees-first endpoint and renders a flat list
// of name + email + joined + role + a Remove button.
//
// Phase 2 will replace this inline section with the dedicated
// Attendees tab (using the `<Table>` primitive from Phase 5 + invite
// flows). Phase 1 ships the smallest possible privacy fix.

interface AttendeesSectionProps {
  eventId: string
  viewerUserId: string
}

function AttendeesSection({ eventId, viewerUserId }: AttendeesSectionProps) {
  const [attendees, setAttendees] = useState<AttendeeDto[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [removingId, setRemovingId] = useState<string | null>(null)

  const load = useCallback(() => {
    let cancelled = false
    listEventAttendees(eventId)
      .then((page) => {
        if (!cancelled) setAttendees(page.items)
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setLoadError(err instanceof ApiError ? err.message : 'Failed to load attendees.')
      })
    return () => {
      cancelled = true
    }
  }, [eventId])

  useEffect(() => {
    const cancel = load()
    return cancel
  }, [load])

  async function handleRemove(userId: string, label: string) {
    if (!window.confirm(`Remove ${label} from the event?`)) return
    setRemovingId(userId)
    try {
      await removeEventAttendee(eventId, userId)
      setAttendees((prev) => prev.filter((a) => a.user_id !== userId))
    } catch (err) {
      window.alert(
        err instanceof ApiError ? err.message : 'Failed to remove attendee.',
      )
    } finally {
      setRemovingId(null)
    }
  }

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-white/80">Attendees</h2>
        <span className="text-xs text-white/40">
          {attendees.length} {attendees.length === 1 ? 'person' : 'people'}
        </span>
      </div>

      {loadError && <p className="text-sm text-white/80">{loadError}</p>}

      {attendees.length === 0 ? (
        <p className="text-sm text-white/40">No attendees yet.</p>
      ) : (
        <ul className="divide-y divide-white/10" style={{ border: '1.5px solid var(--line)' }}>
          {attendees.map((a) => {
            const isSelf = a.user_id === viewerUserId
            const isOwner = a.role === 'owner'
            const canRemove = !isSelf && !isOwner
            const label = a.display_name ?? a.email ?? a.user_id
            return (
              <li
                key={a.user_id}
                className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate">{label}</div>
                  <div className="text-xs text-white/40 truncate">
                    {a.email ?? '—'}{a.role ? ` · ${a.role}` : ''}{isSelf ? ' · you' : ''}
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-xs text-white/40 whitespace-nowrap">
                    {new Date(a.joined_at).toLocaleDateString()}
                  </span>
                  {canRemove && (
                    <button
                      type="button"
                      onClick={() => void handleRemove(a.user_id, label)}
                      disabled={removingId === a.user_id}
                      className="text-xs text-red-400 hover:text-red-300 disabled:opacity-50 transition-colors"
                    >
                      {removingId === a.user_id ? 'Removing…' : 'Remove'}
                    </button>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

// --- Main page -------------------------------------------------------

export function EventDetailPage({ userId }: { userId: string }) {
  const { slug } = useParams<{ slug: string }>()
  const navigate = useNavigate()

  const [state, setState] = useState<LoadState>({ status: 'loading' })
  const [editOpen, setEditOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [restoring, setRestoring] = useState(false)
  // Bumped on a realtime lineup invalidation so the LineupEditor re-fetches.
  const [lineupReload, setLineupReload] = useState(0)

  // `silent` skips the loading flash — used by realtime refetches so a live
  // update from another collaborator doesn't blank the page. `shouldApply`
  // lets the slug-driven load discard a stale response after navigation.
  const load = useCallback(
    async (opts: { silent?: boolean; shouldApply?: () => boolean } = {}) => {
      if (!slug) return
      if (!opts.silent) setState({ status: 'loading' })
      try {
        const event = await getEvent(slug)
        if (opts.shouldApply && !opts.shouldApply()) return
        setState({ status: 'ready', event })
      } catch (err) {
        if (opts.shouldApply && !opts.shouldApply()) return
        if (err instanceof ApiError && err.status === 404) {
          setState({ status: 'error', code: 'not_found', message: 'Event not found.' })
        } else {
          setState({
            status: 'error',
            code: err instanceof ApiError ? err.code : 'unexpected_error',
            message: err instanceof Error ? err.message : 'Unknown error.',
          })
        }
      }
    },
    [slug],
  )

  useEffect(() => {
    let cancelled = false
    void load({ shouldApply: () => !cancelled })
    return () => {
      cancelled = true
    }
  }, [load])

  // Live updates: subscribe once we know the event id. The server fans the
  // event/lineup/map channels onto this one stream; an `events` envelope
  // refetches the header, a lineup envelope bumps the editor's reload signal.
  // loadRef keeps the subscription stable across renders while always calling
  // the freshest load.
  const eventId = state.status === 'ready' ? state.event.id : null
  const loadRef = useRef(load)
  loadRef.current = load
  useEffect(() => {
    if (!eventId) return undefined
    return subscribeEventStream(eventId, {
      onEvent: (env) => {
        if (!shouldRefetch(env, userId)) return
        if (env.resource === 'events') void loadRef.current({ silent: true })
        else setLineupReload((n) => n + 1)
      },
      onReconnect: () => {
        void loadRef.current({ silent: true })
        setLineupReload((n) => n + 1)
      },
    })
  }, [eventId, userId])

  async function handleDelete() {
    if (state.status !== 'ready') return
    if (!confirm('Delete this event? You can restore it within 30 days.')) return
    setDeleting(true)
    try {
      await deleteEvent(state.event.id)
      void navigate('/me/events')
    } catch (err) {
      alert(err instanceof ApiError ? err.message : 'Delete failed.')
      setDeleting(false)
    }
  }

  async function handleRestore() {
    if (state.status !== 'ready') return
    setRestoring(true)
    try {
      const updated = await restoreEvent(state.event.id)
      setState({ status: 'ready', event: updated })
    } catch (err) {
      alert(err instanceof ApiError ? err.message : 'Restore failed.')
    } finally {
      setRestoring(false)
    }
  }

  if (state.status === 'loading') {
    return (
      <main className="page-pad flex items-center justify-center">
        <p className="text-white/60 text-sm">Loading…</p>
      </main>
    )
  }

  if (state.status === 'error') {
    return (
      <main className="page-pad flex items-center justify-center">
        <div className="max-w-md w-full p-4" style={{ border: '1.5px solid var(--hot)', background: 'color-mix(in srgb, var(--hot) 12%, transparent)' }}>
          <h1 className="display text-lg">
            {state.code === 'not_found' ? 'Event not found' : 'Error'}
          </h1>
          <p className="mt-2 text-sm text-white/80">{state.message}</p>
          <a href="/me/events" className="mt-4 inline-block text-sm text-[color:var(--ink)] underline hover:opacity-70">
            Back to my events
          </a>
        </div>
      </main>
    )
  }

  const { event } = state
  const isOwner = event.viewer_role === 'owner'
  const canEdit = event.viewer_role === 'owner' || event.viewer_role === 'editor'

  return (
    <main className="page-pad">
      <div className="max-w-2xl mx-auto space-y-6">
        <nav>
          <a href="/me/events" className="text-sm text-[color:var(--ink)] underline hover:opacity-70">
            ← My events
          </a>
        </nav>

        <header className="space-y-2">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-xs font-medium text-[color:var(--ink-mute)]">
                {event.privacy_mode} · {event.viewer_role}
              </p>
              <h1 className="display text-2xl mt-1">{event.name}</h1>
              <p className="font-mono text-xs text-[color:var(--ink-mute)] mt-0.5">{event.slug}</p>
            </div>
            {event.deleted_at && (
              <span className="chip" style={{ color: 'var(--hot)' }}>
                deleted
              </span>
            )}
          </div>
        </header>

        {event.description && (
          <p className="text-white/80 text-sm leading-relaxed">{event.description}</p>
        )}

        <dl className="p-4 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 text-sm" style={{ border: '1.5px solid var(--line)', background: 'var(--surface)' }}>
          <dt className="text-white/40">Timezone</dt>
          <dd>{event.timezone}</dd>
          <dt className="text-white/40">Start</dt>
          <dd>{formatDate(event.start_date)}</dd>
          <dt className="text-white/40">End</dt>
          <dd>{formatDate(event.end_date)}</dd>
          {event.location_label && (
            <>
              <dt className="text-white/40">Location</dt>
              <dd>{event.location_label}</dd>
            </>
          )}
          <dt className="text-white/40">Created</dt>
          <dd>{formatDate(event.created_at)}</dd>
          <dt className="text-white/40">Updated</dt>
          <dd>{formatDate(event.updated_at)}</dd>
          {event.deleted_at && (
            <>
              <dt className="text-white/40">Deleted</dt>
              <dd className="text-white/80">{formatDate(event.deleted_at)}</dd>
            </>
          )}
        </dl>

        {canEdit && (
          <section className="space-y-3">
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => setEditOpen((o) => !o)}
                className="btn-ghost"
                style={{ width: 'auto' }}
              >
                {editOpen ? 'Cancel edit' : 'Edit'}
              </button>
            </div>
            {editOpen && (
              <EditForm
                event={event}
                onSave={(updated) => {
                  setState({ status: 'ready', event: updated })
                  setEditOpen(false)
                }}
                onCancel={() => setEditOpen(false)}
              />
            )}
          </section>
        )}

        <section className="space-y-3">
          <h2 className="text-sm font-medium text-white/80">Map &amp; POIs</h2>
          <a
            href={`/events/${event.slug}/map`}
            className="btn-ghost inline-flex"
            style={{ width: 'auto' }}
          >
            Open map editor →
          </a>
        </section>

        {/* Slice 12: weather + AQI for the event's location. The
            component hides itself if the event has no coordinates or
            is outside the (-7d, +14d) refresh window. */}
        <WeatherSection fetcher={() => getEventWeather(event.id)} />

        <AttendeesSection eventId={event.id} viewerUserId={userId} />

        {canEdit && (
          <>
            <section className="space-y-3">
              <h2 className="text-sm font-medium text-white/80">Lineup</h2>
              <LineupEditor eventId={event.id} reloadSignal={lineupReload} />
            </section>

            <section className="space-y-3">
              <h2 className="text-sm font-medium text-white/80">Sessions</h2>
              <SessionsEditor eventId={event.id} isOwner={isOwner} />
            </section>

            <PublicPagePanel
              event={event}
              onSaved={(updated) => setState({ status: 'ready', event: updated })}
            />
          </>
        )}

        {isOwner && (
          <>
            <section className="space-y-3">
              <h2 className="text-sm font-medium text-white/80">Danger zone</h2>
              <div className="flex items-center gap-3">
                {event.deleted_at ? (
                  <button
                    type="button"
                    disabled={restoring}
                    onClick={() => void handleRestore()}
                    className="btn-ghost"
                    style={{ width: 'auto' }}
                  >
                    {restoring ? 'Restoring…' : 'Restore event'}
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={deleting}
                    onClick={() => void handleDelete()}
                    className="btn-hot"
                    style={{ width: 'auto' }}
                  >
                    {deleting ? 'Deleting…' : 'Delete event'}
                  </button>
                )}
              </div>
            </section>

            <InviteSection eventId={event.id} />

            <TransferSection
              eventId={event.id}
              onTransferred={(updated) => setState({ status: 'ready', event: updated })}
            />
          </>
        )}
      </div>
    </main>
  )
}

// --- Public page panel (slice 11) ---------------------------------
// Minimal V1 surface per the slice plan: an enabled toggle, an
// accent-colour picker, and a copy-link button. The richer
// sections / hidden_fields / background-image editor lands as a
// follow-up issue. Owners + editors can flip the switch; the PATCH
// hits the existing /api/v1/ui/events/:id and fires the realtime
// envelope so any open SSE viewer re-fetches.

const DEFAULT_ACCENT_COLOR = '#0a0a0a'

export function PublicPagePanel({
  event,
  onSaved,
}: {
  event: EventDto
  onSaved: (updated: EventDto) => void
}) {
  const config = event.public_page_config ?? null
  const [enabled, setEnabled] = useState(config?.enabled ?? false)
  const [accentColor, setAccentColor] = useState(
    config?.theme?.accent_color ?? DEFAULT_ACCENT_COLOR,
  )
  const [saving, setSaving] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // If the parent reloads the event (e.g. via realtime invalidation),
  // re-sync our local form state.
  useEffect(() => {
    const next = event.public_page_config ?? null
    setEnabled(next?.enabled ?? false)
    setAccentColor(next?.theme?.accent_color ?? DEFAULT_ACCENT_COLOR)
  }, [event.public_page_config])

  async function handleSave() {
    setError(null)
    setSaving(true)
    try {
      const updated = await patchEvent(event.id, {
        publicPageConfig: {
          // Preserve any fields the API surfaced (sections,
          // hidden_fields, background_image_key) so a UI save
          // doesn't clobber owner-set jsonb the editor doesn't expose.
          ...(config ?? {}),
          enabled,
          theme: {
            ...(config?.theme ?? {}),
            accent_color: accentColor,
          },
        },
      })
      onSaved(updated)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Save failed.')
    } finally {
      setSaving(false)
    }
  }

  async function handleCopyLink() {
    const origin = typeof window === 'undefined' ? '' : window.location.origin
    const url = `${origin}/e/${event.slug}`
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      // navigator.clipboard requires HTTPS or localhost; fall back
      // to a prompt so the user can at least copy from there.
      window.prompt('Copy this public link:', url)
    }
  }

  const dirty =
    enabled !== (config?.enabled ?? false) ||
    accentColor !== (config?.theme?.accent_color ?? DEFAULT_ACCENT_COLOR)

  return (
    <section className="space-y-3">
      <h2 className="text-sm font-medium text-white/80">Public page</h2>
      <p className="text-xs text-white/60">
        When public, anyone with the link can view a read-only landing page for
        your event. Crawlers see per-event link previews.
      </p>

      <div className="flex items-center gap-3">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          Make this page public
        </label>
      </div>

      <div className="flex items-center gap-3">
        <label className="flex items-center gap-2 text-sm">
          Accent
          <input
            type="color"
            value={accentColor}
            onChange={(e) => setAccentColor(e.target.value)}
            aria-label="Accent colour"
          />
        </label>
        <span className="font-mono text-xs text-[color:var(--ink-mute)]">{accentColor}</span>
      </div>

      {error && (
        <p role="alert" className="text-sm" style={{ color: 'var(--hot)' }}>
          {error}
        </p>
      )}

      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={saving || !dirty}
          onClick={() => void handleSave()}
          className="btn-brutal"
          style={{ width: 'auto' }}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          disabled={!enabled}
          onClick={() => void handleCopyLink()}
          className="btn-ghost"
          style={{ width: 'auto' }}
          aria-label="Copy public link"
        >
          {copied ? 'Copied!' : 'Copy public link'}
        </button>
        {enabled && (
          <a
            href={`/e/${event.slug}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-[color:var(--ink)] underline"
          >
            Open
          </a>
        )}
      </div>

      <p className="text-[10px] font-medium text-[color:var(--ink-mute)]">
        The slug is auto-generated. Custom slugs are a paid-tier feature.
      </p>
    </section>
  )
}

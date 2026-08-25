import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Banner, Button, Field } from '@rallypoint/ui'
import {
  createSystemEvent,
  deleteSystemEvent,
  listSystemEvents,
  patchSystemEvent,
  restoreSystemEvent,
  type CreateSystemEventInput,
  type PatchSystemEventInput,
  type SystemEventDto,
} from '../lib/api.js'

// System-owned events management: events owned by the platform's
// SYSTEM_USER_ID sentinel, created and edited here by allowlisted
// admins. "Open in Events" links to events-web, where the admin's own
// session resolves as role owner on system events (events-api's
// ADMIN_USER_IDS allowlist), so the full owner chrome — and the
// join-as-attendee flow — just works.

const PRIVACY_MODES = ['public', 'unlisted', 'private'] as const

// Cross-subdomain link derivation: admin.rallypt.{dev,app} →
// events.rallypt.{dev,app}; local dev falls back to the events-web
// Vite port.
function eventsOrigin(): string {
  const host = window.location.hostname
  if (host.startsWith('admin.')) {
    return `${window.location.protocol}//${host.replace(/^admin\./, 'events.')}`
  }
  return 'http://localhost:5174'
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString()
}

interface FormState {
  name: string
  timezone: string
  description: string
  startDate: string
  endDate: string
  privacyMode: (typeof PRIVACY_MODES)[number]
}

const EMPTY_FORM: FormState = {
  name: '',
  timezone: 'UTC',
  description: '',
  startDate: '',
  endDate: '',
  privacyMode: 'unlisted',
}

function toCreateInput(form: FormState): CreateSystemEventInput {
  return {
    name: form.name.trim(),
    timezone: form.timezone.trim() || 'UTC',
    ...(form.description.trim() ? { description: form.description.trim() } : {}),
    ...(form.startDate ? { startDate: form.startDate } : {}),
    ...(form.endDate ? { endDate: form.endDate } : {}),
    privacyMode: form.privacyMode,
  }
}

// Patch sends explicit nulls for cleared nullable fields — omitting a
// key means "leave unchanged", so a cleared description/date would
// otherwise silently persist its old value.
function toPatchInput(form: FormState): PatchSystemEventInput {
  return {
    name: form.name.trim(),
    timezone: form.timezone.trim() || 'UTC',
    description: form.description.trim() || null,
    startDate: form.startDate || null,
    endDate: form.endDate || null,
    privacyMode: form.privacyMode,
  }
}

export function SystemEventsPage() {
  const [items, setItems] = useState<SystemEventDto[]>([])
  const [includeDeleted, setIncludeDeleted] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  // Row with the edit form open (pre-filled from the row's DTO).
  const [editingId, setEditingId] = useState<string | null>(null)
  const [actingId, setActingId] = useState<string | null>(null)
  const generationRef = useRef(0)

  const load = useCallback(async (withDeleted: boolean) => {
    const generation = ++generationRef.current
    setLoading(true)
    setError(null)
    try {
      const rows = await listSystemEvents(withDeleted)
      if (generation !== generationRef.current) return
      setItems(rows)
    } catch (err) {
      if (generation !== generationRef.current) return
      setError(err instanceof Error ? err.message : 'Failed to load system events.')
    } finally {
      if (generation === generationRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load(includeDeleted)
  }, [includeDeleted, load])

  async function submitCreate(e: React.FormEvent) {
    e.preventDefault()
    if (!form.name.trim()) return
    setActingId('new')
    setError(null)
    try {
      await createSystemEvent(toCreateInput(form))
      setForm(EMPTY_FORM)
      setCreating(false)
      await load(includeDeleted)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create system event.')
    } finally {
      setActingId(null)
    }
  }

  async function submitEdit(e: React.FormEvent, id: string) {
    e.preventDefault()
    setActingId(id)
    setError(null)
    try {
      await patchSystemEvent(id, toPatchInput(form))
      setEditingId(null)
      await load(includeDeleted)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update system event.')
    } finally {
      setActingId(null)
    }
  }

  async function act(id: string, kind: 'delete' | 'restore') {
    setActingId(id)
    setError(null)
    try {
      if (kind === 'delete') await deleteSystemEvent(id)
      else await restoreSystemEvent(id)
      await load(includeDeleted)
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to ${kind} system event.`)
    } finally {
      setActingId(null)
    }
  }

  function beginEdit(ev: SystemEventDto) {
    setEditingId(ev.id)
    setCreating(false)
    setForm({
      name: ev.name,
      timezone: ev.timezone,
      description: ev.description ?? '',
      startDate: ev.startDate ?? '',
      endDate: ev.endDate ?? '',
      privacyMode: (PRIVACY_MODES as readonly string[]).includes(ev.privacyMode)
        ? (ev.privacyMode as FormState['privacyMode'])
        : 'unlisted',
    })
  }

  function eventForm(onSubmit: (e: React.FormEvent) => void, submitLabel: string) {
    return (
      <form
        onSubmit={onSubmit}
        style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 12 }}
      >
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <div style={{ flex: 2, minWidth: 180 }}>
            <Field
              label="Name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="Event name"
              required
            />
          </div>
          <div style={{ flex: 1, minWidth: 120 }}>
            <Field
              label="Timezone"
              value={form.timezone}
              onChange={(e) => setForm({ ...form, timezone: e.target.value })}
              placeholder="UTC"
            />
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div style={{ minWidth: 140 }}>
            <Field
              label="Start date"
              type="date"
              value={form.startDate}
              onChange={(e) => setForm({ ...form, startDate: e.target.value })}
            />
          </div>
          <div style={{ minWidth: 140 }}>
            <Field
              label="End date"
              type="date"
              value={form.endDate}
              onChange={(e) => setForm({ ...form, endDate: e.target.value })}
            />
          </div>
          <select
            value={form.privacyMode}
            onChange={(e) =>
              setForm({ ...form, privacyMode: e.target.value as FormState['privacyMode'] })
            }
            style={{ minWidth: 120 }}
            aria-label="Privacy mode"
          >
            {PRIVACY_MODES.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>
        <Field
          label="Description (optional)"
          value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
          placeholder="Shown on the event page"
        />
        <div style={{ display: 'flex', gap: 8 }}>
          <Button type="submit" disabled={actingId !== null}>
            {submitLabel}
          </Button>
          <Button
            variant="ghost"
            type="button"
            onClick={() => {
              setCreating(false)
              setEditingId(null)
            }}
          >
            Cancel
          </Button>
        </div>
      </form>
    )
  }

  return (
    <div className="page">
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        <label className="muted" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input
            type="checkbox"
            checked={includeDeleted}
            onChange={(e) => setIncludeDeleted(e.target.checked)}
          />
          Show deleted
        </label>
        <Button
          onClick={() => {
            setCreating((v) => !v)
            setEditingId(null)
            setForm(EMPTY_FORM)
          }}
        >
          {creating ? 'Close' : 'New system event'}
        </Button>
      </div>

      {error && <Banner tone="error">{error}</Banner>}

      {creating && (
        <div className="card" style={{ padding: '12px 16px', marginTop: 12 }}>
          <strong>New system event</strong>
          {eventForm(submitCreate, 'Create')}
        </div>
      )}

      {loading ? (
        <p className="muted">Loading…</p>
      ) : items.length === 0 ? (
        <p className="muted">No system events yet.</p>
      ) : (
        <ul className="list" style={{ listStyle: 'none', padding: 0, margin: 0, marginTop: 12 }}>
          {items.map((ev) => (
            <li key={ev.id} className="card" style={{ padding: '12px 16px', marginBottom: 12 }}>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: 12,
                  flexWrap: 'wrap',
                }}
              >
                <div>
                  <strong>{ev.name}</strong>
                  {ev.deletedAt && (
                    <span className="muted" style={{ marginLeft: 8, fontSize: 13 }}>
                      (deleted {formatDate(ev.deletedAt)})
                    </span>
                  )}
                  <div className="muted" style={{ fontSize: 13 }}>
                    /{ev.slug} · {ev.privacyMode} · {ev.timezone}
                  </div>
                  <div className="muted" style={{ fontSize: 13 }}>
                    {ev.startDate ?? 'No start date'}
                    {ev.endDate ? ` → ${ev.endDate}` : ''} · created {formatDate(ev.createdAt)}
                  </div>
                  {ev.description && (
                    <div className="muted" style={{ fontSize: 13 }}>
                      {ev.description}
                    </div>
                  )}
                </div>

                <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                  {!ev.deletedAt && (
                    <>
                      <a
                        href={`${eventsOrigin()}/events/${encodeURIComponent(ev.slug)}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <Button variant="ghost" type="button">
                          Open in Events
                        </Button>
                      </a>
                      <Link to={`/system-events/${encodeURIComponent(ev.id)}/lineup`}>
                        <Button variant="ghost" type="button">
                          Lineup AI
                        </Button>
                      </Link>
                      <Button
                        variant="ghost"
                        onClick={() => (editingId === ev.id ? setEditingId(null) : beginEdit(ev))}
                        disabled={actingId !== null}
                      >
                        {editingId === ev.id ? 'Close' : 'Edit'}
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={() => void act(ev.id, 'delete')}
                        disabled={actingId !== null}
                      >
                        Delete
                      </Button>
                    </>
                  )}
                  {ev.deletedAt && (
                    <Button
                      variant="ghost"
                      onClick={() => void act(ev.id, 'restore')}
                      disabled={actingId !== null}
                    >
                      Restore
                    </Button>
                  )}
                </div>
              </div>

              {editingId === ev.id && eventForm((e) => submitEdit(e, ev.id), 'Save')}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

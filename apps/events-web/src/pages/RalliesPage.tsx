import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  ApiError,
  createRally,
  deleteRally,
  getGroup,
  listDays,
  listPois,
  listRallies,
  rsvpRally,
  type GroupDetailDto,
  type GroupRole,
  type DayDto,
  type PoiDto,
  type RallyDto,
  type RallyRsvpStatus,
  type RallyStatus,
} from '../lib/api.js'
import { useRefreshBus } from '../lib/refresh-bus.js'
import { useAttendeeOutlet } from '../ui/AttendeeChrome.js'

// Group role ranks — writes (create/delete) need sidekick+, RSVP is a
// per-member self-action. Mirrors the server-side gate.
const ROLE_RANK: Record<GroupRole, number> = { owner: 3, sidekick: 2, member: 1 }
const canWrite = (role: GroupRole | null): boolean => (role ? ROLE_RANK[role] >= 2 : false)

type LoadState =
  | { status: 'loading' }
  | {
      status: 'ready'
      group: GroupDetailDto
      rallies: RallyDto[]
      days: DayDto[]
      pois: PoiDto[]
    }
  | { status: 'error'; code: string; message: string }

export function RalliesPage() {
  const { userId } = useAttendeeOutlet()
  const { groupId } = useParams<{ groupId: string }>()
  const [state, setState] = useState<LoadState>({ status: 'loading' })

  const load = useCallback(() => {
    if (!groupId) return
    getGroup(groupId)
      .then(async (group) => {
        const [rallies, days, pois] = await Promise.all([
          listRallies(group.id),
          listDays(group.event_id).catch(() => [] as DayDto[]),
          listPois(group.event_id).catch(() => [] as PoiDto[]),
        ])
        setState({ status: 'ready', group, rallies, days, pois })
      })
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 404) {
          setState({ status: 'error', code: 'not_found', message: 'Group not found.' })
        } else {
          setState({
            status: 'error',
            code: err instanceof ApiError ? err.code : 'unexpected_error',
            message: err instanceof Error ? err.message : 'Unknown error.',
          })
        }
      })
  }, [groupId])

  useEffect(() => {
    load()
  }, [load])

  // Pull-to-refresh re-loads the group + rallies + days + pois without
  // remounting.
  useRefreshBus(load)

  if (state.status === 'loading') {
    return (
      <main className="page-pad flex items-center justify-center">
        <p className="text-[color:var(--ink-dim)] text-sm">Loading…</p>
      </main>
    )
  }

  if (state.status === 'error') {
    return (
      <main className="page-pad flex items-center justify-center">
        <div
          className="max-w-md w-full p-4"
          style={{
            border: '1.5px solid var(--hot)',
            background: 'color-mix(in srgb, var(--hot) 12%, transparent)',
          }}
        >
          <h1 className="text-lg font-semibold text-[color:var(--ink)]">
            {state.code === 'not_found' ? 'Group not found' : 'Error'}
          </h1>
          <p className="mt-2 text-sm text-[color:var(--ink)]">{state.message}</p>
          <a href="/me/events" className="mt-4 inline-block text-sm text-[color:var(--ink-mute)] underline">
            Back to my events
          </a>
        </div>
      </main>
    )
  }

  const { group, rallies, days, pois } = state
  const writer = canWrite(group.viewer_role)

  return (
    <main className="page-pad">
      <div className="max-w-2xl mx-auto space-y-6">
        <nav>
          <Link
            to={`/groups/${group.id}`}
            className="text-sm text-[color:var(--ink-mute)] hover:text-[color:var(--ink)] underline"
          >
            ← {group.name}
          </Link>
        </nav>

        <header className="space-y-1">
          <p className="text-xs font-medium text-[color:var(--ink-mute)]">Rallies</p>
          <h1 className="display text-2xl">{group.name}</h1>
          <p className="text-[color:var(--ink-dim)] text-sm">Planned meet-ups for your group.</p>
        </header>

        {writer && <CreateRallyForm groupId={group.id} days={days} pois={pois} onCreated={load} />}

        {rallies.length === 0 ? (
          <p className="text-sm text-[color:var(--ink-dim)]">No rallies yet.</p>
        ) : (
          <ul className="space-y-3">
            {rallies.map((rally) => (
              <RallyCard
                key={rally.id}
                groupId={group.id}
                rally={rally}
                days={days}
                pois={pois}
                members={group.members}
                viewerUserId={userId}
                canWrite={writer}
                onChanged={load}
              />
            ))}
          </ul>
        )}
      </div>
    </main>
  )
}

function CreateRallyForm({
  groupId,
  days,
  pois,
  onCreated,
}: {
  groupId: string
  days: DayDto[]
  pois: PoiDto[]
  onCreated: () => void
}) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [dayId, setDayId] = useState('')
  const [startTime, setStartTime] = useState('')
  const [poiId, setPoiId] = useState('')
  const [locationLabel, setLocationLabel] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!title.trim()) return
    setBusy(true)
    setError(null)
    createRally(groupId, {
      title: title.trim(),
      description: description.trim() || null,
      dayId: dayId || null,
      startTime: startTime || null,
      poiId: poiId || null,
      locationLabel: locationLabel.trim() || null,
    })
      .then(() => {
        setTitle('')
        setDescription('')
        setDayId('')
        setStartTime('')
        setPoiId('')
        setLocationLabel('')
        onCreated()
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Could not create rally.')
      })
      .finally(() => setBusy(false))
  }

  return (
    <form
      onSubmit={submit}
      className="p-4 space-y-3"
      style={{ border: '1.5px solid var(--line)', background: 'var(--surface)' }}
    >
      <h2 className="text-xs font-medium text-[color:var(--ink-mute)]">
        New rally
      </h2>
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Title"
        maxLength={200}
        required
        className="cyber-input"
      />
      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Description (optional)"
        maxLength={5000}
        rows={2}
        className="cyber-input"
      />
      <div className="flex gap-3">
        <select
          value={dayId}
          onChange={(e) => setDayId(e.target.value)}
          className="cyber-input flex-1"
        >
          <option value="">No day</option>
          {days.map((d) => (
            <option key={d.id} value={d.id}>
              {d.day_label}
            </option>
          ))}
        </select>
        <input
          type="time"
          value={startTime}
          onChange={(e) => setStartTime(e.target.value)}
          className="cyber-input"
          style={{ width: 'auto' }}
        />
      </div>
      <select
        value={poiId}
        onChange={(e) => setPoiId(e.target.value)}
        className="cyber-input"
      >
        <option value="">No map location</option>
        {pois.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <input
        value={locationLabel}
        onChange={(e) => setLocationLabel(e.target.value)}
        placeholder="Location label (optional)"
        maxLength={200}
        className="cyber-input"
      />
      {error && <p className="text-sm text-[color:var(--ink)]">{error}</p>}
      <button
        type="submit"
        disabled={busy || !title.trim()}
        className="btn-brutal"
        style={{ width: 'auto' }}
      >
        {busy ? 'Creating…' : 'Create rally'}
      </button>
    </form>
  )
}

const RSVP_OPTIONS: { value: RallyRsvpStatus; label: string }[] = [
  { value: 'going', label: 'Going' },
  { value: 'maybe', label: 'Maybe' },
  { value: 'out', label: 'Out' },
]

// Visual mapping for festival-planner-style rally cards. The status
// drives accent color (border-left + status chip) so the active /
// proposed / cancelled state is recognisable at a glance.
const STATUS_VISUAL: Record<
  RallyStatus,
  { accent: string; tint: string; chipLabel: string }
> = {
  active: { accent: 'var(--acid)', tint: 'var(--surface)', chipLabel: 'ACTIVE' },
  proposed: {
    accent: 'var(--ink-mute)',
    tint: 'var(--surface)',
    chipLabel: 'PROPOSED',
  },
  cancelled: {
    accent: 'var(--hot)',
    tint: 'color-mix(in srgb, var(--hot) 6%, var(--surface))',
    chipLabel: 'CANCELLED',
  },
}

function RallyCard({
  groupId,
  rally,
  days,
  pois,
  members,
  viewerUserId,
  canWrite: writer,
  onChanged,
}: {
  groupId: string
  rally: RallyDto
  days: DayDto[]
  pois: PoiDto[]
  members: { user_id: string; role: GroupRole }[]
  viewerUserId: string
  canWrite: boolean
  onChanged: () => void
}) {
  const [busy, setBusy] = useState(false)
  const dayLabel = rally.day_id ? days.find((d) => d.id === rally.day_id)?.day_label : null
  const poiName = rally.poi_id ? pois.find((p) => p.id === rally.poi_id)?.name : null
  const location = poiName ?? rally.location_label
  const visual = STATUS_VISUAL[rally.status]
  const isCancelled = rally.status === 'cancelled'
  const creator = members.find((m) => m.user_id === rally.created_by)

  const onRsvp = (status: RallyRsvpStatus) => {
    setBusy(true)
    rsvpRally(groupId, rally.id, status)
      .then(() => onChanged())
      .finally(() => setBusy(false))
  }

  const onDelete = () => {
    if (!confirm(`Delete rally "${rally.title}"?`)) return
    setBusy(true)
    deleteRally(groupId, rally.id)
      .then(() => onChanged())
      .finally(() => setBusy(false))
  }

  return (
    <li
      className="p-4 space-y-3"
      style={{
        border: '1.5px solid var(--line)',
        borderLeft: `4px solid ${visual.accent}`,
        background: visual.tint,
        opacity: isCancelled ? 0.7 : 1,
      }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1 min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h3
              className="text-base font-semibold"
              style={{
                textDecoration: isCancelled ? 'line-through' : undefined,
                color: isCancelled ? 'var(--ink-dim)' : undefined,
              }}
            >
              {rally.title}
            </h3>
            <span
              className="mono"
              style={{
                fontSize: 9,
                letterSpacing: '0.12em',
                color: visual.accent,
                border: `1px solid ${visual.accent}`,
                padding: '0 5px',
                lineHeight: '14px',
              }}
            >
              {visual.chipLabel}
            </span>
          </div>
          <div className="flex flex-wrap items-baseline gap-2 text-xs text-[color:var(--ink-dim)]">
            {rally.start_time && (
              <span className="mono tabular-nums">{rally.start_time.slice(0, 5)}</span>
            )}
            {dayLabel && <span>{dayLabel}</span>}
            {location && <span>· {location}</span>}
            {!rally.start_time && !dayLabel && !location && (
              <span className="text-[color:var(--ink-mute)]">No time or place set</span>
            )}
          </div>
        </div>
        {writer && (
          <button
            onClick={onDelete}
            disabled={busy}
            className="btn-hot disabled:opacity-50"
            style={{ width: 'auto' }}
          >
            Delete
          </button>
        )}
      </div>

      {rally.description && (
        <p className="text-sm text-[color:var(--ink)] leading-relaxed">{rally.description}</p>
      )}

      <RsvpPills viewerRsvp={rally.viewer_rsvp} busy={busy} onPick={onRsvp} />

      <div className="flex items-center justify-between gap-2 text-xs text-[color:var(--ink-dim)]">
        <span className="mono">
          GOING {rally.rsvp_summary.going} · MAYBE {rally.rsvp_summary.maybe} · OUT{' '}
          {rally.rsvp_summary.out}
        </span>
        {creator && (
          <span className="mono flex items-center gap-1" title={`Created by ${creator.user_id}`}>
            <span
              aria-hidden
              style={{
                width: 16,
                height: 16,
                borderRadius: '50%',
                background: 'var(--line)',
                color: 'var(--ink-dim)',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 9,
              }}
            >
              {creator.user_id.slice(0, 1).toUpperCase()}
            </span>
            <span style={{ letterSpacing: '0.1em' }}>{creator.role.toUpperCase()}</span>
            {creator.user_id === viewerUserId && (
              <span style={{ color: 'var(--acid)' }}>· YOU</span>
            )}
          </span>
        )}
      </div>
    </li>
  )
}

// Segmented pill bar — three buttons joined into one control. The
// active option fills with a status-appropriate accent; the others
// stay outlined. Mirrors festival-planner's RSVP pattern.
function RsvpPills({
  viewerRsvp,
  busy,
  onPick,
}: {
  viewerRsvp: RallyRsvpStatus | null
  busy: boolean
  onPick: (s: RallyRsvpStatus) => void
}) {
  const accent: Record<RallyRsvpStatus, string> = {
    going: 'var(--acid)',
    maybe: 'var(--accent, #f59e0b)',
    out: 'var(--hot)',
  }
  return (
    <div
      role="radiogroup"
      aria-label="RSVP"
      style={{ display: 'inline-flex', border: '1.5px solid var(--line)' }}
    >
      {RSVP_OPTIONS.map((opt, i) => {
        const active = viewerRsvp === opt.value
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onPick(opt.value)}
            disabled={busy}
            style={{
              all: 'unset',
              cursor: busy ? 'progress' : 'pointer',
              padding: '6px 12px',
              fontSize: 12,
              borderLeft: i === 0 ? 'none' : '1px solid var(--line)',
              background: active ? accent[opt.value] : 'transparent',
              color: active ? 'var(--bg)' : 'var(--ink-dim)',
              opacity: busy ? 0.5 : 1,
            }}
          >
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}

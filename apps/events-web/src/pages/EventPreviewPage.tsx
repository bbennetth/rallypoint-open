import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useAsyncTask } from '@rallypoint/web-kit'
import {
  ApiError,
  getEventPreview,
  joinEvent,
  type EventPreviewDto,
  type EventPreviewLineupDto,
} from '../lib/api.js'
import { formatEventDay } from '../lib/date-format.js'
import {
  browseEventAction,
  eventAttendDecisionHref,
  isSystemEvent,
} from '../lib/browse-route.js'

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; preview: EventPreviewDto }
  | { status: 'error'; error: ApiError | Error }

// Pre-join preview (#browse-tab): read-only event info + lineup for a
// browsable event, reachable from the Browse tab before membership.
export function EventPreviewPage() {
  const { slug } = useParams<{ slug: string }>()
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  const [joining, setJoining] = useState(false)
  const [joinError, setJoinError] = useState<string | null>(null)
  const navigate = useNavigate()
  const run = useAsyncTask()

  useEffect(() => {
    if (!slug) return
    setState({ status: 'loading' })
    void run(async (ctx) => {
      try {
        const preview = await getEventPreview(slug)
        if (ctx.stale()) return
        setState({ status: 'ready', preview })
      } catch (err) {
        if (ctx.stale()) return
        setState({ status: 'error', error: err instanceof Error ? err : new Error(String(err)) })
      }
    })
  }, [slug])

  async function handleJoin() {
    if (state.status !== 'ready' || joining) return
    setJoining(true)
    setJoinError(null)
    try {
      const { event_slug } = await joinEvent(state.preview.event.id)
      void navigate(eventAttendDecisionHref(event_slug))
    } catch (err) {
      setJoinError(err instanceof ApiError ? err.message : 'Could not join this event.')
      setJoining(false)
    }
  }

  return (
    <main className="page-pad">
      <div className="content-cap mx-auto space-y-6">
        {state.status === 'loading' && <p className="text-white/60 text-sm">Loading…</p>}

        {state.status === 'error' && (
          <div
            className="p-4"
            style={{
              background: 'var(--hot-soft)',
              color: 'var(--hot-text)',
              borderRadius: 'var(--radius-lg)',
            }}
          >
            <p className="text-sm" style={{ color: 'var(--ink)' }}>
              {state.error instanceof ApiError && state.error.code === 'event_not_found'
                ? 'This event is not open for browsing.'
                : state.error.message}
            </p>
            <Link to="/browse" className="mt-3 inline-block text-sm text-[color:var(--ink)] underline">
              Back to Browse
            </Link>
          </div>
        )}

        {state.status === 'ready' && (
          <>
            <div className="pg-head">
              <div>
                <span className="eyebrow">
                  <Link to="/browse" style={{ color: 'inherit', textDecoration: 'none' }}>
                    Browse
                  </Link>
                </span>
                <h1 style={{ marginTop: 6 }}>{state.preview.event.name}</h1>
              </div>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                {(() => {
                  const action = browseEventAction(state.preview.event)
                  return action.kind === 'join' ? (
                    <button
                      type="button"
                      disabled={joining}
                      onClick={() => void handleJoin()}
                      className="btn-brutal"
                      style={{ width: 'auto' }}
                    >
                      {joining ? 'Joining…' : 'Join event'}
                    </button>
                  ) : (
                    <Link to={action.href} className="btn-brutal" style={{ width: 'auto' }}>
                      Open event
                    </Link>
                  )
                })()}
              </div>
            </div>

            {joinError && (
              <p className="text-sm" style={{ color: 'var(--hot)' }}>
                {joinError}
              </p>
            )}

            <section className="p-4 space-y-3 pl-card">
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                {isSystemEvent(state.preview.event) ? (
                  <span className="pl-chip accent">Featured</span>
                ) : (
                  <span className="pl-chip">{state.preview.event.privacy_mode}</span>
                )}
                {state.preview.event.viewer_role !== null && (
                  <span className="pl-chip">{state.preview.event.viewer_role}</span>
                )}
                {(state.preview.event.start_date || state.preview.event.end_date) && (
                  <span className="meta">
                    {formatEventDay(state.preview.event.start_date, 'medium')}
                    {state.preview.event.end_date &&
                    state.preview.event.end_date !== state.preview.event.start_date
                      ? ` – ${formatEventDay(state.preview.event.end_date, 'medium')}`
                      : ''}
                  </span>
                )}
                {state.preview.event.location_label && (
                  <span className="meta">{state.preview.event.location_label}</span>
                )}
              </div>
              {state.preview.event.description && (
                <p className="text-sm text-white/80" style={{ whiteSpace: 'pre-wrap' }}>
                  {state.preview.event.description}
                </p>
              )}
            </section>

            {state.preview.lineup && <PreviewLineup lineup={state.preview.lineup} />}
          </>
        )}
      </div>
    </main>
  )
}

function PreviewLineup({ lineup }: { lineup: EventPreviewLineupDto }) {
  if (lineup.slots.length === 0) return null
  const stageById = new Map(lineup.stages.map((s) => [s.id, s.name]))
  // Group by day (null day = unscheduled/TBA), mirroring the public
  // page's lineup body.
  const byDay = new Map<string | null, typeof lineup.slots>()
  for (const slot of lineup.slots) {
    const list = byDay.get(slot.day_id) ?? []
    list.push(slot)
    byDay.set(slot.day_id, list)
  }
  const orderedDays = lineup.days.slice().sort((a, b) => a.sort_order - b.sort_order)
  const tba = byDay.get(null) ?? []
  return (
    <section className="p-4 space-y-3 pl-card">
      <h2 className="text-xs font-medium" style={{ color: 'var(--accent)' }}>
        Lineup
      </h2>
      <div className="space-y-3">
        {orderedDays.map((day) => {
          const rows = byDay.get(day.id) ?? []
          if (rows.length === 0) return null
          return (
            <div key={day.id}>
              <p className="text-[10px] font-medium text-[color:var(--ink-mute)]">
                {day.day_label} · {day.date}
              </p>
              <SlotList rows={rows} stageById={stageById} />
            </div>
          )
        })}
        {tba.length > 0 && (
          <div>
            <p className="text-[10px] font-medium text-[color:var(--ink-mute)]">TBA</p>
            <SlotList rows={tba} stageById={stageById} />
          </div>
        )}
      </div>
    </section>
  )
}

function SlotList({
  rows,
  stageById,
}: {
  rows: EventPreviewLineupDto['slots']
  stageById: Map<string, string>
}) {
  return (
    <ul className="mt-1 grid gap-1">
      {rows
        .slice()
        .sort((a, b) => (a.start_time ?? '').localeCompare(b.start_time ?? ''))
        .map((slot) => (
          <li
            key={`${slot.artist_id}-${slot.day_id ?? 'none'}`}
            className="flex items-baseline justify-between gap-3 text-sm"
          >
            <span className="text-white/85">
              {slot.display_name ?? slot.artist_name ?? '—'}
            </span>
            <span className="text-[10px] font-medium text-[color:var(--ink-mute)]">
              {[
                slot.stage_id ? stageById.get(slot.stage_id) : null,
                slot.start_time ? slot.start_time.slice(0, 5) : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
          </li>
        ))}
    </ul>
  )
}

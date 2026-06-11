import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  ApiError,
  getGroup,
  getGroupDay,
  listDays,
  type GroupDayDto,
  type GroupDetailDto,
  type DayDto,
} from '../lib/api.js'
import { useActiveDayStore } from '../stores/active-day.js'
import { useRefreshBus } from '../lib/refresh-bus.js'
import { ConflictBanner } from '../ui/ConflictBanner.js'
import { TodayAgenda } from '../ui/TodayAgenda.js'
import { WeatherPanel } from '../ui/WeatherPanel.js'

function todayIso(): string {
  // Local-date components, not toISOString() — otherwise users west of UTC
  // would default to tomorrow's date after UTC midnight.
  const now = new Date()
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

// 'HH:MM:SS' → 'HH:MM'; pass through anything unexpected.
function hm(time: string | null): string {
  if (!time) return ''
  const m = /^(\d{2}):(\d{2})/.exec(time)
  return m ? `${m[1]}:${m[2]}` : time
}

// Group an HH:MM:SS timestamp into an hour bucket like "14:00".
function hourBucket(time: string | null): string {
  if (!time) return '—'
  const m = /^(\d{2}):/.exec(time)
  return m ? `${m[1]}:00` : '—'
}

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; day: GroupDayDto }
  | { status: 'error'; code: string; message: string }

export function MyDayPage() {
  const { groupId } = useParams<{ groupId: string }>()
  const [group, setGroup] = useState<GroupDetailDto | null>(null)
  const [days, setDays] = useState<DayDto[]>([])
  const [date, setDate] = useState<string>(todayIso())
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  const pickDefaultForToday = useActiveDayStore((s) => s.pickDefaultForToday)
  const setActiveDayId = useActiveDayStore((s) => s.setDayId)

  const load = useCallback(() => {
    if (!groupId) return
    setState({ status: 'loading' })
    getGroup(groupId)
      .then(async (c) => {
        setGroup(c)
        const [eventDays, day] = await Promise.all([
          listDays(c.event_id).catch(() => [] as DayDto[]),
          getGroupDay(c.id, date),
        ])
        setDays(eventDays)
        // Initialise the cross-page active-day store *only* when it's
        // empty or out of date — `pickDefaultForToday` already
        // preserves an existing valid pick. Do NOT call
        // `setActiveDayId(matching.id)` here: that would clobber a
        // day the user already picked on NowPage / RalliesPage every
        // time they navigate into MyDay with the default
        // local-today date. The user's explicit picks below in
        // `onDateChange` are the only writes into the store.
        pickDefaultForToday({
          days: eventDays.map((d) => ({ id: d.id, date: d.date, sortOrder: d.sort_order })),
          today: todayIso(),
        })
        setState({ status: 'ready', day })
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
  }, [groupId, date, pickDefaultForToday])

  // Explicit user date pick — write through to the cross-page store
  // so NowPage / RalliesPage follow the same day, then re-load the
  // day view. The load() effect above no longer touches the store.
  const onDateChange = useCallback(
    (nextDate: string) => {
      setDate(nextDate)
      const matching = days.find((d) => d.date === nextDate)
      if (matching) setActiveDayId(matching.id)
    },
    [days, setActiveDayId],
  )

  useEffect(() => {
    load()
  }, [load])

  // Pull-to-refresh in the chrome calls load() again so the day data
  // and event days both revalidate without remounting the page.
  useRefreshBus(load)

  return (
    <main className="page-pad">
      <div className="max-w-2xl mx-auto space-y-5">
        <nav>
          <Link
            to={groupId ? `/groups/${groupId}` : '/me/events'}
            className="text-sm text-[color:var(--ink-mute)] hover:text-[color:var(--ink)] underline"
          >
            ← Group
          </Link>
        </nav>

        <header className="space-y-1">
          <p className="text-xs font-medium" style={{ color: 'var(--ink-mute)' }}>
            My Day
          </p>
          <h1 className="display text-2xl">{group?.name ?? 'Group'}</h1>
        </header>

        <DayPicker days={days} value={date} onChange={onDateChange} fallbackToday={todayIso()} />

        {group?.event_id && <WeatherPanel eventId={group.event_id} dayIso={date} />}

        {state.status === 'loading' && <p className="text-sm text-[color:var(--ink-dim)]">Loading…</p>}

        {state.status === 'error' && (
          <div
            className="p-4"
            style={{
              border: '1.5px solid var(--hot)',
              background: 'color-mix(in srgb, var(--hot) 12%, transparent)',
            }}
          >
            <p className="text-sm text-[color:var(--ink)]">{state.message}</p>
          </div>
        )}

        {state.status === 'ready' && <DayView day={state.day} />}
      </div>
    </main>
  )
}

function DayPicker({
  days,
  value,
  onChange,
  fallbackToday,
}: {
  days: DayDto[]
  value: string
  onChange: (date: string) => void
  fallbackToday: string
}) {
  if (days.length === 0) {
    return (
      <label className="flex items-center gap-2 text-sm text-[color:var(--ink)]">
        <span className="text-xs font-medium text-[color:var(--ink-mute)]">Date</span>
        <input
          type="date"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="cyber-input"
          style={{ width: 'auto' }}
        />
      </label>
    )
  }
  const sorted = [...days].sort((a, b) => a.sort_order - b.sort_order)
  return (
    <div className="flex gap-2 overflow-x-auto pb-1" role="tablist" aria-label="Pick a day">
      {sorted.map((d) => {
        const active = d.date === value
        const isToday = d.date === fallbackToday
        return (
          <button
            key={d.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(d.date)}
            style={{
              all: 'unset',
              cursor: active ? 'default' : 'pointer',
              padding: '6px 12px',
              border: `1px solid ${active ? 'var(--ink)' : 'var(--line)'}`,
              background: active ? 'var(--ink)' : 'var(--surface)',
              color: active ? 'var(--bg)' : 'var(--ink-dim)',
              fontSize: 12,
              fontWeight: active ? 500 : 400,
              whiteSpace: 'nowrap',
              borderRadius: 4,
            }}
          >
            {labelForDay(d.date)}
            {isToday && (
              <span
                style={{
                  marginLeft: 6,
                  fontSize: 10,
                  opacity: 0.6,
                }}
              >
                Today
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}

function labelForDay(iso: string): string {
  const d = new Date(iso + 'T00:00:00')
  if (Number.isNaN(d.getTime())) return iso
  return d
    .toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
    .toUpperCase()
}

function DayView({ day }: { day: GroupDayDto }) {
  const conflicted = new Set(day.conflicts.map((c) => c.id))
  const empty =
    day.rallies.length === 0 && day.lineup.length === 0 && day.tasks.length === 0

  return (
    <div className="space-y-5">
      <ConflictBanner conflicts={day.conflicts} />
      <TodayAgenda day={day} />

      {empty && <p className="text-sm text-[color:var(--ink-dim)]">Nothing scheduled for this day.</p>}

      {!empty && <HourAgenda day={day} conflicted={conflicted} />}
    </div>
  )
}

// Chronological list grouped by hour, mixing rallies / sets / tasks.
function HourAgenda({
  day,
  conflicted,
}: {
  day: GroupDayDto
  conflicted: Set<string>
}) {
  type Row = {
    key: string
    kind: 'rally' | 'set' | 'task'
    time: string | null
    title: React.ReactNode
    sub: React.ReactNode
    flagged: boolean
    completed?: boolean
  }
  const rows: Row[] = []
  for (const r of day.rallies) {
    rows.push({
      key: `r-${r.id}`,
      kind: 'rally',
      time: r.start_time,
      title: r.title,
      sub: r.location_label ? <span className="text-[color:var(--ink-mute)]">{r.location_label}</span> : null,
      flagged: conflicted.has(r.id),
    })
  }
  for (const s of day.lineup) {
    rows.push({
      key: `s-${s.artist_id}`,
      kind: 'set',
      time: s.start_time,
      title: s.label,
      sub: s.end_time ? (
        <span className="text-[color:var(--ink-mute)]">until {hm(s.end_time)}</span>
      ) : null,
      flagged: false,
    })
  }
  for (const t of day.tasks) {
    rows.push({
      key: `t-${t.id}`,
      kind: 'task',
      time: null,
      title: t.title,
      sub: null,
      flagged: conflicted.has(t.id),
      completed: t.completed,
    })
  }
  rows.sort((a, b) => {
    const at = a.time ?? '99:99'
    const bt = b.time ?? '99:99'
    return at.localeCompare(bt)
  })

  // Group by hour bucket for the section dividers.
  type Group = { hour: string; rows: Row[] }
  const groups: Group[] = []
  for (const row of rows) {
    const hour = hourBucket(row.time)
    const last = groups[groups.length - 1]
    if (last && last.hour === hour) last.rows.push(row)
    else groups.push({ hour, rows: [row] })
  }

  return (
    <section
      className="p-4 space-y-3"
      style={{ border: '1.5px solid var(--line)', background: 'var(--surface)' }}
    >
      <h2 className="text-xs font-medium text-[color:var(--ink-mute)]">Agenda</h2>
      <div className="space-y-3">
        {groups.map((g) => (
          <div key={g.hour} className="space-y-1">
            <div
              className="mono"
              style={{
                fontSize: 9,
                letterSpacing: '0.14em',
                color: 'var(--ink-mute)',
                borderBottom: '1px solid var(--line)',
                paddingBottom: 2,
              }}
            >
              {g.hour === '—' ? 'NO TIME' : g.hour}
            </div>
            <ul className="space-y-1">
              {g.rows.map((row) => (
                <li
                  key={row.key}
                  className="flex items-baseline gap-3 text-sm py-1"
                >
                  <KindChip kind={row.kind} />
                  {row.time && (
                    <span className="w-12 shrink-0 tabular-nums text-[color:var(--ink-mute)]" style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>
                      {hm(row.time)}
                    </span>
                  )}
                  <span className="flex-1">
                    <span className={row.completed ? 'line-through text-[color:var(--ink-mute)]' : undefined}>
                      {row.title}
                    </span>
                    {row.sub && <> · {row.sub}</>}
                  </span>
                  {row.flagged && (
                    <span className="chip" style={{ color: 'var(--hot)' }}>
                      conflict
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  )
}

function KindChip({ kind }: { kind: 'rally' | 'set' | 'task' }) {
  const label = kind === 'rally' ? 'RALLY' : kind === 'set' ? 'SET' : 'TASK'
  const color =
    kind === 'rally'
      ? 'var(--acid)'
      : kind === 'set'
        ? 'var(--accent, #f59e0b)'
        : 'var(--ink-dim)'
  return (
    <span
      className="mono"
      style={{
        fontSize: 9,
        letterSpacing: '0.1em',
        color,
        border: `1px solid ${color}`,
        padding: '0 4px',
        lineHeight: '14px',
        flexShrink: 0,
      }}
    >
      {label}
    </span>
  )
}

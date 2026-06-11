import { useEffect, useMemo, useState } from 'react'
import {
  getEventWeather,
  listDays,
  listLineup,
  listSessions,
  listStages,
  type DayDto,
  type LineupSlotDto,
  type SessionDtoFull,
  type StageDto,
} from '../../lib/api.js'
import { WeatherSection } from '../PublicEventPage.js'
import { useSoloEventOutlet } from './_solo-event-outlet.js'

// Phase 4 (#16). Solo-attendee "My Day" view. Like the group MyDayPage
// but stripped of group-coupled data (no rallies, no tasks, no group
// conflict-resolver). Day-picker rail + a chronological lineup-and-
// sessions list grouped by hour + weather.

function todayIso(): string {
  const now = new Date()
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function hm(time: string | null): string {
  if (!time) return ''
  const m = /^(\d{2}):(\d{2})/.exec(time)
  return m ? `${m[1]}:${m[2]}` : time
}

function hourBucket(time: string | null): string {
  if (!time) return '—'
  const m = /^(\d{2}):/.exec(time)
  return m ? `${m[1]}:00` : '—'
}

export function SoloMyDayPage() {
  const { event } = useSoloEventOutlet()
  const eventId = event.id
  const [stages, setStages] = useState<StageDto[]>([])
  const [days, setDays] = useState<DayDto[]>([])
  const [slots, setSlots] = useState<LineupSlotDto[]>([])
  const [sessions, setSessions] = useState<SessionDtoFull[]>([])
  const [date, setDate] = useState<string>(todayIso())

  useEffect(() => {
    let cancelled = false
    void Promise.all([
      listStages(eventId).catch(() => [] as StageDto[]),
      listDays(eventId).catch(() => [] as DayDto[]),
      listLineup(eventId).catch(() => [] as LineupSlotDto[]),
      listSessions(eventId, { approvalStatus: 'approved' }).catch(
        () => [] as SessionDtoFull[],
      ),
    ]).then(([st, dy, sl, ss]) => {
      if (cancelled) return
      setStages(st)
      setDays(dy)
      setSlots(sl)
      setSessions(ss)
      // If the local-today date matches an event day, keep it;
      // otherwise pick the earliest event day so the page doesn't
      // render empty when the user opens it well before the event.
      const today = todayIso()
      const match = dy.find((d) => d.date === today)
      if (!match && dy.length > 0) {
        const sorted = [...dy].sort((a, b) => a.sort_order - b.sort_order)
        setDate(sorted[0]!.date)
      }
    })
    return () => {
      cancelled = true
    }
  }, [eventId])

  const dayId = useMemo(() => days.find((d) => d.date === date)?.id ?? null, [days, date])

  const daySlots = slots.filter((s) => s.day_id === dayId)
  const daySessions = sessions.filter((s) => s.day_id === dayId)

  type AgendaRow = {
    key: string
    kind: 'set' | 'session'
    time: string | null
    title: React.ReactNode
    sub: React.ReactNode
  }
  const rows: AgendaRow[] = []
  for (const s of daySlots) {
    const stageName = stages.find((st) => st.id === s.stage_id)?.name ?? null
    rows.push({
      key: `s-${s.artist_id}`,
      kind: 'set',
      time: s.start_time,
      title: s.display_name,
      sub: (
        <>
          {stageName && <span className="text-white/55">{stageName}</span>}
          {s.end_time && (
            <span className="text-white/55">{stageName ? ' · ' : ''}until {hm(s.end_time)}</span>
          )}
        </>
      ),
    })
  }
  for (const s of daySessions) {
    rows.push({
      key: `x-${s.id}`,
      kind: 'session',
      time: s.start_time,
      title: s.title,
      sub: s.end_time ? <span className="text-white/55">until {hm(s.end_time)}</span> : null,
    })
  }
  rows.sort((a, b) => (a.time ?? '99:99').localeCompare(b.time ?? '99:99'))

  type Group = { hour: string; rows: AgendaRow[] }
  const groups: Group[] = []
  for (const r of rows) {
    const hour = hourBucket(r.time)
    const last = groups[groups.length - 1]
    if (last && last.hour === hour) last.rows.push(r)
    else groups.push({ hour, rows: [r] })
  }

  return (
    <main className="page-pad">
      <div className="max-w-2xl mx-auto space-y-5">
        <header className="space-y-1">
          <p className="text-xs font-medium" style={{ color: 'var(--acid)' }}>
            My Day · solo
          </p>
          <h1 className="display text-2xl">{event.name}</h1>
        </header>

        <DayPicker days={days} value={date} onChange={setDate} fallbackToday={todayIso()} />

        <WeatherSection fetcher={() => getEventWeather(event.id)} />

        {rows.length === 0 ? (
          <p className="text-sm text-white/60">Nothing scheduled for this day.</p>
        ) : (
          <section
            className="p-4 space-y-3"
            style={{ border: '1.5px solid var(--line)', background: 'var(--surface)' }}
          >
            <h2 className="text-xs font-medium text-[color:var(--ink-mute)]">
              Agenda
            </h2>
            <div className="space-y-3">
              {groups.map((g) => (
                <div key={g.hour} className="space-y-1">
                  <div
                    style={{
                      fontSize: 9,
                      color: 'var(--ink-mute)',
                      borderBottom: '1px solid var(--line)',
                      paddingBottom: 2,
                    }}
                  >
                    {g.hour === '—' ? 'No time' : g.hour}
                  </div>
                  <ul className="space-y-1">
                    {g.rows.map((r) => (
                      <li
                        key={r.key}
                        className="flex items-baseline gap-3 text-sm py-1"
                      >
                        <KindChip kind={r.kind} />
                        {r.time && (
                          <span className="font-mono w-12 shrink-0 tabular-nums text-[color:var(--ink-mute)]">
                            {hm(r.time)}
                          </span>
                        )}
                        <span className="flex-1">
                          {r.title}
                          {r.sub && <> · {r.sub}</>}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </main>
  )
}

function KindChip({ kind }: { kind: 'set' | 'session' }) {
  const label = kind === 'set' ? 'SET' : 'SESS'
  const color = kind === 'set' ? 'var(--accent, #f59e0b)' : 'var(--ink-dim)'
  return (
    <span
      style={{
        fontSize: 9,
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
      <label className="flex items-center gap-2 text-sm text-white/80">
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
              padding: '8px 12px',
              border: `1.5px solid ${active ? 'var(--acid)' : 'var(--line)'}`,
              background: active ? 'var(--acid)' : 'var(--surface)',
              color: active ? 'var(--bg)' : 'var(--ink-dim)',
              fontSize: 11,
              whiteSpace: 'nowrap',
            }}
          >
            {labelForDay(d.date)}
            {isToday && (
              <span style={{ marginLeft: 6, fontSize: 9, opacity: 0.7 }}>TODAY</span>
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

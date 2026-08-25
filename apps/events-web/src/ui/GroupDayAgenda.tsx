import type { GroupDayDto } from '../lib/api.js'
import { buildHourGroups, hm } from '../lib/attendee-day.js'
import { ConflictBanner } from './ConflictBanner.js'
import { TodayAgenda } from './TodayAgenda.js'

// The group's plan for one day — rallies, sets and tasks merged into a
// single chronological agenda, with the conflict resolver on top. Lives in
// the Now tab under the day picker (it was its own "My Day" tab before the
// two merged).

interface AgendaRow {
  key: string
  kind: 'rally' | 'set' | 'task'
  time: string | null
  title: React.ReactNode
  sub: React.ReactNode
  flagged: boolean
  completed?: boolean
}

export function GroupDayAgenda({ day, isToday = true }: { day: GroupDayDto; isToday?: boolean }) {
  const conflicted = new Set(day.conflicts.map((c) => c.id))
  const empty = day.rallies.length === 0 && day.lineup.length === 0 && day.tasks.length === 0

  return (
    <div className="space-y-5">
      <ConflictBanner conflicts={day.conflicts} />
      <TodayAgenda day={day} title={isToday ? 'Up next' : 'First up'} />

      {empty && (
        <p className="text-sm text-[color:var(--ink-dim)]">Nothing scheduled for this day.</p>
      )}

      {!empty && <HourAgenda day={day} conflicted={conflicted} />}
    </div>
  )
}

// Chronological list grouped by hour, mixing rallies / sets / tasks.
function HourAgenda({ day, conflicted }: { day: GroupDayDto; conflicted: Set<string> }) {
  const rows: AgendaRow[] = []
  for (const r of day.rallies) {
    rows.push({
      key: `r-${r.id}`,
      kind: 'rally',
      time: r.start_time,
      title: r.title,
      sub: r.location_label ? (
        <span className="text-[color:var(--ink-mute)]">{r.location_label}</span>
      ) : null,
      flagged: conflicted.has(r.id),
    })
  }
  for (const s of day.lineup) {
    // Artist-favorite overlay: your favorite marks the row with a heart;
    // other group members who favorited the artist show as a name chip.
    const favBy = s.favorited_by ?? []
    rows.push({
      key: `s-${s.artist_id}`,
      kind: 'set',
      time: s.start_time,
      title: s.favorited ? (
        <span style={{ color: 'var(--hot)' }}>
          ♥ <span style={{ color: 'var(--ink)' }}>{s.label}</span>
        </span>
      ) : (
        s.label
      ),
      sub:
        s.end_time || favBy.length > 0 ? (
          <span className="text-[color:var(--ink-mute)]">
            {s.end_time ? `until ${hm(s.end_time)}` : null}
            {s.end_time && favBy.length > 0 ? ' · ' : null}
            {favBy.length > 0 && (
              <span
                style={{ color: 'var(--hot)' }}
                title={favBy.map((m) => m.display_name ?? 'member').join(', ')}
              >
                ♥ {favBy
                  .slice(0, 3)
                  .map((m) => (m.display_name ?? 'member').split(/\s+/)[0])
                  .join(', ')}
                {favBy.length > 3 ? ` +${favBy.length - 3}` : ''}
              </span>
            )}
          </span>
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

  const groups = buildHourGroups(rows)

  return (
    <section
      className="p-4 space-y-3 pl-card"
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
                borderBottom: '1px solid var(--hairline-soft)',
                paddingBottom: 2,
              }}
            >
              {g.hour === '—' ? 'NO TIME' : g.hour}
            </div>
            <ul className="space-y-1">
              {g.rows.map((row) => (
                <li key={row.key} className="flex items-baseline gap-3 text-sm py-1">
                  <KindChip kind={row.kind} />
                  {row.time && (
                    <span
                      className="w-12 shrink-0 tabular-nums text-[color:var(--ink-mute)]"
                      style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}
                    >
                      {hm(row.time)}
                    </span>
                  )}
                  <span className="flex-1">
                    <span
                      className={
                        row.completed ? 'line-through text-[color:var(--ink-mute)]' : undefined
                      }
                    >
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
        ? 'var(--ev-warn)'
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

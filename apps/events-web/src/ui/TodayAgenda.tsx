import type { GroupDayDto } from '../lib/api.js'

// Festival-planner-style "next 3" rail rendered at the top of My Day.
// Mixes rallies, lineup, and tasks for the picked day; sorted by
// start_time; capped at 3 entries.

type AgendaEntry =
  | { kind: 'rally'; id: string; ts: string; label: string; sub: string | null }
  | { kind: 'set'; id: string; ts: string; label: string; sub: string | null }
  | { kind: 'task'; id: string; ts: string; label: string; sub: string | null }

function hm(time: string | null | undefined): string {
  if (!time) return ''
  const m = /^(\d{2}):(\d{2})/.exec(time)
  return m ? `${m[1]}:${m[2]}` : time
}

export function TodayAgenda({ day, max = 3 }: { day: GroupDayDto; max?: number }) {
  const entries: AgendaEntry[] = []
  for (const r of day.rallies) {
    if (r.status === 'cancelled') continue
    entries.push({
      kind: 'rally',
      id: r.id,
      ts: r.start_time ?? '99:99',
      label: r.title,
      sub: r.location_label,
    })
  }
  for (const s of day.lineup) {
    entries.push({
      kind: 'set',
      id: s.artist_id,
      ts: s.start_time ?? '99:99',
      label: s.label,
      sub: s.end_time ? `until ${hm(s.end_time)}` : null,
    })
  }
  for (const t of day.tasks) {
    if (t.completed) continue
    entries.push({
      kind: 'task',
      id: t.id,
      ts: '00:00', // tasks have no time; sort to top
      label: t.title,
      sub: null,
    })
  }
  entries.sort((a, b) => a.ts.localeCompare(b.ts))
  const visible = entries.slice(0, max)
  if (visible.length === 0) return null

  return (
    <section
      className="p-4"
      style={{ border: '1px solid var(--line)', background: 'var(--surface)' }}
    >
      <h2 className="text-xs font-medium" style={{ color: 'var(--ink-mute)' }}>
        Up next
      </h2>
      <ul className="mt-2 space-y-1">
        {visible.map((e) => (
          <li
            key={`${e.kind}-${e.id}`}
            className="flex items-baseline gap-3 text-sm"
          >
            {e.kind !== 'task' && (
              <span
                className="tabular-nums shrink-0"
                style={{ color: 'var(--ink-mute)', fontSize: 12, fontFamily: 'var(--font-mono)' }}
              >
                {hm(e.ts)}
              </span>
            )}
            <span className="flex-1 font-medium" style={{ color: 'var(--ink)' }}>
              {e.label}
              {e.sub && <span style={{ color: 'var(--ink-mute)', fontWeight: 400 }}> · {e.sub}</span>}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

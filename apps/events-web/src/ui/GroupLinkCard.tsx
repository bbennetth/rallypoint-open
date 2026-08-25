import { Link } from 'react-router-dom'
import type { GroupDto } from '../lib/api.js'

// One row in a "your groups" list. Links into the group attendee shell.
// Shared by the event's Group tab and the cross-links inside a group, so
// a group reads the same wherever it's listed.

export function GroupLinkCard({ group }: { group: GroupDto }) {
  const count = group.member_count
  return (
    <Link
      to={`/groups/${encodeURIComponent(group.id)}`}
      style={{
        textDecoration: 'none',
        display: 'block',
        background: 'var(--surface)',
        borderRadius: 'var(--radius-lg)',
        boxShadow: 'var(--shadow-card)',
      }}
      className="p-4 hover:bg-white/10 transition-colors"
    >
      <div
        style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}
      >
        <span className="display" style={{ fontSize: 15, letterSpacing: '0.02em' }}>
          {group.name}
        </span>
        {group.viewer_role === 'owner' || group.viewer_role === 'sidekick' ? (
          <span
            className="mono"
            style={{
              fontSize: 10,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              color: 'var(--ink-mute)',
            }}
          >
            {group.viewer_role}
          </span>
        ) : null}
      </div>
      <p className="text-xs mt-1" style={{ color: 'var(--ink-dim)' }}>
        {count === undefined ? '' : count === 1 ? '1 member' : `${count} members`}
      </p>
    </Link>
  )
}

// A gapped stack of cards — each group gets its own soft-ink card
// rather than sharing one bordered container with row dividers.
export function GroupLinkList({ groups }: { groups: readonly GroupDto[] }) {
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      {groups.map((g) => (
        <GroupLinkCard key={g.id} group={g} />
      ))}
    </div>
  )
}

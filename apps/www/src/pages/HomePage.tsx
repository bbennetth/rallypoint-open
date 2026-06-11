import { Link } from 'react-router-dom'
import { PageShell } from '../ui/PageShell.js'
import { OPEN_REPO_URL } from '../config.js'

function ProductCard({
  to,
  name,
  blurb,
}: {
  to: string
  name: string
  blurb: string
}) {
  return (
    <Link
      to={to}
      style={{
        textDecoration: 'none',
        color: 'inherit',
        display: 'grid',
        gap: 8,
        padding: 20,
        border: '1.5px solid var(--line)',
        background: 'var(--surface)',
      }}
    >
      <h2 className="display" style={{ fontSize: 20, margin: 0 }}>
        {name}
      </h2>
      <p style={{ fontSize: 14, color: 'var(--ink-dim)', margin: 0 }}>{blurb}</p>
      <span className="mono" style={{ fontSize: 12, color: 'var(--acid)' }}>
        Learn more →
      </span>
    </Link>
  )
}

export function HomePage() {
  return (
    <PageShell>
      <div style={{ display: 'grid', gap: 40 }}>
        <header style={{ display: 'grid', gap: 14, maxWidth: 640 }}>
          <h1 className="display" style={{ fontSize: 40, margin: 0, lineHeight: 1.1 }}>
            One account for your plans and your events.
          </h1>
          <p style={{ fontSize: 16, color: 'var(--ink-dim)', margin: 0 }}>
            Rallypoint is a small suite of tools that share a single sign-in.
            Plan your day, manage events with your team, and keep everything
            under one Rallypoint ID.
          </p>
        </header>

        <section
          style={{
            display: 'grid',
            gap: 16,
            gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
          }}
        >
          <ProductCard
            to="/planner"
            name="Planner"
            blurb="Your day and what's coming up — tasks, notes, and personal events in one place."
          />
          <ProductCard
            to="/events"
            name="Events"
            blurb="Create and run events with your team: lineups, schedules, maps, and groups."
          />
        </section>

        <section style={{ display: 'grid', gap: 8, maxWidth: 640 }}>
          <h2 className="display" style={{ fontSize: 18, margin: 0 }}>
            Open source
          </h2>
          <p style={{ fontSize: 14, color: 'var(--ink-dim)', margin: 0 }}>
            Rallypoint is built in the open. Read the code, file issues, or run
            it yourself.
          </p>
          <a href={OPEN_REPO_URL} className="btn-ghost" style={{ width: 'auto', justifySelf: 'start' }}>
            View on GitHub ↗
          </a>
        </section>
      </div>
    </PageShell>
  )
}

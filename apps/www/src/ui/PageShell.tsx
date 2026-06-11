import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { BrandLockup } from '@rallypoint/ui'
import { ThemeToggle } from './ThemeToggle.js'
import { OPEN_REPO_URL, RPID_UI_URL } from '../config.js'

// Shared chrome for every apex page: a brand header with nav + theme
// toggle, the page body capped to a readable column, and a quiet footer
// with the open-source link.
export function PageShell({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        minHeight: '100dvh',
        background: 'var(--bg)',
        color: 'var(--ink)',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <header
        className="page-pad"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 16,
          paddingTop: 18,
          paddingBottom: 18,
          borderBottom: '1.5px solid var(--line)',
        }}
      >
        <Link to="/" style={{ textDecoration: 'none', color: 'inherit' }}>
          <BrandLockup size={20} />
        </Link>
        <nav style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
          <Link to="/planner" className="mono" style={{ fontSize: 13, color: 'var(--ink-dim)' }}>
            Planner
          </Link>
          <Link to="/events" className="mono" style={{ fontSize: 13, color: 'var(--ink-dim)' }}>
            Events
          </Link>
          <a
            href={RPID_UI_URL}
            className="mono"
            style={{ fontSize: 13, color: 'var(--ink-dim)' }}
          >
            Sign in
          </a>
          <ThemeToggle />
        </nav>
      </header>

      <main
        className="page-pad"
        style={{
          flex: 1,
          width: '100%',
          paddingTop: 48,
          paddingBottom: 64,
        }}
      >
        <div className="content-cap" style={{ width: '100%', margin: '0 auto' }}>
          {children}
        </div>
      </main>

      <footer
        className="page-pad"
        style={{
          borderTop: '1.5px solid var(--line)',
          paddingTop: 18,
          paddingBottom: 18,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 16,
          flexWrap: 'wrap',
        }}
      >
        <span className="mono" style={{ fontSize: 12, color: 'var(--ink-dim)' }}>
          Rallypoint
        </span>
        <a
          href={OPEN_REPO_URL}
          className="mono"
          style={{ fontSize: 12, color: 'var(--ink-dim)' }}
        >
          Open source — rallypoint-open ↗
        </a>
      </footer>
    </div>
  )
}

import { Link, useLocation } from 'react-router-dom'
import { Logo } from './Logo.js'
import { CMD_REPO_URL, PLANNER_WEB_URL, RPID_UI_URL } from '../config.js'

// Sticky translucent header shared by every page. The active page's nav
// link gets `.on`; text links hide under 880px (per design — no hamburger,
// the two buttons stay). The Cmd page swaps the solid CTA for the repo
// link (Cmd is self-hosted; there is no hosted app to open).
export function SiteHeader() {
  const { pathname } = useLocation()
  const on = (path: string) => `lnk${pathname === path ? ' on' : ''}`

  return (
    <header className="site">
      <div className="wrap hd-in">
        <Link className="lock" to="/" aria-label="Rallypoint home">
          <span style={{ color: 'var(--ink)', display: 'flex' }}>
            <Logo />
          </span>
          <span className="wm">
            rally<b>pt</b>
          </span>
        </Link>
        <nav className="main">
          <Link className={on('/planner')} to="/planner">
            Planner
          </Link>
          <Link className={on('/health')} to="/health">
            Health
          </Link>
          <Link className="lnk" to="/#events">
            Events
          </Link>
          <Link className={on('/cmd')} to="/cmd">
            Cmd
          </Link>
          <Link className="lnk" to="/#open-source">
            Open source
          </Link>
          <a className="btn" href={RPID_UI_URL}>
            Sign in
          </a>
          {pathname === '/cmd' ? (
            <a className="btn solid" href={CMD_REPO_URL}>
              GitHub ↗
            </a>
          ) : (
            <a className="btn solid" href={PLANNER_WEB_URL}>
              Open app
            </a>
          )}
        </nav>
      </div>
    </header>
  )
}

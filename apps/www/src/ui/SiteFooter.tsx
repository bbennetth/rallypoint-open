import { Link, useLocation } from 'react-router-dom'
import { CMD_REPO_URL, OPEN_REPO_URL } from '../config.js'

// Mono footer shared by every page. Subpages add a Home link; each page
// links the other product pages (never itself), matching the mocks. The
// GitHub link points at the page's own repo (Cmd page → rallypoint-cmd).
export function SiteFooter() {
  const { pathname } = useLocation()
  const home = pathname === '/'

  return (
    <footer className="site">
      <div className="wrap ft-in">
        <span className="l">© Rallypoint — Plan your day. Run your events.</span>
        <nav className="ft-nav">
          {!home && <Link to="/">Home</Link>}
          {pathname !== '/planner' && <Link to="/planner">Planner</Link>}
          {pathname !== '/health' && <Link to="/health">Health</Link>}
          {pathname !== '/cmd' && <Link to="/cmd">Cmd</Link>}
          <a href={pathname === '/cmd' ? CMD_REPO_URL : OPEN_REPO_URL}>GitHub ↗</a>
        </nav>
      </div>
    </footer>
  )
}

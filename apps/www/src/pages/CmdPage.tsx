import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Seo } from '../ui/Seo.js'
import { SiteHeader } from '../ui/SiteHeader.js'
import { SiteFooter } from '../ui/SiteFooter.js'
import { CMD_REPO_URL } from '../config.js'

function Cap({ icon, title, body }: { icon?: ReactNode; title: string; body: string }) {
  return (
    <div className="cap">
      {icon && <span className="ci">{icon}</span>}
      <h3>{title}</h3>
      <p>{body}</p>
    </div>
  )
}

const ICON = { width: 22, height: 22, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' } as const

export function CmdPage() {
  return (
    <>
      <Seo path="/cmd" />
      <SiteHeader />

      <section className="p-hero" style={{ padding: '72px 0 56px' }}>
        <div className="wrap">
          <span className="eyebrow">Cmd — for your server</span>
          <h1 className="hero-h" style={{ fontSize: 'clamp(38px,5.8vw,68px)' }}>
            Your game server,
            <br />
            <span className="ac">under command.</span>
          </h1>
          <p className="lede">
            Cmd is a self-hosted control panel for a dedicated game server: a live dashboard,
            console, players, mods, scheduled backups, and one-click updates — running on your
            own hardware, behind your own login. Palworld is the first supported game.
          </p>
          <div
            style={{ display: 'flex', gap: 12, justifyContent: 'center', marginTop: 30, flexWrap: 'wrap' }}
          >
            <a className="btn solid lg" href={CMD_REPO_URL}>
              View on GitHub ↗
            </a>
            <a className="btn lg" href="#install">
              One-command install
            </a>
          </div>
          <div className="chips">
            <span className="chip">Self-hosted</span>
            <span className="chip">Open source</span>
            <span className="chip">Palworld first</span>
            <span className="chip">LAN-first</span>
          </div>
        </div>
      </section>

      <section className="sec" style={{ padding: '0 0 72px' }}>
        <div className="wrap">
          <div className="panel-strip" aria-hidden>
            <div className="pt">
              <span className="k">Server</span>
              <span className="v ok">Running</span>
            </div>
            <div className="pt">
              <span className="k">Players</span>
              <span className="v">4</span>
              <span className="u">/ 32</span>
            </div>
            <div className="pt">
              <span className="k">Last backup</span>
              <span className="v">02:00</span>
              <span className="u">nightly</span>
            </div>
            <div className="pt">
              <span className="k">Uptime</span>
              <span className="v">6d 4h</span>
            </div>
          </div>
        </div>
      </section>

      <section className="sec" style={{ paddingTop: 0 }}>
        <div className="wrap">
          <div className="eye">
            <b>What's in the panel</b>
            <i></i>
          </div>
          <h2 className="sec-h">Everything but the SSH session.</h2>
          <div className="feat-g">
            <Cap
              icon={
                <svg {...ICON}>
                  <rect x="2" y="2.5" width="12" height="11" rx="1" />
                  <path d="M5 11V8M8 11V5.5M11 11V9" />
                </svg>
              }
              title="Dashboard"
              body="Server status, CPU and memory, and start / stop / restart from one screen."
            />
            <Cap
              icon={
                <svg {...ICON}>
                  <rect x="2" y="2.5" width="12" height="11" rx="1" />
                  <path d="M4.5 6l2 2-2 2M8 10.5h3.5" />
                </svg>
              }
              title="Live console"
              body="The server log as it happens, with a command line when you need one."
            />
            <Cap
              icon={
                <svg {...ICON}>
                  <circle cx="5" cy="5.5" r="2.2" />
                  <path d="M1.5 12.5a3.8 3.8 0 0 1 7 0" />
                  <circle cx="11.5" cy="5.5" r="2.2" />
                  <path d="M9.6 9.2a3.8 3.8 0 0 1 4.9 3.3" />
                </svg>
              }
              title="Players"
              body="Who's on right now, and who's been on — straight from the server's API."
            />
            <Cap
              icon={
                <svg {...ICON}>
                  <path
                    d="M6.5 2h3v2.2l1.9 1.1 1.9-1.1 1.5 2.6-1.9 1.1v2.2l1.9 1.1-1.5 2.6-1.9-1.1L9.5 13.8V16h-3"
                    transform="scale(.82) translate(1.2 -.6)"
                  />
                  <circle cx="8" cy="8" r="2.2" />
                </svg>
              }
              title="Mods"
              body="Install and manage server mods without touching the filesystem."
            />
            <Cap
              icon={
                <svg {...ICON}>
                  <circle cx="8" cy="8" r="6.2" />
                  <path d="M8 4.4V8l2.6 1.6" />
                </svg>
              }
              title="Backups & schedules"
              body="Nightly snapshots with retention, one-click restore, and scheduled restarts."
            />
            <Cap
              icon={
                <svg {...ICON}>
                  <path d="M8 2.4v7.6M5 7.4L8 10.4l3-3" />
                  <path d="M3 12.6h10" />
                </svg>
              }
              title="Updates"
              body="Update the game via SteamCMD — and the panel updates itself from GitHub Releases, with the game still running."
            />
          </div>
        </div>
      </section>

      <section className="sec" id="install" style={{ paddingTop: 0 }}>
        <div className="wrap">
          <div className="eye">
            <b>Install</b>
            <i></i>
          </div>
          <h2 className="sec-h">One command. Whole stack.</h2>
          <div className="cmd" style={{ marginTop: 28 }}>
            <div className="cl">
              <code>bash -c "$(curl -fsSL …/ct/rallypoint-cmd.sh)"</code>
              <span className="cd">
                On your Proxmox host — creates the container, installs the game server, starts
                the panel, and prints your URL and login.
              </span>
            </div>
            <div className="cl">
              <code>same command, inside the container</code>
              <span className="cd">
                Detects an existing install and switches to update mode. The game keeps running.
              </span>
            </div>
            <div className="cl">
              <code>Updates → Rallypoint</code>
              <span className="cd">
                From then on the panel updates itself — it checks GitHub Releases daily and
                applies updates in one click.
              </span>
            </div>
          </div>
        </div>
      </section>

      <section className="sec" style={{ paddingTop: 0 }}>
        <div className="wrap">
          <div className="eye">
            <b>Run it yourself</b>
            <i></i>
          </div>
          <h2 className="sec-h">Your hardware. Your rules.</h2>
          <div className="host">
            <Cap
              title="One box, whole stack"
              body="A single container holds the panel, SteamCMD, and the dedicated server — nothing to assemble by hand."
            />
            <Cap
              title="Least-privilege"
              body="The panel can start, stop, and restart the server — and nothing else. The install itself stays root-owned and read-only."
            />
            <Cap
              title="LAN-first"
              body="Reachable on your network out of the box; switch to tunnel-only when you want remote access. The game's admin API never leaves the box."
            />
            <Cap
              title="More games to come"
              body="Palworld is the first supported game — the panel is built as a general server console, not a one-off."
            />
          </div>
        </div>
      </section>

      <section className="band" style={{ padding: '0 0 84px', textAlign: 'center' }}>
        <div className="wrap">
          <h2 className="sec-h" style={{ maxWidth: 'none' }}>
            Bring the server in-house.
          </h2>
          <p className="desc" style={{ margin: '16px auto 0' }}>
            Open source, self-hosted, and installed before the lobby fills.
          </p>
          <div
            style={{ display: 'inline-flex', gap: 12, marginTop: 28, flexWrap: 'wrap', justifyContent: 'center' }}
          >
            <a className="btn solid lg" href={CMD_REPO_URL}>
              View on GitHub ↗
            </a>
            <Link className="btn lg" to="/">
              Back to Rallypoint
            </Link>
          </div>
        </div>
      </section>

      <SiteFooter />
    </>
  )
}

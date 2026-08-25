import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Seo } from '../ui/Seo.js'
import { SiteHeader } from '../ui/SiteHeader.js'
import { SiteFooter } from '../ui/SiteFooter.js'
import { LogoWatermark } from '../ui/Logo.js'
import { Shot } from '../ui/Shot.js'
import {
  CMD_REPO_URL,
  EVENTS_WEB_URL,
  OPEN_REPO_URL,
  PLANNER_WEB_URL,
} from '../config.js'

function Cap({ icon, title, body }: { icon: ReactNode; title: string; body: string }) {
  return (
    <div className="cap">
      <span className="ci">{icon}</span>
      <h3>{title}</h3>
      <p>{body}</p>
    </div>
  )
}

const ICON = { width: 22, height: 22, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' } as const

export function HomePage() {
  return (
    <>
      <Seo path="/" />
      <SiteHeader />

      <section className="hero" id="top">
        <div className="hero-cmp" aria-hidden>
          <LogoWatermark />
        </div>
        <div className="wrap hero-in">
          <div>
            <span className="eyebrow">One account · Every app</span>
            <h1 className="hero-h">
              Plan your day.
              <br />
              <span className="ac">Train. Rally. Sync.</span>
            </h1>
            <p className="lede">
              Rallypoint is an offline-ready suite that shares a single account — a fast daily{' '}
              <strong>Planner</strong>, a <strong>Health</strong> training log, and an{' '}
              <strong>Events</strong> workspace for your crew. And for when the crew logs on:{' '}
              <strong>Cmd</strong>, a self-hosted control panel for your game server.
            </p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 32 }}>
              <a className="btn solid lg" href={PLANNER_WEB_URL}>
                Open Planner →
              </a>
              <a className="btn lg" href="#products">
                See the apps
              </a>
            </div>
            <div className="chips">
              <span className="chip">Offline-ready</span>
              <span className="chip">Real-time sync</span>
              <span className="chip">Open source</span>
              <span className="chip">Installable PWA</span>
            </div>
          </div>
          <div className="hero-phones">
            <div className="phone-col">
              <Shot width={216} placeholder="Planner — My Day (390×844)" />
            </div>
            <div className="phone-col">
              <Shot width={216} placeholder="Health — Today (390×844)" />
            </div>
          </div>
        </div>
      </section>

      <section className="prod" id="products">
        <div className="wrap g2">
          <div>
            <span className="idx">01 — Planner</span>
            <h2>Your whole day, in one agenda.</h2>
            <p className="desc">
              <strong>My Day</strong> brings your schedule, tasks, recurring chores, shopping
              lists, notes, and diary into a single agenda — backed by a week and month calendar,
              live weather, and push reminders.
            </p>
            <div className="chips">
              <span className="chip">My Day</span>
              <span className="chip">Tasks &amp; chores</span>
              <span className="chip">Shopping</span>
              <span className="chip">Notes</span>
              <span className="chip">Diary</span>
              <span className="chip">Calendar</span>
            </div>
            <Link className="go" to="/planner">
              Explore Planner →
            </Link>
          </div>
          <div className="prod-shots" style={{ order: -1 }}>
            <Shot width={230} placeholder="Planner — My Day" caption="My Day" />
          </div>
        </div>
      </section>

      <section className="prod">
        <div className="wrap g2">
          <div className="prod-shots" style={{ order: 2 }}>
            <Shot width={230} placeholder="Health — Live workout" caption="Live workout" />
          </div>
          <div>
            <span className="idx">02 — Health</span>
            <h2>Log the work. Watch it add up.</h2>
            <p className="desc">
              A training log that keeps pace with you: live workout logging with per-set
              check-offs and a rest timer, a weekly plan grid, meals and macros alongside the
              training, and stats that show streaks, volume, and PRs.
            </p>
            <div className="chips">
              <span className="chip">Live logging</span>
              <span className="chip">Rest timer</span>
              <span className="chip">Weekly plan</span>
              <span className="chip">Nutrition</span>
              <span className="chip">Stats &amp; PRs</span>
            </div>
            <Link className="go" to="/health">
              Explore Health →
            </Link>
          </div>
        </div>
      </section>

      <section className="prod" id="events">
        <div className="wrap g2">
          <div>
            <span className="idx">03 — Events</span>
            <h2>Get the whole crew to the same spot.</h2>
            <p className="desc">
              An events workspace for festivals, trips, and race weekends: lineups you can star,
              interactive site maps, group chat, and rallies — a time and a place your crew can
              RSVP to.
            </p>
            <div className="chips">
              <span className="chip">Lineups</span>
              <span className="chip">Site maps</span>
              <span className="chip">Group chat</span>
              <span className="chip">Rallies &amp; RSVP</span>
            </div>
            <a className="go" href={EVENTS_WEB_URL}>
              Open Events →
            </a>
          </div>
          <div className="prod-shots" style={{ order: -1 }}>
            <Shot width={230} placeholder="Events — Site map" caption="Site map" />
          </div>
        </div>
      </section>

      <section className="prod">
        <div className="wrap g2">
          <div>
            <span className="idx">04 — Cmd</span>
            <h2>Your game server, under command.</h2>
            <p className="desc">
              A self-hosted control panel for your crew's dedicated game server — dashboard, live
              console, players, mods, scheduled backups, and one-click updates. One command
              installs the whole stack on your own hardware. Palworld is the first supported
              game.
            </p>
            <div className="chips">
              <span className="chip">Self-hosted</span>
              <span className="chip">One-command install</span>
              <span className="chip">Backups</span>
              <span className="chip">Palworld first</span>
            </div>
            <Link className="go" to="/cmd">
              Explore Cmd →
            </Link>
          </div>
          <div
            className="bridge-vis"
            role="img"
            aria-label="Panel snapshot: server running with four players, nightly backups, updates for game and panel."
          >
            <div className="bv-row">
              <div className="bv-node bv-core">
                Server<small>running · 4 players</small>
              </div>
              <div className="bv-node">
                Backups<small>nightly · one-click restore</small>
              </div>
              <div className="bv-node">
                Updates<small>game + panel</small>
              </div>
            </div>
            <div className="bv-meta">
              <span className="chip">Dashboard</span>
              <span className="chip">Console</span>
              <span className="chip">Players</span>
              <span className="chip">Mods</span>
              <span className="chip">Schedules</span>
            </div>
          </div>
        </div>
      </section>

      <section className="sec" style={{ paddingTop: 0 }}>
        <div className="wrap">
          <span className="eyebrow">Why Rallypoint</span>
          <h2 className="sec-h">One account. Zero friction.</h2>
          <div className="g3" style={{ marginTop: 36 }}>
            <Cap
              icon={
                <svg {...ICON}>
                  <path d="M2.5 6.5A5 5 0 0 1 12 5.2l1.5 1.3" />
                  <path d="M13.5 3v3.5H10" />
                  <path d="M13.5 9.5A5 5 0 0 1 4 10.8L2.5 9.5" />
                  <path d="M2.5 13V9.5H6" />
                </svg>
              }
              title="Offline-first"
              body="Everything keeps working without a signal and syncs the second you're back online."
            />
            <Cap
              icon={
                <svg {...ICON}>
                  <circle cx="8" cy="8" r="6.2" />
                  <path d="M8 4.4V8l2.6 1.6" />
                </svg>
              }
              title="One account"
              body="A single Rallypoint ID signs you into every app — switch apps in a tap."
            />
            <Cap
              icon={
                <svg {...ICON}>
                  <circle cx="8" cy="8" r="2" />
                  <path d="M8 1.4v2.1M8 12.5v2.1M1.4 8h2.1M12.5 8h2.1M3.3 3.3l1.5 1.5M11.2 11.2l1.5 1.5M12.7 3.3l-1.5 1.5M4.8 11.2l-1.5 1.5" />
                </svg>
              }
              title="Real-time sync"
              body="Edits from your crew — a starred set, a checked-off chore — show up live."
            />
            <Cap
              icon={
                <svg {...ICON}>
                  <rect x="2.2" y="2.2" width="4.6" height="4.6" rx="1" />
                  <rect x="9.2" y="2.2" width="4.6" height="4.6" rx="1" />
                  <rect x="2.2" y="9.2" width="4.6" height="4.6" rx="1" />
                  <rect x="9.2" y="9.2" width="4.6" height="4.6" rx="1" />
                </svg>
              }
              title="Cross-device"
              body="Use it in any browser today, or install it to your phone's home screen as a PWA."
            />
            <Cap
              icon={
                <svg {...ICON}>
                  <path d="M8 2.4v7.6M5 7.4L8 10.4l3-3" />
                  <path d="M3 12.6h10" />
                </svg>
              }
              title="Open source"
              body="Read every line, file an issue, or run it yourself — Rallypoint is built in the open."
            />
            <Cap
              icon={
                <svg {...ICON}>
                  <path d="M8 14.5s5-4.4 5-8a5 5 0 0 0-10 0c0 3.6 5 8 5 8z" />
                  <circle cx="8" cy="6.5" r="1.8" />
                </svg>
              }
              title="Yours to keep"
              body="Your plans and your crew — no engagement feeds to farm, no noise. Just your stuff."
            />
          </div>
        </div>
      </section>

      <section className="band">
        <div className="wrap">
          <h2>
            Plan it. Train for it.
            <br />
            <span className="ac">Rally the crew.</span>
          </h2>
          <p className="sub">
            Start with your day in Planner, log the work in Health, bring the crew into Events.
          </p>
          <div className="bcta">
            <a className="btn solid lg" href={PLANNER_WEB_URL}>
              Open Planner →
            </a>
            <Link className="btn lg" to="/cmd">
              Cmd for your server →
            </Link>
          </div>
        </div>
      </section>

      <section className="sec" id="open-source" style={{ paddingTop: 0 }}>
        <div className="wrap">
          <span className="eyebrow">Free &amp; open</span>
          <h2 className="sec-h">Built in the open.</h2>
          <p className="desc">
            Rallypoint ships its source publicly. Read the code, open issues, or self-host the
            whole stack — no lock-in.
          </p>
          <p
            style={{
              fontFamily: "var(--font-mono,'Space Mono',monospace)",
              fontSize: 12.5,
              lineHeight: 1.7,
              color: 'var(--mut)',
              margin: '14px 0 0',
              maxWidth: '62ch',
            }}
          >
            Rallypoint is free. If a paid tier ever shows up, existing users are grandfathered in
            — what you use today stays free for you.
          </p>
          <div className="repos">
            <a className="repo" href={OPEN_REPO_URL}>
              <span className="rn">
                bbennetth/<b>rallypoint-open</b> ↗
              </span>
              <p>The app suite — Planner, Health, Events, and the Ink design system.</p>
            </a>
            <a className="repo" href={CMD_REPO_URL}>
              <span className="rn">
                bbennetth/<b>rallypoint-cmd</b> ↗
              </span>
              <p>The game server panel — one-command Proxmox install, self-updating, least-privilege.</p>
            </a>
          </div>
        </div>
      </section>

      <SiteFooter />
    </>
  )
}

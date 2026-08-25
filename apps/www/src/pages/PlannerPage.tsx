import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Seo } from '../ui/Seo.js'
import { SiteHeader } from '../ui/SiteHeader.js'
import { SiteFooter } from '../ui/SiteFooter.js'
import { Shot } from '../ui/Shot.js'
import { PLANNER_WEB_URL } from '../config.js'

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

export function PlannerPage() {
  return (
    <>
      <Seo path="/planner" />
      <SiteHeader />

      <section className="p-hero">
        <div className="wrap">
          <span className="eyebrow">Planner</span>
          <h1 className="hero-h" style={{ fontSize: 'clamp(38px,5.8vw,68px)' }}>
            Your whole day,
            <br />
            <span className="ac">in one agenda.</span>
          </h1>
          <p className="lede">
            My Day brings your schedule, tasks, recurring chores, shopping lists, notes, and
            diary into a single agenda — with live weather and push reminders. It works offline
            and syncs the moment you reconnect.
          </p>
          <div
            style={{ display: 'flex', gap: 12, justifyContent: 'center', marginTop: 30, flexWrap: 'wrap' }}
          >
            <a className="btn solid lg" href={PLANNER_WEB_URL}>
              Open Planner →
            </a>
            <Link className="btn lg" to="/#products">
              Back to the suite
            </Link>
          </div>
          <div className="chips">
            <span className="chip">Offline-ready</span>
            <span className="chip">Push reminders</span>
            <span className="chip">Live weather</span>
            <span className="chip">6 accent themes</span>
          </div>
        </div>
      </section>

      <section className="shots">
        <Shot placeholder="Planner — My Day (390×844)" caption="My Day" />
        <Shot placeholder="Planner — Tasks (390×844)" caption="Tasks" />
        <Shot placeholder="Planner — Shopping (390×844)" caption="Shopping" />
      </section>

      <section className="feat">
        <div className="wrap">
          <div className="eye">
            <b>What's inside</b>
            <i></i>
          </div>
          <h2 className="sec-h">Everything your day needs.</h2>
          <div className="feat-g">
            <Cap
              icon={
                <svg {...ICON}>
                  <circle cx="8" cy="9" r="3.1" />
                  <path d="M8 1.6v1.6M8 14.6v-.6M2 9H.6M15.4 9H14M3.5 4.5l-1-1M12.5 4.5l1-1M1.4 13h13.2" />
                </svg>
              }
              title="My Day"
              body="One agenda for tasks, chores, events, and weather — everything due today, in order."
            />
            <Cap
              icon={
                <svg {...ICON}>
                  <path d="M2 4.2h7M2 8h7M2 11.8h4.5" />
                  <path d="M11 3.6l1.5 1.5L15 2.4" />
                  <path d="M11.4 8.2h3M11.4 12h3" />
                </svg>
              }
              title="Tasks & chores"
              body="Priorities, due dates, and recurring chores that come back on their own schedule."
            />
            <Cap
              icon={
                <svg {...ICON}>
                  <path d="M1.5 2h2l1.5 7h7l1.5-5H5" />
                  <circle cx="7" cy="13" r="1" fill="currentColor" stroke="none" />
                  <circle cx="11" cy="13" r="1" fill="currentColor" stroke="none" />
                </svg>
              }
              title="Shopping lists"
              body="Check items into the cart with quantities and a running progress bar."
            />
            <Cap
              icon={
                <svg {...ICON}>
                  <path d="M4 1.6h5L13 5.5V14.4H4z" />
                  <path d="M9 1.6V5.5h4" />
                </svg>
              }
              title="Notes & diary"
              body="Quick notes and a dated diary, right next to the rest of your day."
            />
            <Cap
              icon={
                <svg {...ICON}>
                  <rect x="2" y="3.5" width="12" height="10.5" rx="1" />
                  <path d="M2 7h12" />
                  <path d="M5.5 1.6v2.8M10.5 1.6v2.8" />
                </svg>
              }
              title="Week & month"
              body="A calendar view when you need the long horizon — agenda when you don't."
            />
            <Cap
              icon={
                <svg {...ICON}>
                  <path d="M8 2.5v11M2.5 8h11" />
                </svg>
              }
              title="Quick add"
              body="One tap on the FAB adds a task, chore, note, or event from anywhere in the app."
            />
          </div>
        </div>
      </section>

      <section className="band" style={{ padding: '0 0 84px', textAlign: 'center' }}>
        <div className="wrap">
          <h2 className="sec-h" style={{ maxWidth: 'none' }}>
            Start with today.
          </h2>
          <p className="desc" style={{ margin: '16px auto 0' }}>
            Free, open source, and installable on your phone.
          </p>
          <div
            style={{ display: 'inline-flex', gap: 12, marginTop: 28, flexWrap: 'wrap', justifyContent: 'center' }}
          >
            <a className="btn solid lg" href={PLANNER_WEB_URL}>
              Open Planner →
            </a>
            <Link className="btn lg" to="/health">
              Next: Health →
            </Link>
          </div>
        </div>
      </section>

      <SiteFooter />
    </>
  )
}

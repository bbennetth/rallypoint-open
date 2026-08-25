import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Seo } from '../ui/Seo.js'
import { SiteHeader } from '../ui/SiteHeader.js'
import { SiteFooter } from '../ui/SiteFooter.js'
import { Shot } from '../ui/Shot.js'
import { FITNESS_WEB_URL } from '../config.js'

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

export function HealthPage() {
  return (
    <>
      <Seo path="/health" />
      <SiteHeader />

      <section className="p-hero">
        <div className="wrap">
          <span className="eyebrow">Health</span>
          <h1 className="hero-h" style={{ fontSize: 'clamp(38px,5.8vw,68px)' }}>
            Log the work.
            <br />
            <span className="ac">Watch it add up.</span>
          </h1>
          <p className="lede">
            Today's session at a glance, live logging with per-set check-offs and a rest timer, a
            weekly plan grid, meals and macros alongside the training, and stats that turn
            showing up into streaks, volume, and PRs.
          </p>
          <div
            style={{ display: 'flex', gap: 12, justifyContent: 'center', marginTop: 30, flexWrap: 'wrap' }}
          >
            <a className="btn solid lg" href={FITNESS_WEB_URL}>
              Open Health →
            </a>
            <Link className="btn lg" to="/#products">
              Back to the suite
            </Link>
          </div>
          <div className="chips">
            <span className="chip">Live logging</span>
            <span className="chip">Rest timer</span>
            <span className="chip">Nutrition</span>
            <span className="chip">Weekly plans</span>
            <span className="chip">Offline-ready</span>
          </div>
        </div>
      </section>

      <section className="shots">
        <Shot placeholder="Health — Today (390×844)" caption="Today" />
        <Shot placeholder="Health — Live workout (390×844)" caption="Live workout" />
        <Shot placeholder="Health — Stats (390×844)" caption="Stats" />
      </section>

      <section className="feat">
        <div className="wrap">
          <div className="eye">
            <b>What's inside</b>
            <i></i>
          </div>
          <h2 className="sec-h">Built for the middle of a set.</h2>
          <div className="feat-g">
            <Cap
              icon={
                <svg {...ICON}>
                  <path d="M2 6v4M4 5v6M12 5v6M14 6v4M4 8h8" />
                </svg>
              }
              title="Live workout"
              body="Check off sets as you go — big targets, no fiddling between reps."
            />
            <Cap
              icon={
                <svg {...ICON}>
                  <circle cx="8" cy="9" r="5.2" />
                  <path d="M8 9V6M6.5 1.5h3M8 1.5v2.3" />
                </svg>
              }
              title="Rest timer"
              body="A countdown starts when the set ends. Skip it when you're ready early."
            />
            <Cap
              icon={
                <svg {...ICON}>
                  <rect x="2" y="2.5" width="12" height="11" rx="1" />
                  <path d="M2 6h12M6 6v7.5M10 6v7.5" />
                </svg>
              }
              title="Weekly plan"
              body="A seven-day grid of sessions and rest days — see the week, not just today."
            />
            <Cap
              icon={
                <svg {...ICON}>
                  <path d="M2 13.5V2.5M2 13.5h12M5 11V8M8 11V5M11 11V9" />
                </svg>
              }
              title="Stats"
              body="Weekly volume, average session length, and streaks over the last 8 weeks."
            />
            <Cap
              icon={
                <svg {...ICON}>
                  <path d="M5 2h6v3a3 3 0 0 1-6 0V2zM5 3H3v1a2 2 0 0 0 2 2M11 3h2v1a2 2 0 0 1-2 2M6.5 8.5 6 11h4l-.5-2.5M4.5 13.5h7" />
                </svg>
              }
              title="PRs"
              body="Personal records surface automatically the session you set them."
            />
            <Cap
              icon={
                <svg {...ICON}>
                  <path d="M8 3.4a4.6 4.6 0 1 1-4.4 3.3" />
                  <path d="M3.1 3v2.5h2.5" />
                  <path d="M8 5.6V8l1.7 1" />
                </svg>
              }
              title="History"
              body="Every session logged, searchable, and synced across your devices."
            />
          </div>
          <div className="stats-strip" aria-hidden>
            <div className="stat-t">
              <span className="k">Streak</span>
              <span className="v">12</span>
              <span className="u">days</span>
            </div>
            <div className="stat-t">
              <span className="k">This week</span>
              <span className="v">3</span>
              <span className="u">of 5</span>
            </div>
            <div className="stat-t">
              <span className="k">Volume</span>
              <span className="v">8.2</span>
              <span className="u">k lb</span>
            </div>
            <div className="stat-t">
              <span className="k">Best 5K</span>
              <span className="v">24:07</span>
              <span className="u chip ac" style={{ marginLeft: 8, verticalAlign: 3 }}>
                PR
              </span>
            </div>
          </div>
        </div>
      </section>

      <section className="band" style={{ padding: '0 0 84px', textAlign: 'center' }}>
        <div className="wrap">
          <h2 className="sec-h" style={{ maxWidth: 'none' }}>
            Show up. We'll count it.
          </h2>
          <p className="desc" style={{ margin: '16px auto 0' }}>
            Free, open source, and installable on your phone.
          </p>
          <div
            style={{ display: 'inline-flex', gap: 12, marginTop: 28, flexWrap: 'wrap', justifyContent: 'center' }}
          >
            <a className="btn solid lg" href={FITNESS_WEB_URL}>
              Open Health →
            </a>
            <Link className="btn lg" to="/#events">
              Next: Events →
            </Link>
          </div>
        </div>
      </section>

      <SiteFooter />
    </>
  )
}

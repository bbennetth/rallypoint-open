// Per-route SEO metadata — the single source of truth for titles,
// descriptions, and canonical paths on the apex site. Consumed by the
// <Seo> component (runtime head updates) and by seo.test.ts, which
// asserts static/sitemap.xml stays in lockstep with these routes.

export const SITE_ORIGIN = 'https://rallypt.app'

export interface RouteMeta {
  /** Document title (also og:title / twitter:title). */
  title: string
  /** Meta description (also og:description / twitter:description). */
  description: string
  /**
   * schema.org type for the per-page JSON-LD node. Product pages are
   * SoftwareApplication; the home page describes the org in index.html
   * instead and gets no per-page node.
   */
  ldType?: 'SoftwareApplication'
  /** schema.org applicationCategory, when ldType is set. */
  ldCategory?: string
  /** Product display name for JSON-LD, when ldType is set. */
  ldName?: string
}

export const ROUTE_META: Record<string, RouteMeta> = {
  '/': {
    title: 'Rallypoint — Planner, Health & Events in One Account',
    description:
      'Rallypoint is an offline-ready, open-source suite that shares one account: a fast daily Planner, a Health training log, and an Events workspace for your crew — plus Cmd.',
  },
  '/planner': {
    title: 'Rallypoint Planner — Your Whole Day in One Agenda',
    description:
      'A fast, offline-ready daily planner: My Day agenda, tasks and recurring chores, shopping lists, notes, diary, and a week & month calendar with live weather and reminders.',
    ldType: 'SoftwareApplication',
    ldCategory: 'ProductivityApplication',
    ldName: 'Rallypoint Planner',
  },
  '/health': {
    title: 'Rallypoint Health — Log the Work, Watch It Add Up',
    description:
      'A training log that keeps pace with you: live workout logging with a rest timer, weekly plans, meals and macros, streaks, volume, and PRs — offline-ready and open source.',
    ldType: 'SoftwareApplication',
    ldCategory: 'HealthApplication',
    ldName: 'Rallypoint Health',
  },
  '/cmd': {
    title: 'Rallypoint Cmd — Self-Hosted Game Server Control Panel',
    description:
      'Cmd is a self-hosted control panel for your dedicated game server: dashboard, live console, players, mods, backups, and one-click updates. Palworld is the first game.',
    ldType: 'SoftwareApplication',
    ldCategory: 'UtilitiesApplication',
    ldName: 'Rallypoint Cmd',
  },
}

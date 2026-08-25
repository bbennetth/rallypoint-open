import { Hono } from 'hono'
import {
  volumeByMuscle,
  volumeByMuscleGroup,
  computeExercisePr,
  computeWeeklyVolume,
  WEEK_MS,
  type MuscleGroupVolume,
  type MuscleVolume,
  type ExercisePr,
} from '@rallypoint/fitness-shared'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'
import { parseDateRangeQuery } from './_query.js'

// Derived training insights UI surface (slice 4): per-muscle-group weekly
// volume and per-exercise personal records. Session-gated in build-app.

// Insights are expensive to compute (full-table scan of workout_sets for
// PRs); a short private cache cuts redundant requests when the user toggles
// windows without leaking across users via shared CDN caches.
const INSIGHTS_CACHE = 'private, max-age=60'

export const insightsRoutes = new Hono<HonoApp>()
  // GET /api/v1/ui/insights/volume?from=<ISO>&to=<ISO>
  // Returns per-muscle-group volume aggregation for the requested window.
  // Defaults to the last 7 days when from/to are absent.
  .get('/api/v1/ui/insights/volume', async (c) => {
    const userId = c.var.session!.userId
    const url = new URL(c.req.url)
    const { from, to } = parseDateRangeQuery(url)

    const toDate = to ?? new Date()
    const fromDate = from ?? new Date(toDate.getTime() - 7 * 24 * 60 * 60 * 1000)

    const sets = await c.var.repos.insights.volumeSets(
      userId,
      fromDate.getTime(),
      toDate.getTime(),
    )

    const groups: MuscleGroupVolume[] = volumeByMuscleGroup(sets)
    // Per-muscle breakdown for the drill-down under each group bar —
    // additive alongside `groups` so cached/old clients are unaffected.
    const muscles: MuscleVolume[] = volumeByMuscle(sets)

    c.header('Cache-Control', INSIGHTS_CACHE)
    return c.json({
      from: fromDate.toISOString(),
      to: toDate.toISOString(),
      groups,
      muscles,
    })
  })
  // GET /api/v1/ui/insights/volume/weekly?from=<ISO>&to=<ISO>
  // Total tonnage bucketed into fixed 7-day bins anchored at `from` — the
  // Stats 8-week bar chart. The client supplies `from` as its local
  // Monday-midnight instant (weeklyVolumeRange), so bins line up with the
  // user's weeks without the server knowing a timezone. Defaults to the
  // trailing 8 UTC weeks when params are absent.
  .get('/api/v1/ui/insights/volume/weekly', async (c) => {
    const userId = c.var.session!.userId
    const url = new URL(c.req.url)
    const { from, to } = parseDateRangeQuery(url)

    const toDate = to ?? new Date()
    const fromDate = from ?? new Date(toDate.getTime() - 8 * WEEK_MS)
    const fromMs = fromDate.getTime()
    if (toDate.getTime() <= fromMs) {
      throw errors.validation({
        issues: [
          { code: 'custom', path: ['to'], message: 'Query param "to" must be after "from".' },
        ],
      })
    }
    // Bin count from the window span; a DST-skewed span still rounds to
    // the intended week count. Capped so a hostile `from` can't demand
    // thousands of bins.
    const requested = Math.max(1, Math.round((toDate.getTime() - fromMs) / WEEK_MS))
    const weeks = Math.min(104, requested)
    // When the cap bites, read only as far as the bins we actually
    // return — otherwise every set older than the cap would clamp into
    // the last bin and show as one absurd bar. Uncapped, the read keeps
    // the caller's `to` so the clamp still catches the ~1h of DST slack
    // it exists for.
    const toMs = weeks === requested ? toDate.getTime() : fromMs + weeks * WEEK_MS

    const sets = await c.var.repos.insights.weeklyVolumeSets(userId, fromMs, toMs)

    c.header('Cache-Control', INSIGHTS_CACHE)
    return c.json({
      // The window actually read — with the cap applied, so `from`/`to`
      // never describe a wider span than the bins below cover.
      from: fromDate.toISOString(),
      to: new Date(toMs).toISOString(),
      weeks: computeWeeklyVolume(sets, fromMs, weeks),
    })
  })
  // GET /api/v1/ui/insights/prs
  // Returns per-exercise personal records for all of the user's logged sets.
  .get('/api/v1/ui/insights/prs', async (c) => {
    const userId = c.var.session!.userId

    const byExercise = await c.var.repos.insights.prSetsByExercise(userId)

    const exercises: Array<{ exerciseId: string; exerciseName: string } & ExercisePr> =
      byExercise
        .map(({ exerciseId, exerciseName, sets }) => ({
          exerciseId,
          exerciseName,
          ...computeExercisePr(sets),
        }))
        .sort((a, b) => a.exerciseName.localeCompare(b.exerciseName))

    c.header('Cache-Control', INSIGHTS_CACHE)
    return c.json({ exercises })
  })

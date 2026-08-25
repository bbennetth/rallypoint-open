// /stats Training sub-view. 7-day / 28-day / Year segmented control,
// a 2×2 stat-tile grid (workouts / best streak / avg session / total
// volume), the fixed 8-week weekly-volume bar chart, volume bars per
// muscle group, modality split, and recent PRs (Soft Ink B·F3 frame).
// Range/scaling/formatting logic lives in the pure stats-view and
// insights-view helpers; this file only fetches and renders.

import { useMemo, useState } from 'react'
import { Banner, EmptyState } from '@rallypoint/ui'
import type { Modality } from '@rallypoint/fitness-shared'
import {
  ApiError,
  prsQuery,
  volumeInsightsQuery,
  weeklyVolumeQuery,
  workoutsQuery,
} from '../lib/api.js'
import { useCachedQuery } from '../lib/offline/use-cached-query.js'
import {
  STATS_RANGES,
  aggregateTrainingStats,
  bestStreakDays,
  formatTonnage,
  splitTonnage,
  statsRangeToDates,
} from '../lib/stats-view.js'
import type { StatsRange } from '../lib/stats-view.js'
import { buildPrRowVms, buildVolumeBarVms, buildWeeklyBarVms, weeklyVolumeRange } from '../lib/insights-view.js'
import { useWeightUnit } from '../lib/units.js'

function errMessage(err: unknown): string {
  return err instanceof ApiError
    ? err.message
    : err instanceof Error
      ? err.message
      : 'Failed to load training stats.'
}

function rangeLabel(r: StatsRange): string {
  return r === '7d' ? 'LAST 7 DAYS' : r === '28d' ? 'LAST 28 DAYS' : 'LAST YEAR'
}

function modalityShortLabel(m: Modality): string {
  return m.charAt(0).toUpperCase() + m.slice(1)
}

export function TrainingView() {
  const unit = useWeightUnit()
  const [range, setRange] = useState<StatsRange>('7d')
  const { from, to } = useMemo(() => statsRangeToDates(range, new Date()), [range])

  // Render-from-cache: each read paints the last-known value instantly
  // and re-renders on every cache write — including the post-workout
  // insights reconcile the offline engine runs after a save, so no
  // manual refetch is needed here.
  const workoutsQ = useCachedQuery(useMemo(() => workoutsQuery({ from, to }), [from, to]))
  const volumeQ = useCachedQuery(useMemo(() => volumeInsightsQuery(from, to), [from, to]))
  // The weekly chart is fixed at the trailing 8 local weeks, independent
  // of the seg (the design's "Last 8 weeks" chart doesn't re-window).
  const weekly = useMemo(() => weeklyVolumeRange(), [])
  const weeklyQ = useCachedQuery(
    useMemo(() => weeklyVolumeQuery(weekly.from, weekly.to), [weekly]),
  )
  const prsQ = useCachedQuery(useMemo(() => prsQuery(), []))

  const workouts = workoutsQ.data ?? []
  const volume = volumeQ.data ?? null
  const prs = prsQ.data ?? null
  // weeklyQ is gated too: its cache table is new, so it is guaranteed
  // cold on the first visit after this ships even when the other reads
  // are warm — without it the chart would pop in after paint.
  const loading =
    workoutsQ.status === 'loading' ||
    volumeQ.status === 'loading' ||
    weeklyQ.status === 'loading' ||
    prsQ.status === 'loading'
  const error = useMemo(() => {
    if (workoutsQ.status === 'error') return errMessage(workoutsQ.error)
    if (volumeQ.status === 'error') return errMessage(volumeQ.error)
    if (weeklyQ.status === 'error') return errMessage(weeklyQ.error)
    if (prsQ.status === 'error') return errMessage(prsQ.error)
    return null
  }, [workoutsQ.status, workoutsQ.error, volumeQ.status, volumeQ.error, weeklyQ.status, weeklyQ.error, prsQ.status, prsQ.error])

  const stats = aggregateTrainingStats(workouts)
  const totalVolume = splitTonnage(formatTonnage(stats.tonnageKg, unit))
  const weeklyBars = buildWeeklyBarVms(weeklyQ.data?.weeks ?? [])
  const groupVms = buildVolumeBarVms(volume?.groups ?? [])
  // The group max also scales the per-muscle drill-down bars so a
  // muscle bar reads against the same axis as its parent group.
  const maxVolume = Math.max(1, ...(volume?.groups ?? []).map((g) => g.weightedSets))
  const prRows = prs ? buildPrRowVms(prs.exercises, unit) : []
  // Which group bars are expanded to show their per-muscle breakdown.
  // `muscles` is optional on cached pre-breakdown responses — guard `?? []`.
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())
  const muscleVolumes = volume?.muscles ?? []
  function toggleGroup(groupId: string) {
    setExpandedGroups((cur) => {
      const next = new Set(cur)
      if (next.has(groupId)) next.delete(groupId)
      else next.add(groupId)
      return next
    })
  }

  return (
    <div className="page-pad">
      <header className="fit-head">
        <div className="top">
          <div>
            <div className="eyebrow">{rangeLabel(range)}</div>
            <h1>Stats</h1>
          </div>
        </div>
        <div className="fit-seg" style={{ marginTop: 12 }} role="tablist">
          {STATS_RANGES.map((r) => (
            <button
              key={r.value}
              type="button"
              role="tab"
              aria-selected={range === r.value}
              className={range === r.value ? 'on' : ''}
              onClick={() => setRange(r.value)}
            >
              {r.label}
            </button>
          ))}
        </div>
      </header>

      {error && <Banner tone="error">{error}</Banner>}

      {/* 2×2 per the B·F3 frame (grid2 is TrainingView-only — Body/Food
          and the live pages keep the 3-across base grid). */}
      <div className="fit-stats grid2">
        <div className="fit-stat">
          <div className="k">Workouts</div>
          <div className="v">{stats.sessions}</div>
          <div className="u">total</div>
        </div>
        <div className="fit-stat">
          <div className="k">Best streak</div>
          <div className="v">{bestStreakDays(workouts)}</div>
          <div className="u">days</div>
        </div>
        <div className="fit-stat">
          <div className="k">Avg session</div>
          <div className="v">{Math.round(stats.avgSessionS / 60)}</div>
          <div className="u">min</div>
        </div>
        <div className="fit-stat">
          <div className="k">Total volume</div>
          {/* Value/unit split so a long total can't wrap the tile. */}
          <div className="v">{totalVolume.value}</div>
          <div className="u">{totalVolume.unit} lifted</div>
        </div>
      </div>

      {loading ? (
        <div style={{ color: 'var(--ink-dim)' }}>Loading…</div>
      ) : (
        <>
          {weeklyBars.length > 0 && (
            <section style={{ display: 'grid', gap: 4 }}>
              <div className="sec-rule">
                <div className="eyebrow">WEEKLY VOLUME</div>
                <div className="line" />
                <span className="ct">8 WEEKS</span>
              </div>
              <div className="vol-week-card">
                <div
                  className="vol-week-bars"
                  role="img"
                  aria-label={`Weekly training volume, last ${weeklyBars.length} weeks`}
                >
                  {weeklyBars.map((b) => (
                    <span
                      key={b.label}
                      className={b.current ? 'bar cur' : 'bar'}
                      style={{ height: b.heightPct }}
                      title={`${b.label} · ${formatTonnage(b.tonnageKg, unit)}`}
                    />
                  ))}
                </div>
                <div className="vol-week-labels" aria-hidden="true">
                  {weeklyBars.map((b) => (
                    <span key={b.label}>{b.label}</span>
                  ))}
                </div>
              </div>
            </section>
          )}

          <section style={{ display: 'grid', gap: 4 }}>
            <div className="sec-rule">
              <div className="eyebrow">VOLUME BY MUSCLE GROUP</div>
              <div className="line" />
              <span className="ct">SETS</span>
            </div>
            {volume && volume.groups.length > 0 ? (
              <div>
                {groupVms
                  .filter((g) => g.weightedSets > 0)
                  .sort((a, b) => b.weightedSets - a.weightedSets)
                  .map((g) => {
                    const groupMuscles = muscleVolumes.filter(
                      (m) => m.groupId === g.groupId && m.weightedSets > 0,
                    )
                    const expandable = groupMuscles.length > 0
                    const expanded = expandedGroups.has(g.groupId)
                    return (
                      <div key={g.groupId}>
                        <button
                          type="button"
                          className="vol-row"
                          style={{
                            all: 'unset',
                            display: 'block',
                            width: '100%',
                            boxSizing: 'border-box',
                            cursor: expandable ? 'pointer' : 'default',
                          }}
                          onClick={() => expandable && toggleGroup(g.groupId)}
                          aria-expanded={expandable ? expanded : undefined}
                          disabled={!expandable}
                        >
                          <div className="lab">
                            <span className="g">
                              {g.groupName}
                              {expandable && (
                                <span
                                  style={{ color: 'var(--ink-dim)', marginLeft: 6, fontSize: 10 }}
                                >
                                  {expanded ? '▾' : '▸'}
                                </span>
                              )}
                            </span>
                            <span className="n">{Math.round(g.weightedSets)} sets</span>
                          </div>
                          <div className="vol-bar">
                            <i style={{ width: g.barWidthPct }} />
                          </div>
                        </button>
                        {expanded &&
                          groupMuscles
                            .sort((a, b) => b.weightedSets - a.weightedSets)
                            .map((m) => (
                              <div
                                key={m.muscleId}
                                className="vol-row"
                                style={{ paddingLeft: 16 }}
                              >
                                <div className="lab">
                                  <span className="g" style={{ color: 'var(--ink-dim)' }}>
                                    {m.muscleName}
                                  </span>
                                  <span className="n">
                                    {Math.round(m.weightedSets * 10) / 10} sets
                                  </span>
                                </div>
                                <div className="vol-bar">
                                  <i
                                    style={{
                                      width: `${(m.weightedSets / maxVolume) * 100}%`,
                                      opacity: 0.55,
                                    }}
                                  />
                                </div>
                              </div>
                            ))}
                      </div>
                    )
                  })}
              </div>
            ) : (
              <EmptyState
                title="No volume yet"
                body="Log strength sets so we can break out volume by muscle group."
              />
            )}
          </section>

          {stats.modalitySplit.length > 0 && (
            <section style={{ display: 'grid', gap: 4 }}>
              <div className="sec-rule">
                <div className="eyebrow">TRAINING SPLIT</div>
                <div className="line" />
              </div>
              <div className="split-bar" aria-label="Training split by modality">
                {stats.modalitySplit.map((row, i) => {
                  const opacity = 1 - i * 0.18
                  return (
                    <i
                      key={row.modality}
                      title={`${modalityShortLabel(row.modality)} · ${row.pct}%`}
                      style={{
                        width: `${row.pct}%`,
                        background: `color-mix(in srgb, var(--acid) ${Math.max(20, Math.round(opacity * 100))}%, transparent)`,
                      }}
                    />
                  )
                })}
              </div>
              <div className="split-legend">
                {stats.modalitySplit.map((row, i) => {
                  const opacity = 1 - i * 0.18
                  return (
                    <div key={row.modality} className="it">
                      <span
                        className="sw"
                        style={{
                          background: `color-mix(in srgb, var(--acid) ${Math.max(20, Math.round(opacity * 100))}%, transparent)`,
                        }}
                      />
                      {modalityShortLabel(row.modality)}
                      <span className="pc">{row.pct}%</span>
                    </div>
                  )
                })}
              </div>
            </section>
          )}

          <section style={{ display: 'grid', gap: 4 }}>
            <div className="sec-rule">
              <div className="eyebrow">RECENT PRS</div>
              <div className="line" />
            </div>
            {prRows.length > 0 ? (
              <div>
                {prRows
                  .filter(
                    (row) =>
                      row.heaviestLoadDisplay != null ||
                      row.longestDistanceDisplay != null ||
                      row.bestE1rmDisplay != null,
                  )
                  .slice(0, 8)
                  .map((row) => {
                    // All display strings come pre-formatted (unit-aware)
                    // from buildPrRowVms; estimated 1RMs read as `~NNN`.
                    const value =
                      row.heaviestLoadDisplay ??
                      row.longestDistanceDisplay ??
                      (row.bestE1rmDisplay != null ? `~${row.bestE1rmDisplay}` : '—')
                    const when = row.heaviestLoadDateDisplay ?? row.bestE1rmDateDisplay
                    return (
                      <div key={row.exerciseId} className="pr-row">
                        <div>
                          <div className="nm">{row.exerciseName}</div>
                          {when && <div className="when">{when}</div>}
                        </div>
                        <div className="val">
                          <div className="v">{value}</div>
                        </div>
                      </div>
                    )
                  })}
              </div>
            ) : (
              <EmptyState
                title="No PRs yet"
                body="Log strength sets across multiple sessions to surface PRs."
              />
            )}
          </section>
        </>
      )}
    </div>
  )
}


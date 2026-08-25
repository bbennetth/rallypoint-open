// /stats/body sub-view. Bodyweight card with an inline sparkline +
// trend, three vitals tiles (Resting HR, Body fat, Avg sleep), and a
// measurements grid. Restyles the prior MetricsPage onto the Ink
// fitness.css class families. Logging happens in MetricLogSheet, opened
// from the header button, the empty-state CTA, or ?log=1 (StartSheet).

import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Banner, EmptyState } from '@rallypoint/ui'
import { ApiError, metricsQuery } from '../lib/api.js'
import { useCachedQuery } from '../lib/offline/use-cached-query.js'
import { buildKindCards, cardForWeightUnit, formatValue } from '../lib/metric-view.js'
import type { MetricKindCardVm } from '../lib/metric-view.js'
import { sparklinePath } from '../lib/stats-view.js'
import { useWeightUnit } from '../lib/units.js'
import { MetricLogSheet } from './MetricLogSheet.js'
import { ProgressPhotosCard } from './ProgressPhotosCard.js'

function errMessage(err: unknown): string {
  return err instanceof ApiError
    ? err.message
    : err instanceof Error
      ? err.message
      : 'Failed to load body metrics.'
}

function BodyweightCard({ vm }: { vm: MetricKindCardVm }) {
  const values = vm.sparkPoints.map((p) => p.value)
  const W = 320
  const H = 64
  const { line, area } = sparklinePath(values, W, H, 2)
  const deltaCls = vm.deltaDirection === 'better' ? 'up' : vm.deltaDirection === 'worse' ? 'down' : ''
  return (
    <div className="fit-card">
      <div className="fit-card-hd">
        <div>
          <div className="ti">Bodyweight</div>
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              letterSpacing: '0.08em',
              color: 'var(--ink-mute)',
              marginTop: 4,
              textTransform: 'uppercase',
            }}
          >
            Last {vm.sparkPoints.length} weigh-ins
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div className="ti" style={{ fontFamily: 'var(--font-display)', fontSize: 28 }}>
            {formatValue(vm.latestValue, vm.unit)}
          </div>
          {vm.deltaDisplay && (
            <div
              className={`d ${deltaCls}`}
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                marginTop: 4,
                color: deltaCls === 'up' ? 'var(--acid)' : deltaCls === 'down' ? 'color-mix(in srgb, #f44 60%, var(--ink))' : 'var(--ink-dim)',
              }}
            >
              {vm.deltaDisplay}
            </div>
          )}
        </div>
      </div>
      <div className="fit-card-body" style={{ padding: '8px 16px 12px' }}>
        {values.length >= 2 ? (
          <svg
            className="spark"
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <path d={area} fill="var(--accent-soft)" />
            <path
              d={line}
              fill="none"
              stroke="var(--acid)"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        ) : (
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              color: 'var(--ink-mute)',
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
            }}
          >
            Log a few weigh-ins to see the trend
          </div>
        )}
      </div>
    </div>
  )
}

function StatTile({ vm }: { vm: MetricKindCardVm }) {
  const deltaCls = vm.deltaDirection === 'better' ? 'up' : vm.deltaDirection === 'worse' ? 'down' : ''
  return (
    <div className="fit-stat">
      <div className="v">
        {formatValue(vm.latestValue, '')}
        {vm.unit && <small> {vm.unit}</small>}
      </div>
      <div className="k">{vm.label}</div>
      {vm.deltaDisplay && <div className={`d ${deltaCls}`}>{vm.deltaDisplay}</div>}
    </div>
  )
}

function MeasureTile({ vm }: { vm: MetricKindCardVm }) {
  const deltaCls = vm.deltaDirection === 'better' ? 'up' : vm.deltaDirection === 'worse' ? 'down' : ''
  return (
    <div className="measure">
      <div className="v">{formatValue(vm.latestValue, vm.unit)}</div>
      <div className="k">{vm.label}</div>
      {vm.deltaDisplay && <div className={`t ${deltaCls}`} style={{
        color: deltaCls === 'up' ? 'var(--acid)' : deltaCls === 'down' ? 'color-mix(in srgb, #f44 60%, var(--ink))' : 'var(--ink-dim)',
      }}>{vm.deltaDisplay}</div>}
    </div>
  )
}

const VITAL_KINDS = ['resting_hr', 'bodyfat', 'sleep']

export function BodyView() {
  // Render-from-cache: paints the last-known value instantly and
  // re-renders on every cache write — including the local-first
  // createMetric from MetricLogSheet, so no manual refetch is needed.
  const metricsQ = useCachedQuery(useMemo(() => metricsQuery(), []))
  const [searchParams, setSearchParams] = useSearchParams()
  const [logOpen, setLogOpen] = useState(false)

  // StartSheet deep-link: /stats/body?log=1 opens the sheet on arrival.
  const wantsLog = searchParams.get('log') === '1'
  useEffect(() => {
    if (wantsLog) {
      setLogOpen(true)
      setSearchParams((cur) => {
        const next = new URLSearchParams(cur)
        next.delete('log')
        return next
      }, { replace: true })
    }
  }, [wantsLog, setSearchParams])
  const metrics = metricsQ.data ?? []
  const loading = metricsQ.status === 'loading'
  const error = metricsQ.status === 'error' ? errMessage(metricsQ.error) : null

  const weightUnit = useWeightUnit()
  const cards = buildKindCards(metrics)
  const cardByKind = new Map(cards.map((c) => [c.kind, c]))
  const bodyweightRaw = cardByKind.get('bodyweight')
  const bodyweight = bodyweightRaw ? cardForWeightUnit(bodyweightRaw, weightUnit) : null
  const vitals = VITAL_KINDS.map((k) => cardByKind.get(k)).filter(
    (c): c is MetricKindCardVm => c !== undefined,
  )
  const measurements = cards.filter(
    (c) => c.kind !== 'bodyweight' && !VITAL_KINDS.includes(c.kind),
  )

  return (
    <div className="page-pad">
      <header className="fit-head">
        <div className="top">
          <div>
            <div className="eyebrow">METRICS</div>
            <h1>Body</h1>
          </div>
          <button type="button" className="fit-startbtn ghost" onClick={() => setLogOpen(true)}>
            + Log metric
          </button>
        </div>
      </header>

      {error && <Banner tone="error">{error}</Banner>}

      {loading ? (
        <div style={{ color: 'var(--ink-dim)' }}>Loading…</div>
      ) : cards.length === 0 ? (
        <EmptyState
          title="No body metrics yet"
          body="Log a bodyweight or vitals reading to start tracking your trend."
          action={
            <button type="button" className="fit-startbtn" onClick={() => setLogOpen(true)}>
              Log a metric
            </button>
          }
        />
      ) : (
        <>
          {bodyweight && <BodyweightCard vm={bodyweight} />}

          {vitals.length > 0 && (
            <section style={{ display: 'grid', gap: 8 }}>
              <div className="sec-rule">
                <div className="eyebrow">VITALS</div>
                <div className="line" />
              </div>
              <div className="fit-stats">
                {vitals.map((c) => (
                  <StatTile key={c.kind} vm={c} />
                ))}
              </div>
            </section>
          )}

          {measurements.length > 0 && (
            <section style={{ display: 'grid', gap: 8 }}>
              <div className="sec-rule">
                <div className="eyebrow">MEASUREMENTS</div>
                <div className="line" />
              </div>
              <div className="measure-grid">
                {measurements.map((c) => (
                  <MeasureTile key={c.kind} vm={c} />
                ))}
              </div>
            </section>
          )}
        </>
      )}

      {/* Progress pictures live outside the metrics ternary — photos can
          exist (and be added) even before any metric is logged. */}
      <ProgressPhotosCard />

      {logOpen && (
        <MetricLogSheet onClose={() => setLogOpen(false)} onSaved={() => setLogOpen(false)} />
      )}
    </div>
  )
}

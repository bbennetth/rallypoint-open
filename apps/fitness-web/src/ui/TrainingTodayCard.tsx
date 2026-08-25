// The detail block under the /log dashboard's split hero. It renders
// whatever `resolveTodayTraining` resolved — the SAME value the START
// WORKOUT tile reads, which is the point: before the dashboard the hero
// scanned for a WOD only, so a strength-only day would have shown
// "Nothing scheduled today" under a tile offering to start it.
//
// A WOD gets the full WodHeroCard (movement list, scheme, best); other
// kinds get a compact row, since neither the strength engine nor the run
// form has a card of that shape to show.

import { Icon } from '@rallypoint/ui'
import type { TodayTraining, TrainingCta } from '../lib/today-view.js'
import { WodHeroCard, type WodOnlyTemplateDto } from './WodHeroCard.js'

export function TrainingTodayCard({
  today,
  wod,
  names,
  onStart,
  onCta,
}: {
  today: TodayTraining
  /** Today's WOD template, when the resolved session is WOD-kind. */
  wod: WodOnlyTemplateDto | null
  names: ReadonlyMap<string, string>
  onStart: (to: string) => void
  onCta: (cta: TrainingCta) => void
}) {
  if (today.kind === 'session') {
    const { session } = today
    if (session.wodTemplateId && wod) {
      return (
        <WodHeroCard wod={wod} names={names} bestLabel={null} onStart={() => onStart(session.to)} />
      )
    }
    // Strength / run / a WOD whose template hasn't landed in the cache
    // yet: a compact row rather than a card built for a movement list.
    return (
      <div className="plan-row">
        <div className="plan-day">TODAY</div>
        <button type="button" className="plan-main" onClick={() => onStart(session.to)}>
          <div className="plan-top">
            <span className="nm">{session.name}</span>
          </div>
          <div className="plan-meta">{session.meta}</div>
        </button>
        <button
          type="button"
          className="plan-go"
          aria-label={session.meta === 'RUN' ? 'Log run' : 'Start workout'}
          onClick={() => onStart(session.to)}
        >
          <Icon name={session.meta === 'RUN' ? 'run' : 'stopwatch'} size={16} />
        </button>
      </div>
    )
  }

  if (today.kind === 'fallback') {
    const { fallback } = today
    return (
      <div className="fit-empty">
        <div className="t">
          {fallback.type ? `Today is a ${fallback.label} day` : `Today: ${fallback.label}`}
        </div>
        <div className="b">{fallback.blurb}</div>
        {fallback.cta && (
          <div className="btn-row" style={{ marginTop: 10, justifyContent: 'center' }}>
            <button
              type="button"
              className="fit-startbtn"
              onClick={() =>
                onCta({ label: fallback.cta!.label, action: { kind: 'nav', to: fallback.cta!.to } })
              }
            >
              {fallback.cta.label}
            </button>
          </div>
        )}
      </div>
    )
  }

  // Nothing scheduled and no weekly rhythm. Every button here STARTS
  // something — the old pair ("Plan your week" / "Browse WODs") only
  // navigated, which is the gap the dashboard exists to close.
  return (
    <div className="fit-empty">
      <div className="t">Nothing scheduled today</div>
      <div className="b">Start something now, or plan your week from the Plan tab.</div>
      <div className="btn-row" style={{ marginTop: 10, justifyContent: 'center' }}>
        {today.ctas.map((cta) => (
          <button
            key={cta.label}
            type="button"
            className="fit-startbtn ghost"
            onClick={() => onCta(cta)}
          >
            {cta.label}
          </button>
        ))}
      </div>
    </div>
  )
}

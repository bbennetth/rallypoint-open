// /run/log — standalone quick-log page for cardio (run, row, bike, swim,
// …), outside the strength composer. Thin page-chrome host around the
// shared `CardioLogForm` (ui/CardioLogSheet.tsx) — the same field set and
// save logic the "Log cardio" drawer sheet uses, so there's exactly one
// copy of the form. When reached from a Plan entry
// (?planId=&planItemId=&note=), the note prefills the notes field and a
// successful save clears the scheduled item so it drops off Upcoming.

import { useNavigate, useSearchParams } from 'react-router-dom'
import { Icon } from '@rallypoint/ui'
import { CardioLogForm } from '../ui/CardioLogSheet.js'

export function RunLogPage() {
  const nav = useNavigate()
  const [searchParams] = useSearchParams()
  const planId = searchParams.get('planId')
  const planItemId = searchParams.get('planItemId')
  const noteParam = searchParams.get('note')
  const planRef = planId && planItemId ? { planId, planItemId, note: noteParam } : undefined

  return (
    <div className="page-pad" style={{ display: 'grid', gap: 16 }}>
      <header className="fit-head">
        <div className="top">
          <button
            type="button"
            className="live-iconbtn"
            onClick={() => nav('/log')}
            aria-label="Back"
          >
            <Icon name="chevron" size={16} />
          </button>
          <div>
            <div className="eyebrow">LOG</div>
            <h1>Log cardio</h1>
          </div>
        </div>
        <p className="sub">
          Activity, distance, time, incline and effort — logged after the fact. Weather is stamped
          automatically when you allow location.
        </p>
      </header>

      <CardioLogForm
        planRef={planRef}
        prefillNote={noteParam}
        onSaved={() => nav('/log/history')}
        onClose={() => nav('/log')}
        hideCancel
      />
    </div>
  )
}

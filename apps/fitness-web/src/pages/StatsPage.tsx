// /stats — merged Body + Training + Food analytics tab. A docked SubBar
// dispatches between three sub-views (Training is the default per the
// design handoff); `/stats/body` selects the Body view and
// `/stats/food` the calorie dashboard.

import { useLocation, useNavigate } from 'react-router-dom'
import { SubBar, SubBarSeg } from '@rallypoint/ui'
import { TrainingView } from '../ui/TrainingView.js'
import { BodyView } from '../ui/BodyView.js'
import { FoodStatsView } from '../ui/FoodStatsView.js'
import { FitFab } from '../ui/FitFab.js'

type StatsTab = 'body' | 'training' | 'food'

function StatsSubBar({ active }: { active: StatsTab }) {
  const nav = useNavigate()
  return (
    <SubBar label="Stats sub-section" fab={<FitFab />}>
      <div className="fit-subseg" role="tablist">
        <SubBarSeg
          active={active === 'body'}
          aria-selected={active === 'body'}
          onClick={() => nav('/stats/body')}
        >
          Body
        </SubBarSeg>
        <SubBarSeg
          active={active === 'training'}
          aria-selected={active === 'training'}
          onClick={() => nav('/stats')}
        >
          Training
        </SubBarSeg>
        <SubBarSeg
          active={active === 'food'}
          aria-selected={active === 'food'}
          onClick={() => nav('/stats/food')}
        >
          Food
        </SubBarSeg>
      </div>
    </SubBar>
  )
}

export function StatsPage() {
  const { pathname } = useLocation()
  const active: StatsTab = pathname.endsWith('/body')
    ? 'body'
    : pathname.endsWith('/food')
      ? 'food'
      : 'training'
  return (
    <>
      <StatsSubBar active={active} />
      {active === 'body' ? <BodyView /> : active === 'food' ? <FoodStatsView /> : <TrainingView />}
    </>
  )
}

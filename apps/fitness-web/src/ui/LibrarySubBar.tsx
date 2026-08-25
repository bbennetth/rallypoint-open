// Shared sub-bar for the Library tab. Three segments — All exercises,
// Saved (starred subset), and Workouts (the template browser for both
// WODs and saved strength workouts). LibraryPage + WodLibraryPage both
// render this so the user can hop between sub-views without losing the
// sub-bar chrome.

import { useNavigate } from 'react-router-dom'
import { SubBar, SubBarSeg } from '@rallypoint/ui'
import { FitFab } from './FitFab.js'

export type LibraryTab = 'all' | 'saved' | 'wods'

export function LibrarySubBar({ active }: { active: LibraryTab }) {
  const nav = useNavigate()
  return (
    <SubBar label="Library sub-section" fab={<FitFab />}>
      <div className="fit-subseg" role="tablist">
        <SubBarSeg
          active={active === 'all'}
          aria-selected={active === 'all'}
          onClick={() => nav('/library')}
        >
          All
        </SubBarSeg>
        <SubBarSeg
          active={active === 'saved'}
          aria-selected={active === 'saved'}
          onClick={() => nav('/library/saved')}
        >
          Saved
        </SubBarSeg>
        <SubBarSeg
          active={active === 'wods'}
          aria-selected={active === 'wods'}
          onClick={() => nav('/library/wods')}
        >
          Workouts
        </SubBarSeg>
      </div>
    </SubBar>
  )
}

// /live/wod/:templateId and /live/strength/new — the fullscreen live-
// session takeover. Branches by route: WOD sessions render the
// existing tap-to-count engine, strength sessions render the new
// reducer-backed UI from S10.

import { useLocation } from 'react-router-dom'
import { WodSessionPage } from './WodSessionPage.js'
import { StrengthSessionPage } from './StrengthSessionPage.js'

export function LiveSessionPage() {
  const { pathname } = useLocation()
  if (pathname.startsWith('/live/strength')) return <StrengthSessionPage />
  return <WodSessionPage />
}

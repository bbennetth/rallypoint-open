import { useEffect } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { HomePage } from './pages/HomePage.js'
import { PlannerPage } from './pages/PlannerPage.js'
import { HealthPage } from './pages/HealthPage.js'
import { CmdPage } from './pages/CmdPage.js'

// react-router doesn't scroll on SPA navigations. The nav and cross-page
// links depend on anchors (/#events, /#products, /#open-source,
// /cmd#install), so on every location change scroll to the hash target if
// one exists, else back to the top.
function ScrollToAnchor() {
  const { pathname, hash } = useLocation()
  useEffect(() => {
    if (hash) {
      document.getElementById(hash.slice(1))?.scrollIntoView()
    } else {
      window.scrollTo(0, 0)
    }
  }, [pathname, hash])
  return null
}

export function App() {
  return (
    <>
      <ScrollToAnchor />
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/planner" element={<PlannerPage />} />
        <Route path="/health" element={<HealthPage />} />
        <Route path="/cmd" element={<CmdPage />} />
        {/* Legacy routes from the pre-redesign site. */}
        <Route path="/fitness" element={<Navigate to="/health" replace />} />
        <Route path="/events" element={<Navigate to="/#events" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  )
}

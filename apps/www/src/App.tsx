import { Navigate, Route, Routes } from 'react-router-dom'
import { HomePage } from './pages/HomePage.js'
import { PlannerPage } from './pages/PlannerPage.js'
import { EventsPage } from './pages/EventsPage.js'

export function App() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/planner" element={<PlannerPage />} />
      <Route path="/events" element={<EventsPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

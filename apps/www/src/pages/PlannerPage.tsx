import { ProductPage } from '../ui/ProductPage.js'
import { PLANNER_WEB_URL } from '../config.js'

export function PlannerPage() {
  return (
    <ProductPage
      name="Planner"
      tagline="Your day, organised."
      features={[
        'My Day and Upcoming roll up your tasks and personal events.',
        'Task lists with priorities, due dates, and recurring items.',
        'Quick notes and personal events, always one tap away.',
        'Shared lists and group events you choose to follow show up too.',
      ]}
      cta={{ label: 'Open Planner', href: PLANNER_WEB_URL }}
    />
  )
}

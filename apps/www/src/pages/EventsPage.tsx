import { ProductPage } from '../ui/ProductPage.js'
import { EVENTS_WEB_URL } from '../config.js'

export function EventsPage() {
  return (
    <ProductPage
      name="Events"
      tagline="Events, run with your team."
      features={[
        'Create events and collaborate with editors on every detail.',
        'Build lineups and schedules across stages and days.',
        'Draw maps with points of interest and no-go zones.',
        'Organise attendees into groups with chat and meet-ups.',
      ]}
      cta={{ label: 'Open Events', href: EVENTS_WEB_URL }}
    />
  )
}

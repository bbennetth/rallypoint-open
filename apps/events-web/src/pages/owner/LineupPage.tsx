import { LineupEditor } from '../../ui/LineupEditor.js'
import { useEventOutlet } from './_event-outlet.js'

// Owner-side Lineup tab. Wraps the existing <LineupEditor> at the
// route level so the editor lands on its own URL
// (`/events/:slug/lineup`) and reads the event from the shared
// EventOwnerLayout outlet.

export function LineupPage() {
  const { event } = useEventOutlet()
  return (
    <main className="page-pad">
      <div className="max-w-3xl mx-auto space-y-5">
        <header className="space-y-1">
          <p
            className="text-xs font-medium"
            style={{ color: 'var(--acid)' }}
          >
            Lineup
          </p>
          <h1 className="display text-2xl">{event.name}</h1>
        </header>
        <LineupEditor eventId={event.id} reloadSignal={0} />
      </div>
    </main>
  )
}

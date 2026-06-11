import { SessionsEditor } from '../../ui/SessionsEditor.js'
import { useEventOutlet } from './_event-outlet.js'

export function SessionsPage() {
  const { event } = useEventOutlet()
  const isOwner = event.viewer_role === 'owner'
  return (
    <main className="page-pad">
      <div className="max-w-3xl mx-auto space-y-5">
        <header className="space-y-1">
          <p
            className="text-xs font-medium"
            style={{ color: 'var(--acid)' }}
          >
            Sessions
          </p>
          <h1 className="display text-2xl">{event.name}</h1>
        </header>
        <SessionsEditor eventId={event.id} isOwner={isOwner} />
      </div>
    </main>
  )
}

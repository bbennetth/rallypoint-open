import { PublicPagePanel, EventDetailPage as _placeholder } from '../EventDetailPage.js'
import { useEventOutlet } from './_event-outlet.js'

// Keep the EventDetailPage import alive (it bundles the shared
// PublicPagePanel) without rendering its main view. The underscore
// re-export prevents the bundler from tree-shaking the chunk we
// actually need.
void _placeholder

export function PublicPagePage() {
  const { event, reload } = useEventOutlet()
  return (
    <main className="page-pad">
      <div className="max-w-3xl mx-auto space-y-5">
        <header className="space-y-1">
          <p
            className="text-xs font-medium"
            style={{ color: 'var(--acid)' }}
          >
            Public Page
          </p>
          <h1 className="display text-2xl">{event.name}</h1>
          <p className="text-white/60 text-sm mt-1">
            Configure how this event appears at{' '}
            <code className="mono text-xs">{`/e/${event.slug}`}</code>.
          </p>
        </header>
        <PublicPagePanel event={event} onSaved={() => void reload()} />
      </div>
    </main>
  )
}

import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ApiError, createEvent, type CreateEventInput, type PrivacyMode } from '../lib/api.js'

type SubmitState = 'idle' | 'submitting'

export function EventsNewPage() {
  const navigate = useNavigate()

  const [name, setName] = useState('')
  const [timezone, setTimezone] = useState(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone,
  )
  const [description, setDescription] = useState('')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [locationLabel, setLocationLabel] = useState('')
  const [privacyMode, setPrivacyMode] = useState<PrivacyMode>('public')

  const [submitState, setSubmitState] = useState<SubmitState>('idle')
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setSubmitState('submitting')

    const input: CreateEventInput = {
      name: name.trim(),
      timezone: timezone.trim(),
      ...(description.trim() ? { description: description.trim() } : {}),
      ...(startDate ? { startDate } : {}),
      ...(endDate ? { endDate } : {}),
      ...(locationLabel.trim() ? { locationLabel: locationLabel.trim() } : {}),
      privacyMode,
    }

    try {
      const created = await createEvent(input)
      void navigate(`/events/${created.slug}`)
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === 'validation') {
          setError(`Validation error: ${err.message}`)
        } else {
          setError(err.message)
        }
      } else {
        setError('Unexpected error. Please try again.')
      }
      setSubmitState('idle')
    }
  }

  return (
    <main className="page-pad">
      <div className="max-w-xl mx-auto space-y-6">
        <header className="space-y-1">
          <p className="text-xs font-medium text-[color:var(--ink-mute)]">Rallypoint Events</p>
          <h1 className="display text-2xl">New Event</h1>
        </header>

        {error && (
          <div
            role="alert"
            className="p-3 text-sm text-white/80"
            style={{
              border: '1.5px solid var(--hot)',
              background: 'color-mix(in srgb, var(--hot) 12%, transparent)',
            }}
          >
            {error}
          </div>
        )}

        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
          <fieldset className="space-y-4">
            <div className="space-y-1">
              <label htmlFor="name" className="block text-xs font-medium text-[color:var(--ink-mute)]">
                Name <span className="text-white/60">*</span>
              </label>
              <input
                id="name"
                type="text"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="cyber-input"
                placeholder="My Awesome Event"
              />
            </div>

            <div className="space-y-1">
              <label htmlFor="timezone" className="block text-xs font-medium text-[color:var(--ink-mute)]">
                Timezone <span className="text-white/60">*</span>
              </label>
              <input
                id="timezone"
                type="text"
                required
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                className="cyber-input"
                placeholder="America/New_York"
              />
            </div>

            <div className="space-y-1">
              <label htmlFor="description" className="block text-xs font-medium text-[color:var(--ink-mute)]">
                Description <span className="text-white/40 text-xs">(optional)</span>
              </label>
              <textarea
                id="description"
                rows={3}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="cyber-input resize-y"
                placeholder="Tell people what this event is about…"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <label htmlFor="startDate" className="block text-xs font-medium text-[color:var(--ink-mute)]">
                  Start date
                </label>
                <input
                  id="startDate"
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  className="cyber-input"
                />
              </div>
              <div className="space-y-1">
                <label htmlFor="endDate" className="block text-xs font-medium text-[color:var(--ink-mute)]">
                  End date
                </label>
                <input
                  id="endDate"
                  type="date"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                  className="cyber-input"
                />
              </div>
            </div>

            <div className="space-y-1">
              <label htmlFor="locationLabel" className="block text-xs font-medium text-[color:var(--ink-mute)]">
                Location <span className="text-white/40 text-xs">(optional)</span>
              </label>
              <input
                id="locationLabel"
                type="text"
                value={locationLabel}
                onChange={(e) => setLocationLabel(e.target.value)}
                className="cyber-input"
                placeholder="Madison Square Garden, New York"
              />
            </div>

            <div className="space-y-1">
              <label htmlFor="privacyMode" className="block text-xs font-medium text-[color:var(--ink-mute)]">
                Privacy
              </label>
              <select
                id="privacyMode"
                value={privacyMode}
                onChange={(e) => setPrivacyMode(e.target.value as PrivacyMode)}
                className="cyber-input"
              >
                <option value="public">Public</option>
                <option value="unlisted">Unlisted</option>
                <option value="private">Private</option>
              </select>
            </div>
          </fieldset>

          <div className="flex items-center gap-3 pt-2">
            <button
              type="submit"
              disabled={submitState === 'submitting'}
              className="btn-brutal disabled:opacity-50"
              style={{ width: 'auto' }}
            >
              {submitState === 'submitting' ? 'Creating…' : 'Create event'}
            </button>
            <Link
              to="/me/events"
              className="text-sm text-[color:var(--ink)] hover:opacity-70 transition-opacity"
            >
              Cancel
            </Link>
          </div>
        </form>
      </div>
    </main>
  )
}

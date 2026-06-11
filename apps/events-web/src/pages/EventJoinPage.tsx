import { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { ApiError, acceptInvite } from '../lib/api.js'

export function EventJoinPage() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const [code, setCode] = useState(params.get('code') ?? '')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleJoin(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      const { event_slug, role } = await acceptInvite(code.trim())
      // Phase 4 (#16): non-collaborator invitees (viewer role) land on
      // the attending decision page, where they pick "Continue solo" or
      // "Join a group". Editors / owners (people invited as
      // collaborators) jump straight to the owner-side event detail.
      if (role === 'viewer') {
        void navigate(`/events/${encodeURIComponent(event_slug)}/attend`)
      } else {
        void navigate(`/events/${encodeURIComponent(event_slug)}`)
      }
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === 'invite_invalid') {
          setError('That invite is not valid.')
        } else if (err.code === 'invite_expired') {
          setError('That invite has expired.')
        } else if (err.code === 'invite_already_consumed') {
          setError('That invite has already been used.')
        } else if (err.code === 'already_owner') {
          setError('You already own this event.')
        } else if (err.code === 'already_member') {
          setError('You are already a member of this event.')
        } else {
          setError(err.message)
        }
      } else {
        setError('Could not join the event.')
      }
      setSubmitting(false)
    }
  }

  return (
    <main className="page-pad">
      <div className="max-w-md w-full mx-auto space-y-5">
        <header className="space-y-1">
          <p className="text-xs font-medium text-[color:var(--ink-mute)]">Join an event</p>
          <h1 className="display text-2xl">Enter your invite code</h1>
          <p className="text-sm text-white/60">
            Paste the code an event owner or editor shared with you.
          </p>
        </header>

        {error && (
          <div
            className="p-3 text-sm text-white/80"
            style={{
              border: '1.5px solid var(--hot)',
              background: 'color-mix(in srgb, var(--hot) 12%, transparent)',
            }}
          >
            {error}
          </div>
        )}

        <form onSubmit={(e) => void handleJoin(e)} className="space-y-3">
          <input
            type="text"
            required
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="rpe_…"
            className="cyber-input mono"
          />
          <button
            type="submit"
            disabled={submitting || !code.trim()}
            className="btn-brutal disabled:opacity-50"
          >
            {submitting ? 'Joining…' : 'Join event'}
          </button>
        </form>

        <a href="/me/events" className="inline-block text-sm text-[color:var(--ink)] underline hover:opacity-70">
          ← My events
        </a>
      </div>
    </main>
  )
}

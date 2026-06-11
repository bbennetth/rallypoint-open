import { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { ApiError, joinGroup } from '../lib/api.js'

export function GroupJoinPage() {
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
      const { group_id } = await joinGroup(code.trim())
      void navigate(`/groups/${group_id}`)
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === 'group_join_code_invalid') {
          setError('That join code is not valid.')
        } else if (err.code === 'already_group_member') {
          setError('You are already a member of this group.')
        } else if (err.code === 'group_full') {
          setError('This group has reached its member limit.')
        } else if (err.code === 'group_invite_expired') {
          setError('That invite has expired.')
        } else if (err.code === 'group_invite_already_consumed') {
          setError('That invite has already been used.')
        } else {
          setError(err.message)
        }
      } else {
        setError('Could not join the group.')
      }
      setSubmitting(false)
    }
  }

  return (
    <main className="page-pad">
      <div className="max-w-md w-full mx-auto space-y-5">
        <header className="space-y-1">
          <p className="text-xs font-medium text-[color:var(--ink-mute)]">Join a group</p>
          <h1 className="display text-2xl">Enter your join code</h1>
          <p className="text-sm text-white/60">
            Paste the code a group owner shared with you.
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
            placeholder="rpj_…"
            className="cyber-input mono"
          />
          <button
            type="submit"
            disabled={submitting || !code.trim()}
            className="btn-brutal disabled:opacity-50"
          >
            {submitting ? 'Joining…' : 'Join group'}
          </button>
        </form>

        <a href="/me/events" className="inline-block text-sm text-[color:var(--ink)] underline hover:opacity-70">
          ← My events
        </a>
      </div>
    </main>
  )
}

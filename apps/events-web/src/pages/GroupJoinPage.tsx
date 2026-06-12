import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  ApiError,
  joinGroup,
  previewGroupJoin,
  type GroupJoinPreviewDto,
} from '../lib/api.js'

// Join-a-group flow (#440, festival-planner parity). Codes come in two
// shapes: the human 6-char short code (QR / share links / read-aloud)
// and the long rpj_ token (legacy invites). A ?code= deep link — what
// the QR encodes — auto-resolves to a preview card (group name +
// member count) with a single Join button; already-members are
// redirected straight into the group.

function joinErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case 'group_join_code_invalid':
        return 'That join code is not valid.'
      case 'already_group_member':
        return 'You are already a member of this group.'
      case 'group_full':
        return 'This group has reached its member limit.'
      case 'group_invite_expired':
        return 'That invite has expired.'
      case 'group_invite_already_consumed':
        return 'That invite has already been used.'
      default:
        return err.message
    }
  }
  return 'Could not join the group.'
}

export function GroupJoinPage() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const deepLinkCode = params.get('code') ?? ''
  const [code, setCode] = useState(deepLinkCode)
  const [preview, setPreview] = useState<GroupJoinPreviewDto | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const resolvePreview = useCallback(
    async (value: string) => {
      const trimmed = value.trim()
      if (!trimmed) return
      setError(null)
      setPreviewing(true)
      try {
        const p = await previewGroupJoin(trimmed)
        if (p.you_are_member) {
          // Already in — straight into the group shell (FP behavior).
          void navigate(`/groups/${p.group_id}`)
          return
        }
        setPreview(p)
      } catch (err) {
        setPreview(null)
        setError(joinErrorMessage(err))
      } finally {
        setPreviewing(false)
      }
    },
    [navigate],
  )

  // QR / share-link deep link: resolve immediately on mount (and only
  // for the mount-time code — manual entry goes through the form).
  useEffect(() => {
    if (deepLinkCode) void resolvePreview(deepLinkCode)
  }, [deepLinkCode, resolvePreview])

  async function handlePreview(e: React.FormEvent) {
    e.preventDefault()
    await resolvePreview(code)
  }

  async function handleJoin() {
    setError(null)
    setSubmitting(true)
    try {
      const { group_id } = await joinGroup(code.trim())
      void navigate(`/groups/${group_id}`)
    } catch (err) {
      setError(joinErrorMessage(err))
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
            Enter the 6-character code (or paste an invite link code) a group member shared
            with you.
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

        {preview ? (
          <section
            className="p-4 space-y-3"
            style={{ border: '1.5px solid var(--line)', background: 'var(--surface)' }}
          >
            <p className="text-xs font-medium text-[color:var(--ink-mute)]">You're joining</p>
            <h2 className="display text-xl">{preview.name}</h2>
            <p className="text-sm text-white/60">
              {preview.member_count} member{preview.member_count === 1 ? '' : 's'} ·{' '}
              {preview.event_name}
            </p>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => void handleJoin()}
                disabled={submitting}
                className="btn-brutal disabled:opacity-50"
                style={{ width: 'auto' }}
              >
                {submitting ? 'Joining…' : 'Join group'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setPreview(null)
                  setCode('')
                }}
                className="btn-ghost"
                style={{ width: 'auto' }}
                disabled={submitting}
              >
                Different code
              </button>
            </div>
          </section>
        ) : (
          <form onSubmit={(e) => void handlePreview(e)} className="space-y-3">
            <input
              type="text"
              required
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="e.g. ABC2D3"
              aria-label="Join code"
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              className="cyber-input mono"
            />
            <button
              type="submit"
              disabled={previewing || !code.trim()}
              className="btn-brutal disabled:opacity-50"
            >
              {previewing ? 'Looking up…' : 'Continue'}
            </button>
          </form>
        )}

        <a
          href="/me/events"
          className="inline-block text-sm text-[color:var(--ink)] underline hover:opacity-70"
        >
          ← My events
        </a>
      </div>
    </main>
  )
}

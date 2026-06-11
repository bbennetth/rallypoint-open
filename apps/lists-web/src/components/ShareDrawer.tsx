import { useEffect, useState } from 'react'
import { Button, Drawer, useToast } from '@rallypoint/ui'
import {
  ApiError,
  createListInvite,
  listListInvites,
  listListShares,
  revokeListInvite,
  revokeListShare,
  type ListInviteDto,
  type ListShareDto,
} from '../lib/api.js'

// #128 — Share-by-email surface for a `visibility='private'` list.
// Only renders for the list creator. Current shares + pending invites
// + a tiny invite-by-email form. The API returns an invite code (no
// SMTP wiring); we surface it as a copy-link + mailto: fallback so
// the user can hand it to the recipient via their own email client.
//
// The raw code is shown ONCE after mint — the pending-invites list
// only carries email + expiry (no re-fetchable code per the events-
// invite convention). The UI labels the panel "copy it now (it won't
// show again)" to make that explicit. If the user dismisses the
// panel without copying, they revoke + re-mint from the pending list.
//
// The recipient lands on `/share/<code>`, signs in/up via RPID, and
// the SPA's auto-accept flow there inserts the share row.

export interface ShareDrawerProps {
  open: boolean
  onClose: () => void
  listId: string
  listName: string
}

const STATUS_LOADING = 'loading' as const
const STATUS_READY = 'ready' as const
const STATUS_ERROR = 'error' as const

type LoadState =
  | { status: typeof STATUS_LOADING }
  | {
      status: typeof STATUS_READY
      shares: ListShareDto[]
      invites: ListInviteDto[]
    }
  | { status: typeof STATUS_ERROR; message: string }

export function ShareDrawer({ open, onClose, listId, listName }: ShareDrawerProps) {
  const toast = useToast()
  const [state, setState] = useState<LoadState>({ status: STATUS_LOADING })
  const [email, setEmail] = useState('')
  const [pendingCode, setPendingCode] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function load() {
    setState({ status: STATUS_LOADING })
    try {
      const [shares, invites] = await Promise.all([
        listListShares(listId),
        listListInvites(listId),
      ])
      setState({ status: STATUS_READY, shares: shares.items, invites: invites.items })
    } catch (err) {
      setState({
        status: STATUS_ERROR,
        message: err instanceof ApiError ? `${err.code}: ${err.message}` : 'Failed to load shares.',
      })
    }
  }

  useEffect(() => {
    if (!open) return
    void load()
    // Re-reset the in-flight code when the drawer re-opens.
    setPendingCode(null)
    setEmail('')
  }, [open, listId])

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault()
    if (submitting || email.trim().length === 0) return
    setSubmitting(true)
    try {
      const invite = await createListInvite(listId, email.trim())
      setEmail('')
      setPendingCode(invite.code)
      await load()
      toast({ tone: 'success', body: `Invite minted for ${invite.invited_email}.` })
    } catch (err) {
      toast({
        tone: 'error',
        body: err instanceof ApiError ? err.message : 'Failed to mint invite.',
      })
    } finally {
      setSubmitting(false)
    }
  }

  async function handleRevokeInvite(inviteId: string, email: string) {
    try {
      await revokeListInvite(listId, inviteId)
      await load()
      toast({ tone: 'success', body: `Invite to ${email} revoked.` })
    } catch (err) {
      toast({
        tone: 'error',
        body: err instanceof ApiError ? err.message : 'Failed to revoke invite.',
      })
    }
  }

  async function handleRevokeShare(userId: string) {
    try {
      await revokeListShare(listId, userId)
      await load()
      toast({ tone: 'success', body: 'Share revoked.' })
    } catch (err) {
      toast({
        tone: 'error',
        body: err instanceof ApiError ? err.message : 'Failed to revoke share.',
      })
    }
  }

  function shareLinkFor(code: string): string {
    const base = window.location.origin
    return `${base}/share/${encodeURIComponent(code)}`
  }

  return (
    <Drawer open={open} onClose={onClose} title={`Share "${listName}"`}>
      <div className="space-y-5">
        <p className="text-sm text-[color:var(--ink-dim)]">
          Private lists only show to you. Invite people by email — they
          get a link, sign in via Rallypoint, and join.
        </p>

        {/* Pending share-link from the last invite mint. The API
            returns the raw code once; surface it as copy-to-clipboard
            + a mailto: fallback so the user can drop it into their
            mail client. */}
        {pendingCode && (
          <section
            className="p-3 space-y-2"
            style={{
              border: '1.5px solid var(--acid)',
              background: 'color-mix(in srgb, var(--acid) 12%, transparent)',
            }}
          >
            <p style={{ fontSize: 12 }}>
              Share this link · copy it now (it won't show again)
            </p>
            <code
              className="block break-all"
              style={{ fontSize: 12, color: 'var(--ink-dim)' }}
            >
              {shareLinkFor(pendingCode)}
            </code>
            <div className="flex gap-2 flex-wrap">
              <Button
                variant="ghost"
                onClick={() => {
                  void navigator.clipboard.writeText(shareLinkFor(pendingCode)).then(
                    () => toast({ tone: 'success', body: 'Link copied.' }),
                    () =>
                      toast({
                        tone: 'error',
                        body: 'Copy failed — select + copy manually.',
                      }),
                  )
                }}
              >
                Copy link
              </Button>
              <a
                className="btn-ghost"
                style={{ width: 'auto' }}
                href={`mailto:?subject=${encodeURIComponent(`I shared "${listName}" with you`)}&body=${encodeURIComponent(
                  `Open the link to join: ${shareLinkFor(pendingCode)}`,
                )}`}
              >
                Open in mail
              </a>
              <Button variant="ghost" onClick={() => setPendingCode(null)}>
                Done
              </Button>
            </div>
          </section>
        )}

        <form onSubmit={(e) => void handleInvite(e)} className="space-y-2">
          <label className="block text-sm text-[color:var(--ink-dim)]">
            Invite by email
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="friend@example.com"
              className="cyber-input mt-1"
              required
            />
          </label>
          <Button variant="brutal" type="submit" disabled={submitting}>
            {submitting ? 'Minting…' : 'Create share link'}
          </Button>
        </form>

        {state.status === STATUS_LOADING && (
          <p className="text-sm text-[color:var(--ink-dim)]">Loading…</p>
        )}
        {state.status === STATUS_ERROR && (
          <p className="text-sm" style={{ color: 'var(--hot)' }}>
            {state.message}
          </p>
        )}

        {state.status === STATUS_READY && (
          <>
            <section className="space-y-2">
              <h3 style={{ fontSize: 12, color: 'var(--ink-dim)' }}>
                Shared with ({state.shares.length})
              </h3>
              {state.shares.length === 0 ? (
                <p className="text-sm" style={{ color: 'var(--ink-dim)' }}>Nobody yet.</p>
              ) : (
                <ul className="space-y-1.5">
                  {state.shares.map((s) => (
                    <li
                      key={s.id}
                      className="flex items-center justify-between gap-2 p-2"
                      style={{ border: '1.5px solid var(--line)' }}
                    >
                      <span className="text-sm truncate" title={s.user_id}>
                        {s.user_id}
                      </span>
                      <Button variant="ghost" onClick={() => void handleRevokeShare(s.user_id)}>
                        Revoke
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="space-y-2">
              <h3 style={{ fontSize: 12, color: 'var(--ink-dim)' }}>
                Pending invites ({state.invites.length})
              </h3>
              {state.invites.length === 0 ? (
                <p className="text-sm text-[color:var(--ink-dim)]">No pending invites.</p>
              ) : (
                <ul className="space-y-1.5">
                  {state.invites.map((i) => (
                    <li
                      key={i.id}
                      className="flex items-center justify-between gap-2 p-2"
                      style={{ border: '1.5px solid var(--line)' }}
                    >
                      <div className="min-w-0">
                        <div className="text-sm truncate">{i.invited_email}</div>
                        <div
                          className="mono"
                          style={{ fontSize: 9, color: 'var(--ink-mute)' }}
                        >
                          expires {new Date(i.expires_at).toLocaleDateString()}
                        </div>
                      </div>
                      <Button
                        variant="ghost"
                        onClick={() => void handleRevokeInvite(i.id, i.invited_email)}
                      >
                        Revoke
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </div>
    </Drawer>
  )
}

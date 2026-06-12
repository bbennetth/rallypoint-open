import { useEffect, useState } from 'react'
import { Button, useToast } from '@rallypoint/ui'
import {
  ApiError,
  createMcpToken,
  listMcpTokens,
  revokeMcpToken,
  type McpTokenDto,
} from '../lib/api.js'
import { tokenStatus, type TokenStatus } from '../lib/tokens.js'

// MCP personal-access-token settings (RPL v1.0.0 S11 UI). Issue a token for
// the Lists MCP server, see the raw secret ONCE, and revoke. A user only
// ever sees their own tokens (the API is session-gated).

const LOADING = 'loading' as const
const READY = 'ready' as const
const ERROR = 'error' as const

type LoadState =
  | { status: typeof LOADING }
  | { status: typeof READY; tokens: McpTokenDto[] }
  | { status: typeof ERROR; message: string }

// Expiry presets (days); '' = never.
const EXPIRY_OPTIONS: { label: string; days: number | '' }[] = [
  { label: 'Never', days: '' },
  { label: '30 days', days: 30 },
  { label: '90 days', days: 90 },
  { label: '1 year', days: 365 },
]

const STATUS_STYLE: Record<TokenStatus, { color: string; label: string }> = {
  active: { color: 'var(--acid)', label: 'active' },
  expired: { color: 'var(--ink-mute)', label: 'expired' },
  revoked: { color: 'var(--hot)', label: 'revoked' },
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString()
}

export function McpTokensPage() {
  const toast = useToast()
  const [state, setState] = useState<LoadState>({ status: LOADING })
  const [label, setLabel] = useState('')
  const [expiryDays, setExpiryDays] = useState<number | ''>('')
  const [creating, setCreating] = useState(false)
  // The raw secret from the most recent create — shown once, then dismissed.
  const [freshSecret, setFreshSecret] = useState<string | null>(null)

  async function load() {
    setState({ status: LOADING })
    try {
      const page = await listMcpTokens()
      setState({ status: READY, tokens: page.items })
    } catch (err) {
      setState({
        status: ERROR,
        message: err instanceof ApiError ? `${err.code}: ${err.message}` : 'Failed to load tokens.',
      })
    }
  }

  useEffect(() => {
    void load()
  }, [])

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    if (creating || label.trim().length === 0) return
    setCreating(true)
    try {
      const created = await createMcpToken({
        label: label.trim(),
        ...(expiryDays !== '' ? { expiresInDays: expiryDays } : {}),
      })
      setFreshSecret(created.token)
      setLabel('')
      setExpiryDays('')
      await load()
    } catch (err) {
      toast({ tone: 'error', body: err instanceof ApiError ? err.message : 'Failed to create token.' })
    } finally {
      setCreating(false)
    }
  }

  async function handleRevoke(token: McpTokenDto) {
    if (!window.confirm(`Revoke "${token.label}"? Any MCP client using it will stop working.`)) return
    try {
      await revokeMcpToken(token.id)
      await load()
      toast({ tone: 'success', body: 'Token revoked.' })
    } catch (err) {
      toast({ tone: 'error', body: err instanceof ApiError ? err.message : 'Failed to revoke token.' })
    }
  }

  async function copySecret(secret: string) {
    try {
      await navigator.clipboard.writeText(secret)
      toast({ tone: 'success', body: 'Token copied.' })
    } catch {
      toast({ tone: 'error', body: 'Copy failed — select and copy manually.' })
    }
  }

  // Recomputed per render; a low-traffic settings page needs no timer to
  // re-evaluate token status.
  const now = Date.now()

  return (
    <main className="page-pad">
      <div className="content-cap mx-auto space-y-6">
        <div>
          <h1 className="display text-2xl">MCP tokens</h1>
          <p className="mt-1 text-sm" style={{ color: 'var(--ink-dim)' }}>
            Personal access tokens for the Lists MCP server. Present a token as
            a bearer credential; it acts as you. The secret is shown once — store
            it now.
          </p>
        </div>

        {freshSecret && (
          <div
            className="space-y-2 p-4"
            style={{
              border: '1.5px solid var(--acid)',
              background: 'color-mix(in srgb, var(--acid) 10%, transparent)',
            }}
          >
            <p className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>
              Copy your new token now — it won't be shown again.
            </p>
            <div className="flex items-center gap-2">
              <code
                className="flex-1 overflow-x-auto rounded px-2 py-1 text-xs"
                style={{ background: 'var(--surface-2)', color: 'var(--ink)' }}
              >
                {freshSecret}
              </code>
              <Button variant="ghost" onClick={() => void copySecret(freshSecret)}>
                Copy
              </Button>
            </div>
            <button
              type="button"
              onClick={() => setFreshSecret(null)}
              className="text-xs underline"
              style={{ color: 'var(--ink-dim)' }}
            >
              Done
            </button>
          </div>
        )}

        <form
          onSubmit={(e) => void handleCreate(e)}
          className="flex flex-wrap items-end gap-3 p-4"
          style={{ border: '1.5px solid var(--line)', background: 'var(--surface)' }}
        >
          <label className="flex-1 text-sm" style={{ color: 'var(--ink-dim)' }}>
            Label
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. My laptop"
              className="cyber-input mt-1"
              maxLength={80}
            />
          </label>
          <label className="text-sm" style={{ color: 'var(--ink-dim)' }}>
            Expires
            <select
              value={String(expiryDays)}
              onChange={(e) => setExpiryDays(e.target.value === '' ? '' : Number(e.target.value))}
              className="cyber-input mt-1"
              style={{ width: 'auto' }}
            >
              {EXPIRY_OPTIONS.map((o) => (
                <option key={o.label} value={String(o.days)}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <Button variant="brutal" type="submit" disabled={creating || label.trim().length === 0}>
            {creating ? 'Creating…' : 'Create token'}
          </Button>
        </form>

        {state.status === LOADING && <p className="text-sm" style={{ color: 'var(--ink-dim)' }}>Loading…</p>}
        {state.status === ERROR && (
          <div className="p-4" style={{ border: '1.5px solid var(--hot)' }}>
            <p className="text-sm" style={{ color: 'var(--ink)' }}>{state.message}</p>
            <button type="button" onClick={() => void load()} className="mt-2 text-sm underline" style={{ color: 'var(--ink-dim)' }}>
              Try again
            </button>
          </div>
        )}

        {state.status === READY && state.tokens.length === 0 && (
          <p className="text-sm" style={{ color: 'var(--ink-dim)' }}>No tokens yet.</p>
        )}

        {state.status === READY && state.tokens.length > 0 && (
          <ul className="space-y-2">
            {state.tokens.map((token) => {
              const st = tokenStatus(token, now)
              const style = STATUS_STYLE[st]
              return (
                <li
                  key={token.id}
                  className="flex flex-wrap items-center gap-3 px-4 py-3"
                  style={{ border: '1.5px solid var(--line)', background: 'var(--surface)' }}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-semibold" style={{ color: 'var(--ink)' }}>
                        {token.label}
                      </span>
                      <span
                        className="rounded-full border px-2 py-0.5 text-xs"
                        style={{ borderColor: style.color, color: style.color }}
                      >
                        {style.label}
                      </span>
                    </div>
                    <div className="mt-1 text-xs" style={{ color: 'var(--ink-dim)' }}>
                      Created {fmtDate(token.created_at)} · Last used {fmtDate(token.last_used_at)} · Expires{' '}
                      {fmtDate(token.expires_at)}
                    </div>
                  </div>
                  {st === 'active' && (
                    <button
                      type="button"
                      onClick={() => void handleRevoke(token)}
                      className="btn-ghost"
                      style={{ width: 'auto', color: 'var(--hot)', borderColor: 'var(--hot)' }}
                    >
                      Revoke
                    </button>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </main>
  )
}

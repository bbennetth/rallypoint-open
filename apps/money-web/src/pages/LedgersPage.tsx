import { useState, useEffect } from 'react'
import { createLedger, listLedgers, type LedgerDto } from '../lib/api.js'
import { SUPPORTED_CURRENCIES } from '@rallypoint/money-shared'

// Minimal slice-1 ledgers page. Lists the caller's own ledgers and
// provides a create-ledger form (name + currency). Full CRUD and
// expense/split UI arrive in slices 2-3.

export function LedgersPage({ selfUserId: _selfUserId }: { selfUserId: string }) {
  const [ledgers, setLedgers] = useState<LedgerDto[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState({
    name: '',
    currency: 'USD' as string,
    scopeType: 'personal' as string,
    scopeId: _selfUserId,
  })

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const page = await listLedgers()
      setLedgers(page.items)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load ledgers.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    if (!form.name.trim()) return
    setCreating(true)
    setError(null)
    try {
      const created = await createLedger({
        name: form.name.trim(),
        currency: form.currency as (typeof SUPPORTED_CURRENCIES)[number],
        scopeType: form.scopeType as 'personal' | 'group' | 'ledger_group',
        scopeId: form.scopeId || _selfUserId,
      })
      setLedgers((prev) => [created, ...prev])
      setForm({ name: '', currency: 'USD', scopeType: 'personal', scopeId: _selfUserId })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create ledger.')
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="page-pad" style={{ display: 'grid', gap: 24 }}>
      <header style={{ display: 'grid', gap: 4 }}>
        <h1 className="display" style={{ fontSize: 28, margin: 0 }}>
          My Ledgers
        </h1>
        <p style={{ color: 'var(--ink-dim)', fontSize: 14, margin: 0 }}>
          Track shared expenses across your groups and personal accounts.
        </p>
      </header>

      {/* Create form */}
      <form
        onSubmit={(e) => void handleCreate(e)}
        style={{
          border: '1.5px solid var(--line)',
          padding: '16px',
          display: 'grid',
          gap: 12,
        }}
      >
        <h2 style={{ fontSize: 12, margin: 0, color: 'var(--ink-dim)' }}>
          New Ledger
        </h2>
        <div style={{ display: 'grid', gap: 8 }}>
          <label style={{ fontSize: 13, color: 'var(--ink-dim)' }}>
            Name
            <input
              type="text"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="e.g. Camp Weekend 2026"
              required
              style={{
                display: 'block',
                width: '100%',
                marginTop: 4,
                padding: '8px 10px',
                background: 'var(--surface-2)',
                border: '1.5px solid var(--line)',
                color: 'var(--ink)',
                fontSize: 14,
              }}
            />
          </label>
          <label style={{ fontSize: 13, color: 'var(--ink-dim)' }}>
            Currency
            <select
              value={form.currency}
              onChange={(e) => setForm((f) => ({ ...f, currency: e.target.value }))}
              style={{
                display: 'block',
                width: '100%',
                marginTop: 4,
                padding: '8px 10px',
                background: 'var(--surface-2)',
                border: '1.5px solid var(--line)',
                color: 'var(--ink)',
                fontSize: 14,
              }}
            >
              {SUPPORTED_CURRENCIES.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </label>
        </div>
        {error && (
          <p style={{ color: 'var(--hot)', fontSize: 13, margin: 0 }}>{error}</p>
        )}
        <button
          type="submit"
          disabled={creating || !form.name.trim()}
          className="btn-brutal"
          style={{ justifySelf: 'start' }}
        >
          {creating ? 'Creating…' : 'Create Ledger'}
        </button>
      </form>

      {/* Ledger list */}
      {loading && (
        <p className="mono" style={{ color: 'var(--ink-dim)', fontSize: 13 }}>Loading…</p>
      )}
      {!loading && ledgers.length === 0 && (
        <p style={{ color: 'var(--ink-dim)', fontSize: 14 }}>
          No ledgers yet. Create one above to start tracking expenses.
        </p>
      )}
      {!loading && ledgers.length > 0 && (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 8 }}>
          {ledgers.map((l) => (
            <li
              key={l.id}
              style={{
                border: '1.5px solid var(--line)',
                padding: '12px 16px',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <div>
                <div style={{ fontWeight: 600 }}>{l.name}</div>
                <div style={{ fontSize: 11, color: 'var(--ink-dim)', marginTop: 2 }}>
                  {l.currency} · {l.scope_type}:{l.scope_id}
                </div>
              </div>
              <span className="chip" style={{ fontSize: 10 }}>
                {l.currency}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

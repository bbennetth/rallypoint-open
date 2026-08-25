import { useCallback, useEffect, useRef, useState } from 'react'
import { Banner, Button, Field, SubBar, SubBarSeg } from '@rallypoint/ui'
import { FOOD_SUBMISSION_STATUSES } from '@rallypoint/fitness-shared'
import {
  ApiError,
  approveFoodSubmission,
  listFoodSubmissions,
  rejectFoodSubmission,
  rescanFoodSubmission,
  type FoodSubmissionAdminDto,
  type FoodSubmissionStatus,
} from '../lib/api.js'
import { AiScanBadge } from '../ui/AiScanBadge.js'

// The food-submission review queue (AI nutrition-label UPC contributions).
// Lists submissions for the selected status (default pending) with
// per-row Approve / Reject-with-note actions, all rendered with
// @rallypoint/ui primitives — no app-local design system. Mirrors
// ReviewQueuePage.tsx 1:1, swapping exercise fields for food fields.

const STATUS_LABEL: Record<FoodSubmissionStatus, string> = {
  pending: 'Pending',
  approved: 'Approved',
  rejected: 'Rejected',
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString()
}

export function FoodReviewQueuePage() {
  const [status, setStatus] = useState<FoodSubmissionStatus>('pending')
  const [items, setItems] = useState<FoodSubmissionAdminDto[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // The row with a reject-note editor open, plus its draft note.
  const [rejectingId, setRejectingId] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [actingId, setActingId] = useState<string | null>(null)
  const generationRef = useRef(0)

  const load = useCallback(async (nextStatus: FoodSubmissionStatus) => {
    const generation = ++generationRef.current
    setLoading(true)
    setError(null)
    try {
      const rows = await listFoodSubmissions(nextStatus)
      if (generation !== generationRef.current) return
      setItems(rows)
    } catch (err) {
      if (generation !== generationRef.current) return
      setError(err instanceof Error ? err.message : 'Failed to load food submissions.')
    } finally {
      if (generation === generationRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load(status)
  }, [status, load])

  async function rescan(id: string) {
    setActingId(id)
    setError(null)
    try {
      await rescanFoodSubmission(id)
      await load(status)
    } catch (err) {
      // A 409 just means a scan is already running — refresh to show it.
      if (err instanceof ApiError && err.status === 409) await load(status)
      else setError(err instanceof Error ? err.message : 'Failed to re-scan food submission.')
    } finally {
      setActingId(null)
    }
  }

  async function act(id: string, kind: 'approve' | 'reject', withNote?: string) {
    setActingId(id)
    setError(null)
    try {
      if (kind === 'approve') await approveFoodSubmission(id, withNote)
      else await rejectFoodSubmission(id, withNote)
      setRejectingId(null)
      setNote('')
      await load(status)
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to ${kind} food submission.`)
    } finally {
      setActingId(null)
    }
  }

  return (
    <div className="page">
      <SubBar>
        {FOOD_SUBMISSION_STATUSES.map((s) => (
          <SubBarSeg key={s} active={s === status} onClick={() => setStatus(s)}>
            {STATUS_LABEL[s]}
          </SubBarSeg>
        ))}
      </SubBar>

      {error && <Banner tone="error">{error}</Banner>}

      {loading ? (
        <p className="muted">Loading…</p>
      ) : items.length === 0 ? (
        <p className="muted">No {STATUS_LABEL[status].toLowerCase()} food submissions.</p>
      ) : (
        <ul className="list" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {items.map((sub) => (
            <li
              key={sub.id}
              className="card"
              style={{ padding: '12px 16px', marginBottom: 12 }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                <div>
                  <strong>{sub.item.name}</strong>
                  <div className="muted" style={{ fontSize: 13 }}>
                    {sub.item.brand ?? 'No brand'} · UPC {sub.upc}
                  </div>
                  <div className="muted" style={{ fontSize: 13 }}>
                    Serving: {sub.item.servingQuantity} {sub.item.servingUnit} (
                    {sub.item.servingGrams}g){sub.item.isLiquid ? ' · liquid' : ''}
                  </div>
                  <div className="muted" style={{ fontSize: 13 }}>
                    Per 100g: {sub.item.per100g.kcal} kcal · {sub.item.per100g.protein}g protein ·{' '}
                    {sub.item.per100g.carbs}g carbs · {sub.item.per100g.fat}g fat
                  </div>
                  <div className="muted" style={{ fontSize: 13 }}>
                    Submitted by {sub.submitterUserId} on {formatDate(sub.createdAt)}
                  </div>
                  {sub.adminNote && (
                    <div className="muted" style={{ fontSize: 13 }}>
                      Admin note: {sub.adminNote}
                    </div>
                  )}
                  <AiScanBadge scan={sub.aiScan} />
                </div>

                {sub.status === 'pending' && (
                  <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                    <Button
                      variant="ghost"
                      onClick={() => void rescan(sub.id)}
                      disabled={actingId !== null}
                    >
                      Re-scan
                    </Button>
                    <Button
                      onClick={() => void act(sub.id, 'approve')}
                      disabled={actingId !== null}
                    >
                      Approve
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setRejectingId(rejectingId === sub.id ? null : sub.id)
                        setNote('')
                      }}
                      disabled={actingId !== null}
                    >
                      Reject…
                    </Button>
                  </div>
                )}
              </div>

              {rejectingId === sub.id && (
                <form
                  style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'flex-end' }}
                  onSubmit={(e) => {
                    e.preventDefault()
                    void act(sub.id, 'reject', note.trim() || undefined)
                  }}
                >
                  <div style={{ flex: 1 }}>
                    <Field
                      label="Rejection note (optional)"
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      placeholder="Why is this being rejected?"
                    />
                  </div>
                  <Button type="submit" disabled={actingId !== null}>
                    Reject
                  </Button>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Banner, Button, Field } from '@rallypoint/ui'
import {
  ApiError,
  approveLineupIngestion,
  getSystemEvent,
  ingestLineup,
  listLineupIngestions,
  rejectLineupIngestion,
  type LineupIngestionDto,
  type ProposalArtistInfoDto,
  type SystemEventDto,
} from '../lib/api.js'

// AI lineup ingestion review for one system-owned event: run an
// extraction from a festival page URL (or pasted page text), review the
// proposed create/update/delete diff, and approve it into the event's
// real lineup — or reject it. Mirrors FoodReviewQueuePage's
// load/act/generation-ref structure.

function formatWhen(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString()
}

// One-line catalog status per proposal row: known catalog artist, MB
// enrichment proposed (links/genre applied on approve), or brand-new.
function catalogCell(info: ProposalArtistInfoDto | undefined): string {
  if (info?.matched) return 'Known'
  if (info?.enrichment) {
    const e = info.enrichment
    const linkCount = Object.values(e.links).filter(Boolean).length
    const parts = [e.genre ?? null, linkCount > 0 ? `${linkCount} link${linkCount === 1 ? '' : 's'}` : null]
      .filter(Boolean)
      .join(', ')
    return `MB ${e.confidence}${parts ? ` (${parts})` : ''}`
  }
  return 'New'
}

function catalogTitle(info: ProposalArtistInfoDto | undefined): string | undefined {
  const links = info?.enrichment?.links ?? info?.matched?.links
  if (!links) return undefined
  const listed = Object.entries(links)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}: ${v}`)
  return listed.length > 0 ? listed.join('\n') : undefined
}

const STATUS_LABEL: Record<LineupIngestionDto['status'], string> = {
  pending: 'Pending review',
  approved: 'Approved',
  rejected: 'Rejected',
  superseded: 'Superseded',
  failed: 'Failed',
}

export function LineupIngestPage() {
  const { id: eventId = '' } = useParams()
  const [event, setEvent] = useState<SystemEventDto | null>(null)
  const [items, setItems] = useState<LineupIngestionDto[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [sourceUrl, setSourceUrl] = useState('')
  const [pastedText, setPastedText] = useState('')
  const [replace, setReplace] = useState(false)
  const [acting, setActing] = useState(false)
  const generationRef = useRef(0)

  const load = useCallback(async () => {
    const generation = ++generationRef.current
    setLoading(true)
    setError(null)
    try {
      const [ev, rows] = await Promise.all([
        getSystemEvent(eventId),
        listLineupIngestions(eventId),
      ])
      if (generation !== generationRef.current) return
      setEvent(ev)
      setItems(rows)
    } catch (err) {
      if (generation !== generationRef.current) return
      setError(err instanceof Error ? err.message : 'Failed to load lineup ingestions.')
    } finally {
      if (generation === generationRef.current) setLoading(false)
    }
  }, [eventId])

  useEffect(() => {
    void load()
  }, [load])

  async function runIngestion(e: React.FormEvent) {
    e.preventDefault()
    if (!sourceUrl.trim() && !pastedText.trim()) return
    setActing(true)
    setError(null)
    setNotice(null)
    try {
      await ingestLineup(eventId, {
        ...(pastedText.trim()
          ? { pasted_text: pastedText }
          : { source_url: sourceUrl.trim() }),
        replace,
      })
      setNotice('Extraction complete — review the proposal below.')
      setPastedText('')
      await load()
    } catch (err) {
      // A failed run still persists an audit row — refresh so it shows.
      setError(err instanceof Error ? err.message : 'Ingestion failed.')
      if (err instanceof ApiError) await load()
    } finally {
      setActing(false)
    }
  }

  async function decide(id: string, kind: 'approve' | 'reject') {
    setActing(true)
    setError(null)
    setNotice(null)
    try {
      if (kind === 'approve') {
        const res = await approveLineupIngestion(id)
        setNotice(
          `Applied: ${res.applied.upserted} slot${res.applied.upserted === 1 ? '' : 's'} upserted, ` +
            `${res.applied.deleted} removed, ${res.applied.artistsCreated} new artist${res.applied.artistsCreated === 1 ? '' : 's'} created` +
            `${res.applied.artistsEnriched > 0 ? `, ${res.applied.artistsEnriched} backfilled from MusicBrainz` : ''}.`,
        )
      } else {
        await rejectLineupIngestion(id)
        setNotice('Proposal rejected.')
      }
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to ${kind} the proposal.`)
    } finally {
      setActing(false)
    }
  }

  function proposalDetails(ing: LineupIngestionDto, reviewable: boolean) {
    const p = ing.proposal
    if (!p) {
      return ing.error ? <Banner tone="error">{ing.error}</Banner> : null
    }
    const { rows, deletes, errors, summary } = p.plan
    const infoByName = new Map((p.artists ?? []).map((a) => [a.name.toLowerCase(), a]))
    const catalogCounts =
      p.artists && p.artists.length > 0
        ? {
            known: p.artists.filter((a) => a.matched).length,
            enriched: p.artists.filter((a) => a.enrichment).length,
            unmatched: p.artists.filter((a) => !a.matched && !a.enrichment).length,
          }
        : null
    return (
      <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div className="muted" style={{ fontSize: 13 }}>
          {summary.create} new · {summary.update} updated · {summary.delete} removed ·{' '}
          {summary.error + p.warnings.length} warning{summary.error + p.warnings.length === 1 ? '' : 's'}
          {p.replace ? ' · replace mode' : ''}
          {p.truncated ? ' · source was truncated — the page may not be fully covered' : ''}
        </div>
        {catalogCounts && (
          <div className="muted" style={{ fontSize: 13 }}>
            Catalog: {catalogCounts.known} known · {catalogCounts.enriched} enriched via
            MusicBrainz · {catalogCounts.unmatched} unmatched
          </div>
        )}

        {rows.length > 0 && (
          <div style={{ overflowX: 'auto' }}>
            <table className="table" style={{ width: '100%', fontSize: 13 }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left' }}>Action</th>
                  <th style={{ textAlign: 'left' }}>Artist</th>
                  <th style={{ textAlign: 'left' }}>Day</th>
                  <th style={{ textAlign: 'left' }}>Stage</th>
                  <th style={{ textAlign: 'left' }}>Tier</th>
                  <th style={{ textAlign: 'left' }}>Set</th>
                  {catalogCounts && <th style={{ textAlign: 'left' }}>Catalog</th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={`${r.artistName}:${r.dayId}`}>
                    <td>{r.action === 'create' ? 'Add' : 'Update'}</td>
                    <td>
                      {r.artistName}
                      {r.displayName ? ` (as ${r.displayName})` : ''}
                    </td>
                    <td>{r.dayLabel}</td>
                    <td>{r.stageName ?? '—'}</td>
                    <td>{r.tier ?? '—'}</td>
                    <td>
                      {r.startTime ?? '—'}
                      {r.endTime ? `–${r.endTime}` : ''}
                    </td>
                    {catalogCounts && (
                      <td title={catalogTitle(infoByName.get(r.artistName.toLowerCase()))}>
                        {catalogCell(infoByName.get(r.artistName.toLowerCase()))}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {deletes.length > 0 && (
          <div className="muted" style={{ fontSize: 13 }}>
            Will remove: {deletes.map((d) => d.label).join(', ')}
          </div>
        )}

        {(errors.length > 0 || p.warnings.length > 0) && (
          <ul className="muted" style={{ fontSize: 13, margin: 0, paddingLeft: 18 }}>
            {errors.map((er, i) => (
              <li key={`e${i}`}>{er.message}</li>
            ))}
            {p.warnings.map((w, i) => (
              <li key={`w${i}`}>{w.message}</li>
            ))}
          </ul>
        )}

        {reviewable && (
          <div style={{ display: 'flex', gap: 8 }}>
            <Button
              onClick={() => void decide(ing.id, 'approve')}
              disabled={acting || (rows.length === 0 && deletes.length === 0)}
            >
              Approve &amp; apply
            </Button>
            <Button variant="ghost" onClick={() => void decide(ing.id, 'reject')} disabled={acting}>
              Reject
            </Button>
          </div>
        )}
      </div>
    )
  }

  const pending = items.filter((i) => i.status === 'pending')
  const history = items.filter((i) => i.status !== 'pending')

  return (
    <div className="page">
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0 }}>Lineup AI{event ? ` — ${event.name}` : ''}</h2>
        <Link to="/system-events" className="muted" style={{ fontSize: 13 }}>
          ← All system events
        </Link>
      </div>

      {error && <Banner tone="error">{error}</Banner>}
      {notice && <Banner tone="success">{notice}</Banner>}

      <div className="card" style={{ padding: '12px 16px', marginTop: 12 }}>
        <strong>Run an extraction</strong>
        <form
          onSubmit={runIngestion}
          style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 12 }}
        >
          <Field
            label="Lineup page URL"
            value={sourceUrl}
            onChange={(e) => setSourceUrl(e.target.value)}
            placeholder="https://www.crssdfest.com/artists/"
          />
          <label className="muted" style={{ fontSize: 13 }}>
            …or paste the page text/HTML (used instead of the URL when filled)
            <textarea
              value={pastedText}
              onChange={(e) => setPastedText(e.target.value)}
              rows={6}
              style={{ width: '100%', marginTop: 4, fontFamily: 'inherit' }}
              placeholder="Paste the artists page source here"
            />
          </label>
          <label className="muted" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={replace}
              onChange={(e) => setReplace(e.target.checked)}
            />
            Replace mode — remove current lineup slots missing from the extraction
          </label>
          <div>
            <Button type="submit" disabled={acting || (!sourceUrl.trim() && !pastedText.trim())}>
              {acting ? 'Working…' : 'Extract lineup'}
            </Button>
          </div>
        </form>
      </div>

      {loading ? (
        <p className="muted">Loading…</p>
      ) : (
        <>
          {pending.length === 0 && <p className="muted">No pending proposal.</p>}
          {pending.map((ing) => (
            <div key={ing.id} className="card" style={{ padding: '12px 16px', marginTop: 12 }}>
              <strong>Pending proposal</strong>
              <div className="muted" style={{ fontSize: 13 }}>
                {ing.source_kind === 'url' ? (ing.source_url ?? 'URL') : 'Pasted text'} ·{' '}
                {formatWhen(ing.created_at)} · {ing.model}
              </div>
              {proposalDetails(ing, true)}
            </div>
          ))}

          {history.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <strong>History</strong>
              <ul className="list" style={{ listStyle: 'none', padding: 0, margin: 0, marginTop: 8 }}>
                {history.map((ing) => (
                  <li key={ing.id} className="card" style={{ padding: '10px 16px', marginBottom: 8 }}>
                    <div className="muted" style={{ fontSize: 13 }}>
                      {STATUS_LABEL[ing.status]} · {formatWhen(ing.created_at)} ·{' '}
                      {ing.source_kind === 'url' ? (ing.source_url ?? 'URL') : 'pasted text'}
                      {ing.reviewed_by ? ` · decided by ${ing.reviewed_by}` : ''}
                    </div>
                    {ing.error && (
                      <div className="muted" style={{ fontSize: 13 }}>
                        {ing.error}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  )
}

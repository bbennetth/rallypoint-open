import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import { useAsyncTask } from '@rallypoint/web-kit'
import { Banner, Button, SubBar, SubBarSeg } from '@rallypoint/ui'
import {
  ApiError,
  applyArtistMbReview,
  bulkDecideArtistMbReviews,
  dismissArtistMbReview,
  listArtistMbReviews,
  listArtists,
  patchArtist,
  runArtistMbReview,
  runArtistMbSweepBatch,
  type AdminUpdateArtistInput,
  type ArtistAdminDto,
  type ArtistBulkMbReviewAction,
  type ArtistMbReviewDto,
} from '../lib/api.js'

// MusicBrainz enrichment reviews for the global artists catalog. "Run MB
// sweep" walks the qualifying catalog (artists missing genre/links; a
// pinned MBID just skips name matching) in cursor-paged batches — each artist
// costs 1–2 throttled MusicBrainz calls, no AI anywhere. Proposals are
// null-fill-only diffs rendered with Apply/Dismiss (single + bulk),
// mirroring the exercise AI-review pipeline's decision surface.

// Mirrors the server's per-request cap on POST /artist-mb-reviews/bulk.
const BULK_DECIDE_MAX_IDS = 200

const FIELD_LABELS: Record<string, string> = {
  genre: 'Genre',
  soundcloud: 'SoundCloud',
  spotify: 'Spotify',
  appleMusic: 'Apple Music',
  youtubeMusic: 'YouTube Music',
  instagram: 'Instagram',
}

const LINK_FIELDS = ['soundcloud', 'spotify', 'appleMusic', 'youtubeMusic', 'instagram'] as const
const LINK_ABBR: Record<(typeof LINK_FIELDS)[number], string> = {
  soundcloud: 'SC',
  spotify: 'SP',
  appleMusic: 'AM',
  youtubeMusic: 'YM',
  instagram: 'IG',
}

// --- inline artist editor --------------------------------------------

function ArtistEditor({
  artist,
  onSaved,
  onCancel,
}: {
  artist: ArtistAdminDto
  onSaved: (updated: ArtistAdminDto) => void
  onCancel: () => void
}) {
  const [form, setForm] = useState({
    name: artist.name,
    genre: artist.genre ?? '',
    soundcloud: artist.soundcloud ?? '',
    spotify: artist.spotify ?? '',
    appleMusic: artist.appleMusic ?? '',
    youtubeMusic: artist.youtubeMusic ?? '',
    instagram: artist.instagram ?? '',
    mbid: artist.mbid ?? '',
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function set<K extends keyof typeof form>(key: K, value: string) {
    setForm((cur) => ({ ...cur, [key]: value }))
  }

  async function save() {
    setSaving(true)
    setError(null)
    // Blank inputs clear the field (null); name may not blank out.
    const patch: AdminUpdateArtistInput = {
      name: form.name.trim(),
      genre: form.genre.trim() || null,
      soundcloud: form.soundcloud.trim() || null,
      spotify: form.spotify.trim() || null,
      appleMusic: form.appleMusic.trim() || null,
      youtubeMusic: form.youtubeMusic.trim() || null,
      instagram: form.instagram.trim() || null,
      mbid: form.mbid.trim() || null,
    }
    try {
      onSaved(await patchArtist(artist.id, patch))
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setError('An artist with that name already exists.')
      } else {
        setError(err instanceof Error ? err.message : 'Failed to save artist.')
      }
    } finally {
      setSaving(false)
    }
  }

  const fieldStyle = { display: 'grid', gap: 2, fontSize: 12 } as const
  const labeled = (label: string, key: keyof typeof form, placeholder = '') => (
    <label style={fieldStyle}>
      <span className="muted">{label}</span>
      <input
        value={form[key]}
        onChange={(e) => set(key, e.target.value)}
        placeholder={placeholder}
        aria-label={label}
      />
    </label>
  )

  return (
    <div style={{ display: 'grid', gap: 10, padding: '10px 0' }}>
      {error && <Banner tone="error">{error}</Banner>}
      <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
        {labeled('Name', 'name')}
        {labeled('Genre', 'genre')}
        {labeled('MusicBrainz ID', 'mbid')}
        {labeled('SoundCloud', 'soundcloud', 'https://soundcloud.com/…')}
        {labeled('Spotify', 'spotify', 'https://open.spotify.com/artist/…')}
        {labeled('Apple Music', 'appleMusic', 'https://music.apple.com/…')}
        {labeled('YouTube Music', 'youtubeMusic', 'https://music.youtube.com/…')}
        {labeled('Instagram', 'instagram', 'https://instagram.com/…')}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <Button onClick={() => void save()} disabled={saving || !form.name.trim()}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
      </div>
    </div>
  )
}

function ReviewRow({
  review,
  acting,
  selected,
  onToggleSelect,
  onApply,
  onDismiss,
}: {
  review: ArtistMbReviewDto
  acting: boolean
  selected: boolean
  onToggleSelect: () => void
  onApply: () => void
  onDismiss: () => void
}) {
  const fills = Object.entries(review.proposedFields).filter(([, v]) => v)
  const pinsMbid = review.currentFields.mbid === null
  return (
    <li className="card" style={{ padding: '12px 16px', marginBottom: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
          {review.status === 'pending' && (
            <input
              type="checkbox"
              checked={selected}
              onChange={onToggleSelect}
              disabled={acting}
              aria-label={`Select proposal for ${review.artistName}`}
              style={{ marginTop: 4 }}
            />
          )}
          <div>
            <strong>{review.artistName}</strong>{' '}
            <span className="muted" style={{ fontSize: 12 }}>
              {review.matchKind === 'stored' ? 'pinned MBID' : 'auto-matched'} ·{' '}
              <a
                href={`https://musicbrainz.org/artist/${encodeURIComponent(review.mbid)}`}
                target="_blank"
                rel="noreferrer"
              >
                MusicBrainz ↗
              </a>
            </span>
            {fills.length === 0 ? (
              <div className="muted" style={{ fontSize: 13 }}>
                No new fields — applying only pins the MusicBrainz ID.
              </div>
            ) : (
              fills.map(([field, value]) => (
                <div key={field} style={{ fontSize: 13 }}>
                  {FIELD_LABELS[field] ?? field}:{' '}
                  <span className="muted">
                    {review.currentFields[field as keyof typeof review.currentFields] ?? '—'}
                  </span>{' '}
                  → {value}
                </div>
              ))
            )}
            {pinsMbid && fills.length > 0 && (
              <div className="muted" style={{ fontSize: 12 }}>
                Also pins the MusicBrainz ID for future sweeps.
              </div>
            )}
          </div>
        </div>
        {review.status === 'pending' && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <Button onClick={onApply} disabled={acting}>
              Apply
            </Button>
            <Button variant="ghost" onClick={onDismiss} disabled={acting}>
              Dismiss
            </Button>
          </div>
        )}
      </div>
    </li>
  )
}

export function ArtistCatalogPage() {
  const [tab, setTab] = useState<'artists' | 'proposals'>('artists')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  // Artists-table state
  const [artists, setArtists] = useState<ArtistAdminDto[]>([])
  const [artistsLoading, setArtistsLoading] = useState(true)
  const [artistsCursor, setArtistsCursor] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [q, setQ] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [mbCheckingId, setMbCheckingId] = useState<string | null>(null)
  const generationRef = useRef(0)

  const [reviews, setReviews] = useState<ArtistMbReviewDto[]>([])
  const [actingIds, setActingIds] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulkActing, setBulkActing] = useState<ArtistBulkMbReviewAction | null>(null)
  // Mirrors bulkActing for loadReviews, which must not capture it as a
  // dependency (that would re-fire the load effect on every bulk op).
  const bulkActingRef = useRef(false)

  const [sweeping, setSweeping] = useState(false)
  const sweepAbort = useRef(false)
  const [sweepProgress, setSweepProgress] = useState<string | null>(null)

  const runReviews = useAsyncTask()
  const loadReviews = useCallback(async () => {
    if (bulkActingRef.current) return
    setError(null)
    await runReviews(async (ctx) => {
      try {
        const rows = await listArtistMbReviews('pending')
        if (ctx.stale() || bulkActingRef.current) return
        setReviews(rows)
        // A fresh fetch invalidates any selection made against the old list.
        setSelected(new Set())
      } catch (err) {
        if (ctx.stale()) return
        setError(err instanceof Error ? err.message : 'Failed to load MB proposals.')
      }
    })
  }, [runReviews])

  const loadArtists = useCallback(async () => {
    const generation = ++generationRef.current
    setArtistsLoading(true)
    setError(null)
    try {
      const page = await listArtists({ ...(q.trim() ? { q: q.trim() } : {}) })
      if (generation !== generationRef.current) return
      setArtists(page.items)
      setArtistsCursor(page.nextCursor)
    } catch (err) {
      if (generation !== generationRef.current) return
      setError(err instanceof Error ? err.message : 'Failed to load artists.')
    } finally {
      if (generation === generationRef.current) setArtistsLoading(false)
    }
  }, [q])

  async function loadMoreArtists() {
    // loadingMore re-check guards a double-fire beyond the button's
    // disabled state (e.g. double-click before the re-render).
    if (!artistsCursor || loadingMore) return
    const generation = generationRef.current
    setLoadingMore(true)
    try {
      const page = await listArtists({
        ...(q.trim() ? { q: q.trim() } : {}),
        cursor: artistsCursor,
      })
      if (generation !== generationRef.current) return
      setArtists((cur) => [...cur, ...page.items])
      setArtistsCursor(page.nextCursor)
    } catch (err) {
      if (generation === generationRef.current) {
        setError(err instanceof Error ? err.message : 'Failed to load more artists.')
      }
    } finally {
      if (generation === generationRef.current) setLoadingMore(false)
    }
  }

  async function checkMb(artist: ArtistAdminDto) {
    setMbCheckingId(artist.id)
    setError(null)
    setNotice(null)
    try {
      const res = await runArtistMbReview(artist.id)
      if (res.outcome === 'proposed') {
        setNotice(`Proposal created for ${artist.name} — see the MB proposals tab.`)
        await loadReviews()
      } else if (res.outcome === 'unchanged') {
        setNotice(`MusicBrainz has nothing new for ${artist.name}.`)
      } else if (res.outcome === 'already_pending') {
        setNotice(`A proposal for ${artist.name} is already pending.`)
      } else if (res.outcome === 'ambiguous') {
        setNotice(`MusicBrainz match for ${artist.name} is ambiguous — skipped.`)
      } else if (res.outcome === 'no_candidates') {
        setNotice(`No MusicBrainz candidates for ${artist.name}.`)
      } else {
        setNotice('MusicBrainz is unavailable — try again shortly.')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'MusicBrainz check failed.')
    } finally {
      setMbCheckingId(null)
    }
  }

  // Two effects so a search keystroke (which re-keys loadArtists on q)
  // doesn't also re-fetch the proposals list.
  useEffect(() => {
    void loadReviews()
  }, [loadReviews])
  useEffect(() => {
    if (tab === 'artists') void loadArtists()
  }, [tab, loadArtists])

  async function sweep() {
    setSweeping(true)
    sweepAbort.current = false
    setError(null)
    setNotice(null)
    let cursor: string | null = null
    let proposed = 0
    let processed = 0
    let skipped = 0
    try {
      // Cursor-paged batches keep each Worker call inside MusicBrainz's
      // ~1 req/s budget; loop until the qualifying catalog is exhausted
      // or the admin cancels.
      do {
        const res = await runArtistMbSweepBatch(cursor, 5)
        processed += res.processed
        proposed += res.proposed
        skipped += res.skipped
        cursor = res.nextCursor
        setSweepProgress(
          `${processed} checked, ${proposed} proposals, ${skipped} skipped so far…`,
        )
      } while (cursor && !sweepAbort.current)
      setNotice(
        `${sweepAbort.current ? 'Sweep stopped' : 'Sweep complete'}: ${processed} checked, ` +
          `${proposed} proposals, ${skipped} skipped (no/ambiguous MB match).`,
      )
      await loadReviews()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'MB sweep failed.')
    } finally {
      setSweeping(false)
      setSweepProgress(null)
    }
  }

  const proposalsBusy = bulkActing !== null || actingIds.size > 0
  const allSelected = reviews.length > 0 && reviews.every((r) => selected.has(r.id))
  const someSelected = selected.size > 0 && !allSelected

  // Deciding one proposal removes just that row locally — no refetch, so
  // the rest of a long post-sweep queue keeps its scroll position.
  async function decide(review: ArtistMbReviewDto, kind: ArtistBulkMbReviewAction) {
    setActingIds((cur) => new Set(cur).add(review.id))
    setError(null)
    setNotice(null)
    let remove = false
    try {
      if (kind === 'apply') await applyArtistMbReview(review.id)
      else await dismissArtistMbReview(review.id)
      remove = true
    } catch (err) {
      // 409/404 are terminal: the proposal was decided elsewhere (or
      // deleted), so the row leaves the list rather than sitting stuck.
      if (err instanceof ApiError && (err.status === 409 || err.status === 404)) {
        remove = true
        setNotice('That proposal had already been decided elsewhere and left the list.')
      } else {
        setError(err instanceof Error ? err.message : `Failed to ${kind} the proposal.`)
      }
    } finally {
      if (remove) {
        setReviews((cur) => cur.filter((r) => r.id !== review.id))
        setSelected((cur) => {
          if (!cur.has(review.id)) return cur
          const next = new Set(cur)
          next.delete(review.id)
          return next
        })
      }
      setActingIds((cur) => {
        const next = new Set(cur)
        next.delete(review.id)
        return next
      })
    }
  }

  function toggleSelect(id: string) {
    setSelected((cur) => {
      const next = new Set(cur)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function bulkDecide(action: ArtistBulkMbReviewAction) {
    const ids = [...selected]
    setBulkActing(action)
    bulkActingRef.current = true
    setError(null)
    setNotice(null)
    let succeededCount = 0
    let staleCount = 0
    const verb = action === 'apply' ? 'applied' : 'dismissed'
    try {
      // The route caps a batch at 200 ids; a post-sweep select-all can
      // exceed that, so chunk client-side and aggregate the outcomes.
      for (let i = 0; i < ids.length; i += BULK_DECIDE_MAX_IDS) {
        const res = await bulkDecideArtistMbReviews(ids.slice(i, i + BULK_DECIDE_MAX_IDS), action)
        const decided = new Set(res.items.map((item) => item.id))
        succeededCount += res.applied + res.dismissed
        staleCount += res.failed
        setReviews((cur) => cur.filter((r) => !decided.has(r.id)))
        setSelected((cur) => {
          const next = new Set(cur)
          for (const id of decided) next.delete(id)
          return next
        })
      }
      if (staleCount > 0) {
        setNotice(
          `${succeededCount} proposal${succeededCount === 1 ? '' : 's'} ${verb}; ` +
            `${staleCount} had already been decided elsewhere and left the list.`,
        )
      } else {
        setNotice(`${succeededCount} proposal${succeededCount === 1 ? '' : 's'} ${verb}.`)
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : `Bulk ${action} failed.`
      const progress =
        succeededCount > 0 || staleCount > 0
          ? ` ${succeededCount} ${verb} before the failure; the remaining rows are still selected — retry to continue.`
          : ''
      setError(`${reason}${progress}`)
    } finally {
      bulkActingRef.current = false
      setBulkActing(null)
    }
  }

  const linkCell = (a: ArtistAdminDto) => {
    const present = LINK_FIELDS.filter((f) => a[f])
    if (present.length === 0) return <span className="muted">—</span>
    return (
      <span style={{ display: 'inline-flex', gap: 6 }}>
        {present.map((f) => (
          <a key={f} href={a[f]!} target="_blank" rel="noreferrer" title={a[f]!}>
            {LINK_ABBR[f]}
          </a>
        ))}
      </span>
    )
  }

  const cellStyle = { padding: '6px 10px', textAlign: 'left' as const, whiteSpace: 'nowrap' as const }

  return (
    <div className="page">
      <SubBar>
        <SubBarSeg active={tab === 'artists'} onClick={() => setTab('artists')}>
          Artists
        </SubBarSeg>
        <SubBarSeg active={tab === 'proposals'} onClick={() => setTab('proposals')}>
          MB proposals{reviews.length > 0 ? ` (${reviews.length})` : ''}
        </SubBarSeg>
      </SubBar>

      {error && <Banner tone="error">{error}</Banner>}
      {notice && <Banner tone="info">{notice}</Banner>}

      {tab === 'artists' ? (
        <>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '12px 0', flexWrap: 'wrap' }}>
            <input
              type="search"
              placeholder="Search artists…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              aria-label="Search artists"
            />
            <Button variant="ghost" onClick={() => void sweep()} disabled={sweeping}>
              {sweeping ? 'Sweeping…' : 'Run MB sweep'}
            </Button>
            {sweeping && (
              <Button
                variant="ghost"
                onClick={() => {
                  sweepAbort.current = true
                }}
              >
                Stop
              </Button>
            )}
          </div>
          {sweepProgress && <p className="muted">{sweepProgress}</p>}

          {artistsLoading ? (
            <p className="muted">Loading…</p>
          ) : artists.length === 0 ? (
            <p className="muted">No artists match.</p>
          ) : (
            <>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 13 }}>
                  <thead>
                    <tr className="muted">
                      <th style={cellStyle}>Name</th>
                      <th style={cellStyle}>Genre</th>
                      <th style={cellStyle}>Links</th>
                      <th style={cellStyle}>MusicBrainz</th>
                      <th style={cellStyle} aria-label="Actions" />
                    </tr>
                  </thead>
                  <tbody>
                    {artists.map((a) => (
                      <Fragment key={a.id}>
                        <tr style={{ borderTop: '1px solid var(--edge, #333)' }}>
                          <td style={cellStyle}>
                            <strong>{a.name}</strong>
                          </td>
                          <td style={cellStyle}>
                            {a.genre ?? <span className="muted">—</span>}
                          </td>
                          <td style={cellStyle}>{linkCell(a)}</td>
                          <td style={cellStyle}>
                            {a.mbid ? (
                              <a
                                href={`https://musicbrainz.org/artist/${encodeURIComponent(a.mbid)}`}
                                target="_blank"
                                rel="noreferrer"
                                title={a.mbid}
                              >
                                {a.mbid.slice(0, 8)}…
                              </a>
                            ) : (
                              <span className="muted">—</span>
                            )}
                          </td>
                          <td style={cellStyle}>
                            <span style={{ display: 'inline-flex', gap: 6 }}>
                              <Button
                                variant="ghost"
                                onClick={() => setEditingId(editingId === a.id ? null : a.id)}
                              >
                                {editingId === a.id ? 'Close' : 'Edit'}
                              </Button>
                              <Button
                                variant="ghost"
                                onClick={() => void checkMb(a)}
                                disabled={mbCheckingId !== null || sweeping}
                              >
                                {mbCheckingId === a.id ? 'Checking…' : 'Check MB'}
                              </Button>
                            </span>
                          </td>
                        </tr>
                        {editingId === a.id && (
                          <tr>
                            <td colSpan={5} style={{ padding: '0 10px' }}>
                              <ArtistEditor
                                artist={a}
                                onSaved={(updated) => {
                                  setEditingId(null)
                                  setArtists((cur) =>
                                    cur.map((row) => (row.id === updated.id ? updated : row)),
                                  )
                                }}
                                onCancel={() => setEditingId(null)}
                              />
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
              {artistsCursor && (
                <div style={{ margin: '12px 0' }}>
                  <Button variant="ghost" onClick={() => void loadMoreArtists()} disabled={loadingMore}>
                    {loadingMore ? 'Loading…' : 'Load more'}
                  </Button>
                </div>
              )}
            </>
          )}
        </>
      ) : reviews.length === 0 ? (
        <p className="muted" style={{ marginTop: 12 }}>
          No pending MusicBrainz proposals. Run a sweep to check the catalog.
        </p>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', margin: '12px 0', flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
              <input
                type="checkbox"
                checked={allSelected}
                ref={(el) => {
                  if (el) el.indeterminate = someSelected
                }}
                onChange={() =>
                  setSelected(allSelected ? new Set() : new Set(reviews.map((r) => r.id)))
                }
                disabled={proposalsBusy}
                aria-label="Select all proposals"
              />
              Select all
            </label>
            {selected.size > 0 && (
              <>
                <span className="muted" style={{ fontSize: 13 }}>
                  {selected.size} selected
                </span>
                <Button className="fit" onClick={() => void bulkDecide('apply')} disabled={proposalsBusy}>
                  {bulkActing === 'apply' ? 'Applying…' : `Apply selected (${selected.size})`}
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => void bulkDecide('dismiss')}
                  disabled={proposalsBusy}
                >
                  {bulkActing === 'dismiss' ? 'Dismissing…' : `Dismiss selected (${selected.size})`}
                </Button>
              </>
            )}
          </div>
          <ul className="list" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {reviews.map((r) => (
              <ReviewRow
                key={r.id}
                review={r}
                acting={actingIds.has(r.id) || bulkActing !== null}
                selected={selected.has(r.id)}
                onToggleSelect={() => toggleSelect(r.id)}
                onApply={() => void decide(r, 'apply')}
                onDismiss={() => void decide(r, 'dismiss')}
              />
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

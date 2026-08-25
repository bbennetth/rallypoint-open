// Manual-add search sheet for the food logger (issue #713). The user
// types a food name; we search our own cache first and Open Food Facts
// on a thin local result, writing external hits back to the cache. A
// tapped result hands the FoodItemDto to the parent, which opens the
// confirm sheet exactly as the barcode path does. An escape hatch drops
// to the blank manual form. Nothing here logs a diary row.

import { useEffect, useRef, useState } from 'react'
import { Banner, Button, Drawer, EmptyState, Field } from '@rallypoint/ui'
import { captureException } from '@rallypoint/web-kit'
import { FOOD_SEARCH_MIN_QUERY } from '@rallypoint/fitness-shared'
import type { FoodFavoriteDto, FoodItemDto } from '@rallypoint/fitness-shared'
import { ApiError, lookupFoodBarcode, searchFood } from '../lib/api.js'
import { formatQuantity, needsServingLookup } from '../lib/food-view.js'

export interface FoodSearchSheetProps {
  onClose: () => void
  // The user picked a cached/searched item — parent opens the confirm sheet.
  onPick: (item: FoodItemDto) => void
  // "Enter it by hand instead" — parent opens the blank manual form.
  onManual: (name: string) => void
  // Pinned quick-log templates shown before the user types. Unlike a
  // search result, tapping one LOGS it — it already carries the quantity
  // the confirm sheet would otherwise ask for.
  favorites?: FoodFavoriteDto[]
  onLogFavorite?: (fav: FoodFavoriteDto) => void
}

const DEBOUNCE_MS = 400

export function FoodSearchSheet({
  onClose,
  onPick,
  onManual,
  favorites = [],
  onLogFavorite,
}: FoodSearchSheetProps) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<FoodItemDto[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [searched, setSearched] = useState(false)
  // Monotonic id: only the newest in-flight search may commit results,
  // so a slow early keystroke can't clobber a faster later one.
  const reqId = useRef(0)
  // The picked item currently being resolved through the barcode lookup
  // (serving-size enrichment) — disables the result rows meanwhile.
  const [picking, setPicking] = useState<string | null>(null)

  async function handlePick(item: FoodItemDto) {
    // Search results (Search-a-licious) carry no serving size; resolve
    // UPC-backed picks through the barcode lookup so the confirm sheet
    // can open at "1 serving". Falls back to the plain item on any miss.
    if (!needsServingLookup(item)) {
      onPick(item)
      return
    }
    setPicking(item.id)
    try {
      const res = await lookupFoodBarcode(item.upc!, { silent: true })
      onPick(res.item ?? item)
    } catch {
      onPick(item)
    } finally {
      setPicking(null)
    }
  }

  useEffect(() => {
    const q = query.trim()
    if (q.length < FOOD_SEARCH_MIN_QUERY) {
      reqId.current += 1 // cancel any in-flight commit
      setResults([])
      setLoading(false)
      setError(null)
      setSearched(false)
      return
    }
    setLoading(true)
    const mine = ++reqId.current
    const t = setTimeout(async () => {
      try {
        const res = await searchFood(q)
        if (mine !== reqId.current) return
        setResults(res.items)
        setSearched(true)
        setError(null)
      } catch (err: unknown) {
        if (mine !== reqId.current) return
        captureException(err, { feature: 'food-search' })
        setError(err instanceof ApiError ? err.message : 'Search failed — try again.')
      } finally {
        if (mine === reqId.current) setLoading(false)
      }
    }, DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [query])

  const showEmpty = searched && !loading && results.length === 0 && !error
  // Pins stand in for results until the query is long enough to run one,
  // so the sheet opens on something actionable instead of a bare field.
  const showFavorites =
    onLogFavorite !== undefined &&
    favorites.length > 0 &&
    query.trim().length < FOOD_SEARCH_MIN_QUERY

  return (
    <Drawer open mobileSheet title="Add food" onClose={onClose}>
      <div style={{ display: 'grid', gap: 14 }}>
        {error && <Banner tone="error">{error}</Banner>}

        <Field
          label="Search by name"
          placeholder="e.g. peanut butter"
          value={query}
          autoFocus
          onChange={(e) => setQuery(e.target.value)}
        />

        {loading && <div style={{ color: 'var(--ink-dim)' }}>Searching…</div>}

        {showFavorites && (
          <div style={{ display: 'grid', gap: 8 }}>
            <div className="sec-rule">
              <div className="eyebrow">PINNED · TAP TO LOG</div>
              <div className="line" />
            </div>
            {favorites.map((f) => (
              <Button
                key={f.id}
                variant="ghost"
                style={{ width: '100%', textAlign: 'left', justifyContent: 'space-between' }}
                onClick={() => onLogFavorite?.(f)}
              >
                <span style={{ display: 'grid', gap: 4 }}>
                  <span>{f.name}</span>
                  <span className="meta">
                    {formatQuantity(f) !== null ? `${formatQuantity(f)} · ` : ''}
                    {Math.round(f.kcal)} kcal · P {f.proteinG} · C {f.carbsG} · F {f.fatG}
                  </span>
                </span>
              </Button>
            ))}
          </div>
        )}

        {showEmpty && (
          <EmptyState
            compact
            title="No matches"
            body={<>Nothing found for “{query.trim()}”. Enter it by hand instead.</>}
          />
        )}

        {results.length > 0 && (
          <div style={{ display: 'grid', gap: 8 }}>
            <div className="sec-rule">
              <div className="eyebrow">RESULTS · TAP TO REVIEW &amp; LOG</div>
              <div className="line" />
            </div>
            {results.map((item) => (
              <Button
                key={item.id}
                variant="ghost"
                style={{ width: '100%', textAlign: 'left', justifyContent: 'space-between' }}
                onClick={() => void handlePick(item)}
                disabled={picking !== null}
                loading={picking === item.id}
              >
                <span style={{ display: 'grid', gap: 4 }}>
                  <span>{item.name}</span>
                  <span className="meta">
                    {item.brand ? `${item.brand} · ` : ''}
                    {Math.round(item.per100g.kcal)} kcal/100{item.isLiquid ? 'ml' : 'g'} · P{' '}
                    {item.per100g.proteinG} · C {item.per100g.carbsG} · F {item.per100g.fatG}
                  </span>
                </span>
                {item.source === 'manual' ? <span className="chip">Custom</span> : null}
              </Button>
            ))}
          </div>
        )}

        <Button variant="ghost" onClick={() => onManual(query.trim())}>
          {query.trim() ? `Enter “${query.trim()}” by hand` : 'Enter it by hand instead'}
        </Button>
      </div>
    </Drawer>
  )
}

// Mixed-drink logger (issue #713). Pick a spirit, a mixer (a built-in, a
// specific product via search, or neat) and a volume, then a pour
// strength (single / double / gay = 1 / 2 / 3 shots). A live preview
// shows the calories; "Log drink" writes a single food_log_entries row
// with source 'drink'. An optional photo prefills the spirit + mixer via
// the drink vision pass. All calorie math is the pure alcohol module.

import { useEffect, useMemo, useRef, useState } from 'react'
import { Banner, Drawer, Icon, useFilePicker } from '@rallypoint/ui'
import { captureException } from '@rallypoint/web-kit'
import {
  MIXERS_BUILTIN,
  POUR_STRENGTHS,
  SPIRITS,
  computeMixedDrink,
  matchMixerGuess,
  matchSpiritGuess,
  mixerFromFoodItem,
  type Mixer,
  type PourStrengthId,
} from '@rallypoint/fitness-shared'
import { ApiError, createFoodLogEntry, scanDrinkPhoto, searchFood } from '../lib/api.js'

export interface DrinkSheetProps {
  // The diary instant for the day being viewed (parent computes it).
  loggedAt: Date
  onClose: () => void
  onLogged: () => void
}

const labelStyle = {
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: 'var(--ink-mute)',
} as const

export function DrinkSheet({ loggedAt, onClose, onLogged }: DrinkSheetProps) {
  const [spiritId, setSpiritId] = useState(SPIRITS[0]!.id)
  const [mixer, setMixer] = useState<Mixer>(MIXERS_BUILTIN[0]!) // neat by default
  const [mixerMl, setMixerMl] = useState(150)
  const [strengthId, setStrengthId] = useState<PourStrengthId>('single')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  // Mixer search (a specific product → custom mixer).
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Mixer[]>([])
  const searchReq = useRef(0)

  const photoPicker = useFilePicker({
    onPick: (file) => void handlePhoto(file),
    ariaLabel: 'Snap or upload the drink',
  })

  const spirit = SPIRITS.find((s) => s.id === spiritId)!
  const strength = POUR_STRENGTHS.find((p) => p.id === strengthId)!
  const isNeat = mixer.id === 'none'

  const preview = useMemo(
    () => computeMixedDrink({ spirit, strength, mixer, mixerMl }),
    [spirit, strength, mixer, mixerMl],
  )

  // Debounced mixer search — mirrors FoodSearchSheet so we don't fire a
  // /food/search per keystroke and burn the shared off:search budget.
  // Only LIQUID hits become mixers: a solid product's per-100g macros
  // would be silently misread as per-100ml volume.
  useEffect(() => {
    const q = query.trim()
    if (q.length < 2) {
      searchReq.current += 1
      setResults([])
      return
    }
    const mine = ++searchReq.current
    const t = setTimeout(async () => {
      try {
        const res = await searchFood(q)
        if (mine !== searchReq.current) return
        setResults(res.items.filter((i) => i.isLiquid).map(mixerFromFoodItem))
      } catch (err: unknown) {
        if (mine !== searchReq.current) return
        captureException(err, { feature: 'drink-mixer-search' })
      }
    }, 400)
    return () => clearTimeout(t)
  }, [query])

  async function handlePhoto(f: File) {
    setNotice('Reading the drink…')
    setError(null)
    try {
      const guess = await scanDrinkPhoto(f)
      const s = matchSpiritGuess(guess.spirit)
      const m = matchMixerGuess(guess.mixer)
      if (s) setSpiritId(s.id)
      if (m) setMixer(m)
      setNotice(
        s || m
          ? `Prefilled from the photo (${guess.confidence} confidence) — check it before logging.`
          : "Couldn't identify the drink — pick it below.",
      )
    } catch (err: unknown) {
      // Carry the transport/server code (network_error / timeout /
      // ai_capacity / scan_failed) onto the $exception so PostHog shows a
      // real failure instead of an opaque "Load failed". feature/scan_step
      // mirror the server capture (routes/food.ts, ?mode=drink) so the two
      // $exception events join in error tracking.
      captureException(err, {
        feature: 'food-scan',
        scan_step: 'drink-scan',
        ...(err instanceof ApiError ? { error_code: err.code, http_status: err.status } : {}),
      })
      setError(err instanceof ApiError ? err.message : 'Could not read that photo.')
      setNotice(null)
    }
  }

  async function handleLog() {
    setSaving(true)
    setError(null)
    const note =
      `${strength.label} pour · ${preview.shots} shot${preview.shots > 1 ? 's' : ''} ${spirit.name}` +
      (isNeat ? ' (neat)' : ` + ${mixerMl} ml ${mixer.name}`) +
      ` · ${preview.alcoholG} g alcohol`
    try {
      await createFoodLogEntry({
        loggedAt: loggedAt.toISOString(),
        name: preview.name,
        kcal: preview.kcal,
        proteinG: 0,
        carbsG: preview.carbsG,
        fatG: 0,
        source: 'drink',
        note,
      })
      onLogged()
      onClose()
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : 'Could not log the drink.')
      setSaving(false)
    }
  }

  return (
    <Drawer open mobileSheet title="Add a drink" onClose={onClose}>
      <div style={{ display: 'grid', gap: 16 }}>
        {error && <Banner tone="error">{error}</Banner>}
        {notice && <Banner tone="info">{notice}</Banner>}

        <button type="button" className="fit-startbtn ghost" onClick={photoPicker.open}>
          Snap or upload the drink to prefill
        </button>

        <div style={{ display: 'grid', gap: 6 }}>
          <span style={labelStyle}>Spirit</span>
          <div className="btn-row" style={{ flexWrap: 'wrap' }}>
            {SPIRITS.map((s) => (
              <button
                key={s.id}
                type="button"
                className={`fit-startbtn${s.id === spiritId ? '' : ' ghost'}`}
                onClick={() => setSpiritId(s.id)}
              >
                {s.name}
              </button>
            ))}
          </div>
        </div>

        <div style={{ display: 'grid', gap: 6 }}>
          <span style={labelStyle}>Mixer</span>
          <div className="btn-row" style={{ flexWrap: 'wrap' }}>
            {MIXERS_BUILTIN.map((m) => (
              <button
                key={m.id}
                type="button"
                className={`fit-startbtn${m.id === mixer.id ? '' : ' ghost'}`}
                onClick={() => setMixer(m)}
              >
                {m.name}
              </button>
            ))}
          </div>
          <input
            className="pl-input"
            placeholder="…or search a specific drink (e.g. Diet Coke)"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {results.length > 0 && (
            <div style={{ display: 'grid', gap: 4 }}>
              {results.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  className={`fit-startbtn${m.id === mixer.id ? '' : ' ghost'}`}
                  style={{ textAlign: 'left' }}
                  onClick={() => {
                    setMixer(m)
                    setResults([])
                    setQuery('')
                  }}
                >
                  {m.name} · {Math.round(m.kcalPer100ml)} kcal/100ml
                </button>
              ))}
            </div>
          )}
          {!isNeat && (
            <label style={{ display: 'grid', gap: 6, marginTop: 4 }}>
              <span style={labelStyle}>Mixer volume (ml)</span>
              <input
                className="pl-input"
                type="number"
                min={0}
                value={mixerMl}
                onChange={(e) => setMixerMl(Math.max(0, Number(e.target.value) || 0))}
              />
            </label>
          )}
        </div>

        <div style={{ display: 'grid', gap: 6 }}>
          <span style={labelStyle}>Pour strength</span>
          <div className="btn-row">
            {POUR_STRENGTHS.map((p) => (
              <button
                key={p.id}
                type="button"
                className={`fit-startbtn${p.id === strengthId ? '' : ' ghost'}`}
                onClick={() => setStrengthId(p.id)}
              >
                {p.label}
                <span style={{ opacity: 0.6 }}> · {p.shots}×</span>
              </button>
            ))}
          </div>
        </div>

        <div className="sec-rule">
          <div className="eyebrow">{preview.name.toUpperCase()}</div>
          <div className="line" />
        </div>
        <div className="plan-meta" style={{ fontSize: 14 }}>
          {preview.kcal} kcal · {preview.shots} shot{preview.shots > 1 ? 's' : ''} ·{' '}
          {preview.alcoholG} g alcohol
          {isNeat ? '' : ` · ${preview.carbsG} g carbs`}
        </div>

        <button type="button" className="fit-startbtn" onClick={handleLog} disabled={saving}>
          <Icon name="check" size={16} /> {saving ? 'Logging…' : 'Log drink'}
        </button>
      </div>

      {photoPicker.input}
    </Drawer>
  )
}

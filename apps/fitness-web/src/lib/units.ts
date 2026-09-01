// Weight-unit preference + conversion/formatting helpers. STORAGE IS
// ALWAYS KG — every DTO field (loadKg, tonnageKg, …) keeps its unit; only
// the render/input edge converts. The preference itself lives in the RPID
// settings store under the app-scoped 'fitness' namespace (key
// `weightUnit`), mirroring how the theme rides the 'shared' namespace:
// hydrated from the session probe on load, written through a registered
// persister on change (debounce-free — a unit flip is a single tap, not a
// slider). A localStorage cache (zustand persist) makes the pref stick
// between the first paint and the session fold-in.

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { KG_PER_LB } from '@rallypoint/fitness-shared'

export type WeightUnit = 'lb' | 'kg'

// Single source of truth lives in fitness-shared so the API can use the
// same factor when it normalizes a scanned whiteboard load to kg.
export { KG_PER_LB }

/** Narrow unknown input to a unit; anything unrecognized falls back to
 *  the product default, POUNDS. */
export function sanitizeWeightUnit(value: unknown): WeightUnit {
  return value === 'kg' ? 'kg' : 'lb'
}

/** Convert a stored kg value to the display unit's NUMBER. Pounds round
 *  to `dp` decimal places — the default 0 keeps the whole-lb behavior barbell
 *  loads rely on (43 kg → 95, the inverse of the seed's 95 lb → 43 kg
 *  rounding), while bodyweight passes dp=1 so a logged 158.2 lb survives the
 *  round-trip. kg always strips float noise to 2 dp. */
export function kgToDisplay(kg: number, unit: WeightUnit, dp = 0): number {
  if (unit === 'lb') {
    const f = 10 ** dp
    return Math.round((kg / KG_PER_LB) * f) / f
  }
  return Math.round(kg * 100) / 100
}

/** Convert a user-entered display-unit value back to storage kg (2 dp so
 *  95 lb → 43.09 kg rather than 43.09127…). */
export function displayToKg(value: number, unit: WeightUnit): number {
  if (unit === 'lb') return Math.round(value * KG_PER_LB * 100) / 100
  return value
}

/** "95 lb" / "43 kg" — the standard inline load chip. */
export function formatLoad(kg: number, unit: WeightUnit): string {
  return `${kgToDisplay(kg, unit)} ${unit}`
}

/** The plate-friendly step weight SUGGESTIONS snap to, per display unit:
 *  whole 5s in lb, 2.5s in kg. The recommender itself rounds in kg
 *  (weight-rec.ts), which lands on odd lb numbers (99, 94); snapping at
 *  the display edge keeps the strip gym-loadable in either unit. */
export const LOAD_INCREMENT: Record<WeightUnit, number> = { lb: 5, kg: 2.5 }

/** Snap a stored-kg load to the display unit's suggestion increment.
 *  Returns BOTH the display number and the storage kg that round-trips
 *  to it, so applying a suggestion writes exactly what the strip shows.
 *  Converts at 2 dp before snapping so the whole-lb display rounding
 *  can't pre-bias the snap. Floors at ONE increment, never 0 — a 0
 *  suggestion would apply as loadKg 0, which the save paths read as
 *  deliberate bodyweight. */
export function snapLoadToIncrement(
  kg: number,
  unit: WeightUnit,
): { display: number; kg: number } {
  const inc = LOAD_INCREMENT[unit]
  const display = Math.max(inc, Math.round(kgToDisplay(kg, unit, 2) / inc) * inc)
  return { display, kg: displayToKg(display, unit) }
}

/** Tonnage totals. kg keeps the existing style ("850 kg", "1.2 t");
 *  lb compacts at 10k ("8,500 lb", "12.5k lb"). */
export function formatTonnage(kg: number, unit: WeightUnit): string {
  if (unit === 'lb') {
    const lb = Math.round(kg / KG_PER_LB)
    if (lb >= 10_000) return `${(lb / 1000).toFixed(1)}k lb`
    return `${lb.toLocaleString('en-US')} lb`
  }
  if (kg >= 1000) return `${(kg / 1000).toFixed(1)} t`
  return `${Math.round(kg)} kg`
}

// ── Distance units (running) ─────────────────────────────────────────
// STORAGE IS ALWAYS METRES (distance_m / distanceM); the composer + live
// session let runners enter miles and convert at the input edge, same
// contract as the kg/lb pair above.

export type DistanceUnit = 'm' | 'mi'

export const M_PER_MI = 1609.344

/** Convert an entered display value to storage metres (2 dp — 5 mi →
 *  8046.72 m rather than 8046.7199…). */
export function displayToM(value: number, unit: DistanceUnit): number {
  if (unit === 'mi') return Math.round(value * M_PER_MI * 100) / 100
  return value
}

/** Convert stored metres to the display unit's NUMBER (miles keep 2 dp;
 *  metres strip float noise). */
export function mToDisplay(m: number, unit: DistanceUnit): number {
  if (unit === 'mi') return Math.round((m / M_PER_MI) * 100) / 100
  return Math.round(m * 100) / 100
}

/** Pick the friendlier unit to HYDRATE a stored distance into a form:
 *  values that came from a miles entry (whole quarter-miles within float
 *  noise) come back as 'mi'; everything else stays metres. */
export function naturalDistanceUnit(m: number): DistanceUnit {
  const quarterMiles = m / (M_PER_MI / 4)
  return m > 0 && Math.abs(quarterMiles - Math.round(quarterMiles)) < 1e-4 ? 'mi' : 'm'
}

/** "8,047 m" / "5 mi" — inline distance chip in the natural unit. */
export function formatDistanceM(m: number): string {
  const unit = naturalDistanceUnit(m)
  if (unit === 'mi') return `${mToDisplay(m, 'mi')} mi`
  return `${Math.round(m).toLocaleString('en-US')} m`
}

// ── Preference store ─────────────────────────────────────────────────

export type WeightUnitPersister = (unit: WeightUnit) => void

let unitPersister: WeightUnitPersister | null = null
// Set true around hydration so applying the server value doesn't echo a
// write straight back through the persister (same guard as the theme
// store).
let hydrating = false

/** Register the sink that setWeightUnit writes through to (a PATCH into
 *  the 'fitness' settings namespace, registered in main.tsx). Passing
 *  null clears it. */
export function registerWeightUnitPersister(fn: WeightUnitPersister | null): void {
  unitPersister = fn
}

/** Apply the server-stored preference without echoing a write back. */
export function hydrateWeightUnitFromServer(value: unknown): void {
  if (value === undefined) return
  hydrating = true
  try {
    useWeightUnitStore.getState().setUnit(sanitizeWeightUnit(value))
  } finally {
    hydrating = false
  }
}

interface WeightUnitState {
  unit: WeightUnit
  setUnit: (unit: WeightUnit) => void
}

export const useWeightUnitStore = create<WeightUnitState>()(
  persist(
    (set) => ({
      unit: 'lb',
      setUnit: (unit) => {
        const next = sanitizeWeightUnit(unit)
        set({ unit: next })
        if (!hydrating) {
          try {
            unitPersister?.(next)
          } catch {
            // fire-and-forget: a failed write must never break the UI
          }
        }
      },
    }),
    {
      name: 'rp-fitness-weight-unit',
      partialize: (s) => ({ unit: s.unit }),
      onRehydrateStorage: () => (state) => {
        if (state) state.unit = sanitizeWeightUnit(state.unit)
      },
    },
  ),
)

/** The active display unit — subscribes the component to changes. */
export function useWeightUnit(): WeightUnit {
  return useWeightUnitStore((s) => s.unit)
}

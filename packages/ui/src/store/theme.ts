import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/**
 * Dual-axis theme switcher for the "Ink" design system.
 *
 *   mode  : 'dark' | 'light'  — the chassis (bg / surface / ink). Dark is
 *           the Ink default. Written to <html data-mode="…">.
 *   color : one of six accents — written to <html data-color="…">.
 *
 * `theme` / `setTheme` / `toggle` are kept as aliases of the mode axis so
 * the per-app `ThemeToggle.tsx` components (events/lists/money/id/planner)
 * keep compiling and working unchanged. `applyThemeToDom` also writes the
 * legacy `data-theme` attribute so any unmigrated CSS still resolves.
 *
 * Persisted per-browser under `rallypt-theme` (mode + color only). The
 * v0→v1 migration maps the old single-axis `{ theme }` shape onto
 * `{ mode }`.
 */

/** Chassis background hex per mode — used by the boot script to set
 *  `<meta name="theme-color">` (Android Chrome address-bar tint) before
 *  first paint, and by `applyThemeToDom` to keep it in sync on runtime
 *  mode changes. Static map: manifests and the inline boot script can't
 *  read CSS variables. */
export const CHASSIS_BG: Record<'dark' | 'light', string> = {
  dark: '#0b1b2b',
  light: '#ffffff',
}

/**
 * Single source-of-truth for the inline pre-hydration boot script that
 * lives inside a bare `<script>` tag in each app's index.html (#380).
 *
 * The script runs before React hydrates so a returning user sees the
 * correct chassis immediately (#287). It:
 *   1. Reads the persisted `rallypt-theme` blob from localStorage.
 *   2. Resolves mode + color (same logic as `resolveBootTheme`).
 *   3. Sets `data-mode`, `data-color`, `data-theme` on `<html>`.
 *   4. Sets `<meta name="theme-color" id="theme-color">` to the chassis
 *      bg so Android Chrome's address bar matches (#379).
 *
 * The parity test in `theme-boot-parity.test.ts` asserts that the
 * `<script>` body in every index.html equals this string exactly. Any
 * drift → the test fails.
 *
 * KEEP IN SYNC with `resolveBootTheme()` above.
 */
export const THEME_BOOT_SOURCE = `\
;(function () {
  try {
    var s = JSON.parse(localStorage.getItem('rallypt-theme') || '{}').state || {}
    var m = s.mode || s.theme
    m = m === 'light' || m === 'dark' ? m : 'dark'
    var c =
      ['blue', 'orange', 'purple', 'pink', 'red', 'green'].indexOf(s.color) >= 0
        ? s.color
        : 'blue'
    var el = document.documentElement
    el.dataset.mode = m
    el.dataset.color = c
    el.dataset.theme = m
    var meta = document.getElementById('theme-color')
    if (meta) meta.setAttribute('content', m === 'light' ? '#ffffff' : '#0b1b2b')
  } catch (e) {}
})()`

export type Theme = 'light' | 'dark'
export type AccentColor = 'blue' | 'orange' | 'purple' | 'pink' | 'red' | 'green'

const MODES = ['light', 'dark'] as const
export const COLORS_ORDER = ['blue', 'orange', 'purple', 'pink', 'red', 'green'] as const

/** Canonical swatch hex per accent — the single source of truth for UI that
 *  previews the accents (the live `--accent` CSS var is set from `data-color`
 *  in theme.css; these literals are for swatch dots/chips that render the same
 *  in either chassis). */
export const ACCENT_HEX: Record<AccentColor, string> = {
  blue: '#0EA5E9',
  orange: '#FB923C',
  purple: '#A855F7',
  pink: '#FF2D7A',
  red: '#EF4444',
  green: '#22C55E',
}

/** Narrow any input to a known mode; unknown values fall back to `dark`
 *  (the Ink default). Named `sanitizeTheme` for back-compat. */
export function sanitizeTheme(value: unknown): Theme {
  return (MODES as readonly string[]).includes(value as string)
    ? (value as Theme)
    : 'dark'
}

/** Narrow any input to a known accent; unknown values fall back to
 *  `blue`. */
export function sanitizeColor(value: unknown): AccentColor {
  return (COLORS_ORDER as readonly string[]).includes(value as string)
    ? (value as AccentColor)
    : 'blue'
}

/** Pure next-mode helper (dark ⇄ light). */
export function toggleMode(mode: Theme): Theme {
  return mode === 'dark' ? 'light' : 'dark'
}

/** Pure next-accent helper, wrapping through COLORS_ORDER. */
export function cycleColor(color: AccentColor): AccentColor {
  const i = COLORS_ORDER.indexOf(color)
  return COLORS_ORDER[(i + 1) % COLORS_ORDER.length] ?? 'blue'
}

/** Write the active theme to the document root. Sets `data-mode` and
 *  `data-color` (the Ink dual-axis) plus the legacy `data-theme`
 *  attribute (mirrors the mode) so any CSS still keyed on `data-theme`
 *  keeps resolving. Also updates `<meta name="theme-color" id="theme-color">`
 *  so the Android Chrome address bar tracks runtime mode changes (#379).
 *  `color` defaults to the current store value. */
export function applyThemeToDom(mode: Theme, color?: AccentColor): void {
  if (typeof document === 'undefined') return
  const el = document.documentElement
  const m = sanitizeTheme(mode)
  const c = sanitizeColor(color ?? useThemeStore.getState().color)
  el.dataset.mode = m
  el.dataset.color = c
  el.dataset.theme = m
  const meta = document.getElementById('theme-color')
  if (meta) meta.setAttribute('content', CHASSIS_BG[m])
}

/** Resolve the boot-time theme straight from the raw persisted localStorage
 *  value (the `rallypt-theme` zustand-persist blob) WITHOUT touching the
 *  store. The pre-hydration inline script body is exported as
 *  `THEME_BOOT_SOURCE` (the single source of truth, #380); the parity test
 *  asserts every index.html matches it exactly. Reads both the v1 dual-axis
 *  `state.mode` and the legacy v0 single-axis `state.theme`, so a
 *  not-yet-migrated returning user still boots to the right chassis (#287).
 *  Any parse/shape error falls back to the Ink defaults (dark / blue).
 *  Keep `THEME_BOOT_SOURCE` in sync with this function. */
export function resolveBootTheme(raw: string | null): { mode: Theme; color: AccentColor } {
  try {
    const state =
      (JSON.parse(raw ?? '{}') as { state?: Record<string, unknown> }).state ?? {}
    // `||` (not `??`) so a falsy mode falls through to the legacy `theme`,
    // keeping this byte-equivalent to the inline index.html script for
    // every input (they only differ on a tampered empty-string mode).
    return {
      mode: sanitizeTheme(state.mode || state.theme),
      color: sanitizeColor(state.color),
    }
  } catch {
    return { mode: 'dark', color: 'blue' }
  }
}

interface ThemeState {
  mode: Theme
  color: AccentColor
  /** Alias of `mode` (back-compat). */
  theme: Theme
  setMode: (mode: Theme) => void
  toggleMode: () => void
  setColor: (color: AccentColor) => void
  cycleColor: () => void
  /** Aliases of the mode actions (back-compat). */
  setTheme: (theme: Theme) => void
  toggle: () => void
}

/** A registered sink for theme changes — apps wire this to a debounced
 *  PATCH into the shared server settings bag (Phase 2). Fire-and-forget;
 *  errors are the persister's problem, not the store's. */
export type ThemePersister = (snapshot: { mode: Theme; color: AccentColor }) => void

let themePersister: ThemePersister | null = null
let persistTimer: ReturnType<typeof setTimeout> | null = null
const PERSIST_DEBOUNCE_MS = 300
// Set true around hydration so applying the server value doesn't echo a
// write straight back through the persister.
let hydrating = false

/** Register the sink that mutating theme actions write through to. Passing
 *  `null` clears it. Only one persister is active at a time (last wins). */
export function registerThemePersister(fn: ThemePersister | null): void {
  themePersister = fn
}

/** Debounced fire of the registered persister with the current snapshot.
 *  No-op while hydrating or when no persister is registered. */
function schedulePersist(mode: Theme, color: AccentColor): void {
  if (hydrating || !themePersister) return
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    persistTimer = null
    try {
      themePersister?.({ mode, color })
    } catch {
      // fire-and-forget: a failed write-through must never break the UI
    }
  }, PERSIST_DEBOUNCE_MS)
}

/** Apply a server-provided theme without echoing a write back through the
 *  persister. Unknown values are sanitized; the DOM + localStorage cache
 *  are refreshed via the normal store path. */
export function hydrateThemeFromServer(value: { mode?: unknown; color?: unknown }): void {
  hydrating = true
  try {
    const { setMode, setColor } = useThemeStore.getState()
    if (value.mode !== undefined) setMode(sanitizeTheme(value.mode))
    if (value.color !== undefined) setColor(sanitizeColor(value.color))
  } finally {
    hydrating = false
  }
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set, get) => ({
      mode: 'dark',
      color: 'blue',
      theme: 'dark',
      setMode: (mode) => {
        const next = sanitizeTheme(mode)
        applyThemeToDom(next, get().color)
        set({ mode: next, theme: next })
        schedulePersist(next, get().color)
      },
      toggleMode: () => {
        const next = toggleMode(get().mode)
        applyThemeToDom(next, get().color)
        set({ mode: next, theme: next })
        schedulePersist(next, get().color)
      },
      setColor: (color) => {
        const next = sanitizeColor(color)
        applyThemeToDom(get().mode, next)
        set({ color: next })
        schedulePersist(get().mode, next)
      },
      cycleColor: () => {
        const next = cycleColor(get().color)
        applyThemeToDom(get().mode, next)
        set({ color: next })
        schedulePersist(get().mode, next)
      },
      setTheme: (theme) => get().setMode(theme),
      toggle: () => get().toggleMode(),
    }),
    {
      name: 'rallypt-theme',
      version: 1,
      partialize: (s) => ({ mode: s.mode, color: s.color }),
      migrate: (persisted, version) => {
        // v0 stored the single-axis `{ theme }`; map it onto `{ mode }`.
        const p = (persisted ?? {}) as Record<string, unknown>
        if (version < 1) {
          return { mode: sanitizeTheme(p.theme), color: 'blue' as AccentColor }
        }
        return { mode: sanitizeTheme(p.mode), color: sanitizeColor(p.color) }
      },
      onRehydrateStorage: () => (state) => {
        if (!state) return
        const mode = sanitizeTheme(state.mode)
        const color = sanitizeColor(state.color)
        state.mode = mode
        state.color = color
        state.theme = mode
        applyThemeToDom(mode, color)
      },
    },
  ),
)

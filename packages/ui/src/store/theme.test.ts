// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  sanitizeTheme,
  sanitizeColor,
  applyThemeToDom,
  resolveBootTheme,
  cycleColor,
  toggleMode,
  COLORS_ORDER,
  CHASSIS_BG,
  THEME_BOOT_SOURCE,
  useThemeStore,
  registerThemePersister,
  hydrateThemeFromServer,
} from './theme.js'

describe('sanitizeTheme', () => {
  it('passes through known modes', () => {
    expect(sanitizeTheme('light')).toBe('light')
    expect(sanitizeTheme('dark')).toBe('dark')
  })
  it('falls back to dark (Ink default) for anything unknown', () => {
    expect(sanitizeTheme('neon')).toBe('dark')
    expect(sanitizeTheme(undefined)).toBe('dark')
    expect(sanitizeTheme(null)).toBe('dark')
    expect(sanitizeTheme(42)).toBe('dark')
  })
})

describe('sanitizeColor', () => {
  it('passes through known accents', () => {
    for (const c of COLORS_ORDER) expect(sanitizeColor(c)).toBe(c)
  })
  it('falls back to blue for anything unknown', () => {
    expect(sanitizeColor('teal')).toBe('blue')
    expect(sanitizeColor(undefined)).toBe('blue')
  })
})

describe('toggleMode', () => {
  it('flips dark↔light', () => {
    expect(toggleMode('dark')).toBe('light')
    expect(toggleMode('light')).toBe('dark')
  })
})

describe('cycleColor', () => {
  it('advances through COLORS_ORDER and wraps', () => {
    expect(COLORS_ORDER).toEqual(['blue', 'orange', 'purple', 'pink', 'red', 'green'])
    expect(cycleColor('blue')).toBe('orange')
    expect(cycleColor('orange')).toBe('purple')
    expect(cycleColor('green')).toBe('blue') // wrap
  })
})

describe('CHASSIS_BG', () => {
  it('maps dark to the Ink dark chassis bg hex', () => {
    expect(CHASSIS_BG.dark).toBe('#0b1b2b')
  })
  it('maps light to white', () => {
    expect(CHASSIS_BG.light).toBe('#ffffff')
  })
})

describe('THEME_BOOT_SOURCE', () => {
  it('is a non-empty string (the exported source-of-truth)', () => {
    expect(typeof THEME_BOOT_SOURCE).toBe('string')
    expect(THEME_BOOT_SOURCE.length).toBeGreaterThan(0)
  })
  it('references the dark chassis bg hex', () => {
    expect(THEME_BOOT_SOURCE).toContain('#0b1b2b')
  })
  it('references the light chassis bg hex', () => {
    expect(THEME_BOOT_SOURCE).toContain('#ffffff')
  })
  it('sets the theme-color meta by id', () => {
    expect(THEME_BOOT_SOURCE).toContain("getElementById('theme-color')")
    expect(THEME_BOOT_SOURCE).toContain("setAttribute('content'")
  })
  it('reads from the rallypt-theme localStorage key', () => {
    expect(THEME_BOOT_SOURCE).toContain("'rallypt-theme'")
  })
})

describe('applyThemeToDom', () => {
  let meta: HTMLMetaElement

  beforeEach(() => {
    delete document.documentElement.dataset.mode
    delete document.documentElement.dataset.color
    delete document.documentElement.dataset.theme
    // Simulate the <meta name="theme-color" id="theme-color"> present in
    // each index.html so applyThemeToDom can update it (#379).
    meta = document.createElement('meta')
    meta.id = 'theme-color'
    meta.name = 'theme-color'
    meta.content = '#0b1b2b'
    document.head.appendChild(meta)
  })

  afterEach(() => {
    meta.remove()
  })

  it('writes data-mode, data-color, and the legacy data-theme alias', () => {
    applyThemeToDom('light', 'pink')
    expect(document.documentElement.dataset.mode).toBe('light')
    expect(document.documentElement.dataset.color).toBe('pink')
    expect(document.documentElement.dataset.theme).toBe('light')
  })
  it('mirrors mode onto data-theme for dark', () => {
    applyThemeToDom('dark', 'blue')
    expect(document.documentElement.dataset.mode).toBe('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
  })
  it('sets meta theme-color to dark chassis bg when mode is dark (#379)', () => {
    applyThemeToDom('dark', 'blue')
    expect(meta.getAttribute('content')).toBe('#0b1b2b')
  })
  it('sets meta theme-color to light chassis bg when mode is light (#379)', () => {
    applyThemeToDom('light', 'blue')
    expect(meta.getAttribute('content')).toBe('#ffffff')
  })
  it('does not throw when the meta tag is absent', () => {
    meta.remove()
    // Should be a no-op without the meta tag, not an error.
    expect(() => applyThemeToDom('dark', 'blue')).not.toThrow()
    // Re-add so afterEach cleanup doesn't fail.
    document.head.appendChild(meta)
  })
})

describe('useThemeStore', () => {
  beforeEach(() => {
    delete document.documentElement.dataset.mode
    delete document.documentElement.dataset.color
    delete document.documentElement.dataset.theme
    useThemeStore.setState({ mode: 'dark', color: 'blue', theme: 'dark' })
  })
  it('defaults to dark + blue', () => {
    expect(useThemeStore.getState().mode).toBe('dark')
    expect(useThemeStore.getState().color).toBe('blue')
  })
  it('toggle flips mode, keeps theme alias in sync, and writes the DOM', () => {
    useThemeStore.getState().toggle()
    expect(useThemeStore.getState().mode).toBe('light')
    expect(useThemeStore.getState().theme).toBe('light')
    expect(document.documentElement.dataset.mode).toBe('light')
    expect(document.documentElement.dataset.theme).toBe('light')
    useThemeStore.getState().toggle()
    expect(useThemeStore.getState().mode).toBe('dark')
  })
  it('setTheme sanitizes bad input to dark', () => {
    useThemeStore.getState().setTheme('light')
    expect(useThemeStore.getState().theme).toBe('light')
    useThemeStore.getState().setTheme('bogus' as unknown as 'light')
    expect(useThemeStore.getState().theme).toBe('dark')
  })
  it('cycleColor advances the accent and writes data-color', () => {
    useThemeStore.getState().cycleColor()
    expect(useThemeStore.getState().color).toBe('orange')
    expect(document.documentElement.dataset.color).toBe('orange')
  })
})

// Phase 2 seams: a registered persister captures mutating actions (so an
// app can write theme through to the shared server bag), and
// hydrateThemeFromServer applies a server value WITHOUT echoing a write
// back through that persister.
describe('registerThemePersister + hydrateThemeFromServer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    delete document.documentElement.dataset.mode
    delete document.documentElement.dataset.color
    delete document.documentElement.dataset.theme
    useThemeStore.setState({ mode: 'dark', color: 'blue', theme: 'dark' })
  })
  afterEach(() => {
    registerThemePersister(null)
    // The persister is debounced via a module-level setTimeout; flush any
    // pending timer here so a deferred fire can't leak into a later test.
    vi.runOnlyPendingTimers()
    vi.useRealTimers()
  })

  it('fires the registered persister (debounced) on a mutating action', () => {
    const persist = vi.fn()
    registerThemePersister(persist)
    useThemeStore.getState().setMode('light')
    expect(persist).not.toHaveBeenCalled() // debounced, not yet
    vi.advanceTimersByTime(300)
    expect(persist).toHaveBeenCalledTimes(1)
    expect(persist).toHaveBeenCalledWith({ mode: 'light', color: 'blue' })
  })

  it('debounces a burst of changes into a single trailing write', () => {
    const persist = vi.fn()
    registerThemePersister(persist)
    useThemeStore.getState().setMode('light')
    useThemeStore.getState().cycleColor() // -> orange
    useThemeStore.getState().cycleColor() // -> purple
    vi.advanceTimersByTime(300)
    expect(persist).toHaveBeenCalledTimes(1)
    expect(persist).toHaveBeenCalledWith({ mode: 'light', color: 'purple' })
  })

  it('captures the accent axis too', () => {
    const persist = vi.fn()
    registerThemePersister(persist)
    useThemeStore.getState().setColor('red')
    vi.advanceTimersByTime(300)
    expect(persist).toHaveBeenCalledWith({ mode: 'dark', color: 'red' })
  })

  it('hydrateThemeFromServer applies values without echoing a write', () => {
    const persist = vi.fn()
    registerThemePersister(persist)
    hydrateThemeFromServer({ mode: 'light', color: 'green' })
    vi.advanceTimersByTime(300)
    expect(persist).not.toHaveBeenCalled()
    expect(useThemeStore.getState().mode).toBe('light')
    expect(useThemeStore.getState().color).toBe('green')
    expect(document.documentElement.dataset.mode).toBe('light')
    expect(document.documentElement.dataset.color).toBe('green')
  })

  it('hydrateThemeFromServer sanitizes bad input and ignores absent axes', () => {
    registerThemePersister(null)
    hydrateThemeFromServer({ mode: 'neon' }) // color absent
    expect(useThemeStore.getState().mode).toBe('dark') // sanitized
    expect(useThemeStore.getState().color).toBe('blue') // untouched
    hydrateThemeFromServer({ color: 'teal' }) // bad color, mode absent
    expect(useThemeStore.getState().color).toBe('blue') // sanitized
  })

  it('clearing the persister stops further write-through', () => {
    const persist = vi.fn()
    registerThemePersister(persist)
    registerThemePersister(null)
    useThemeStore.getState().setMode('light')
    vi.advanceTimersByTime(300)
    expect(persist).not.toHaveBeenCalled()
  })
})

// Back-compat: every returning user of the four sibling apps hits the
// v0->v1 persist migration (old single-axis `{theme}` -> new `{mode}`)
// and the rehydrate path that re-syncs the `theme` alias + DOM.
describe('persist migration + rehydrate (back-compat)', () => {
  const persistApi = useThemeStore.persist as unknown as {
    getOptions: () => {
      migrate?: (s: unknown, v: number) => unknown
      onRehydrateStorage?: () => (s: ThemeStateShape | undefined) => void
      partialize?: (s: ThemeStateShape) => unknown
    }
  }
  type ThemeStateShape = {
    mode: 'light' | 'dark'
    color: string
    theme: 'light' | 'dark'
  }

  beforeEach(() => {
    delete document.documentElement.dataset.mode
    delete document.documentElement.dataset.color
    delete document.documentElement.dataset.theme
  })

  it('migrates the old v0 {theme:"light"} shape to {mode:"light", color:"blue"}', () => {
    const migrate = persistApi.getOptions().migrate!
    expect(migrate({ theme: 'light' }, 0)).toEqual({ mode: 'light', color: 'blue' })
    expect(migrate({ theme: 'dark' }, 0)).toEqual({ mode: 'dark', color: 'blue' })
  })

  it('migrate sanitizes a bogus v0 theme to the dark default', () => {
    const migrate = persistApi.getOptions().migrate!
    expect(migrate({ theme: 'neon' }, 0)).toEqual({ mode: 'dark', color: 'blue' })
    expect(migrate({}, 0)).toEqual({ mode: 'dark', color: 'blue' })
  })

  it('migrate passes a current v1 {mode,color} shape through (sanitized)', () => {
    const migrate = persistApi.getOptions().migrate!
    expect(migrate({ mode: 'light', color: 'pink' }, 1)).toEqual({
      mode: 'light',
      color: 'pink',
    })
    expect(migrate({ mode: 'bogus', color: 'teal' }, 1)).toEqual({
      mode: 'dark',
      color: 'blue',
    })
  })

  it('partialize persists only mode + color (not the theme alias)', () => {
    const partialize = persistApi.getOptions().partialize!
    expect(partialize({ mode: 'light', color: 'red', theme: 'light' })).toEqual({
      mode: 'light',
      color: 'red',
    })
  })

  it('onRehydrateStorage re-syncs the theme alias and writes the DOM', () => {
    const cb = persistApi.getOptions().onRehydrateStorage!()
    const state: ThemeStateShape = { mode: 'light', color: 'green', theme: 'dark' }
    cb(state)
    expect(state.theme).toBe('light') // alias corrected from mode
    expect(document.documentElement.dataset.mode).toBe('light')
    expect(document.documentElement.dataset.color).toBe('green')
    expect(document.documentElement.dataset.theme).toBe('light')
  })
})

// The pre-hydration inline script in each app's index.html mirrors this
// helper to kill the dark-chassis FOUC before first paint (#287). The
// canonical zustand-persist blob is `{ state: { mode, color }, version }`;
// a not-yet-migrated v0 user has `{ state: { theme } }`.
describe('resolveBootTheme (#287 pre-hydration)', () => {
  function persisted(state: Record<string, unknown>, version = 1): string {
    return JSON.stringify({ state, version })
  }

  it('reads the v1 dual-axis mode + color', () => {
    expect(resolveBootTheme(persisted({ mode: 'light', color: 'pink' }))).toEqual({
      mode: 'light',
      color: 'pink',
    })
  })

  it('falls back to the legacy v0 single-axis theme when mode is absent', () => {
    expect(resolveBootTheme(persisted({ theme: 'light' }, 0))).toEqual({
      mode: 'light',
      color: 'blue',
    })
  })

  it('prefers mode over the legacy theme alias when both are present', () => {
    expect(resolveBootTheme(persisted({ mode: 'dark', theme: 'light' })).mode).toBe('dark')
  })

  it('falls through a falsy (tampered) mode to theme — parity with the inline script', () => {
    // `||` semantics: an empty-string mode is treated as absent, matching
    // the `s.mode || s.theme` in each index.html boot script exactly.
    expect(resolveBootTheme(persisted({ mode: '', theme: 'light' })).mode).toBe('light')
  })

  it('sanitizes bogus mode/color to the Ink defaults (dark / blue)', () => {
    expect(resolveBootTheme(persisted({ mode: 'neon', color: 'teal' }))).toEqual({
      mode: 'dark',
      color: 'blue',
    })
  })

  it('defaults to dark/blue for null, empty, or malformed storage', () => {
    expect(resolveBootTheme(null)).toEqual({ mode: 'dark', color: 'blue' })
    expect(resolveBootTheme('')).toEqual({ mode: 'dark', color: 'blue' })
    expect(resolveBootTheme('not json')).toEqual({ mode: 'dark', color: 'blue' })
    expect(resolveBootTheme('{}')).toEqual({ mode: 'dark', color: 'blue' })
  })
})

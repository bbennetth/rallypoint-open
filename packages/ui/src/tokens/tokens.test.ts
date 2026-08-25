/**
 * Tokens parity guard.
 *
 * The Ink design system splits its tokens across four files under
 * `packages/ui/src/tokens/`, mirroring the kit's `design_files/tokens/`
 * structure. `theme.css` is the entry point that `@import`s all four;
 * if a file is renamed, an @import drops, or a load-bearing token gets
 * deleted, every consuming app silently de-themes (text turns black,
 * accents collapse to default, etc.).
 *
 * This test parses theme.css + the four tokens files as plain text and
 * asserts the @import wiring and a representative slice of tokens that
 * downstream code in apps/* and packages/ui/shell.css depends on.
 * jsdom can't fully resolve CSS @imports + `color-mix()` at runtime, so
 * we check the source instead of computed style.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'

const UI_SRC = resolve(import.meta.dirname, '..')
const THEME_CSS = readFileSync(resolve(UI_SRC, 'theme.css'), 'utf-8')
const TOKENS = {
  colors: readFileSync(resolve(UI_SRC, 'tokens/colors.css'), 'utf-8'),
  typography: readFileSync(resolve(UI_SRC, 'tokens/typography.css'), 'utf-8'),
  spacing: readFileSync(resolve(UI_SRC, 'tokens/spacing.css'), 'utf-8'),
  primitives: readFileSync(resolve(UI_SRC, 'tokens/primitives.css'), 'utf-8'),
}

describe('theme.css entry — @imports the four tokens files in kit order', () => {
  it('imports colors, typography, spacing, primitives (in that order)', () => {
    const colorsIdx = THEME_CSS.indexOf("@import './tokens/colors.css'")
    const typographyIdx = THEME_CSS.indexOf("@import './tokens/typography.css'")
    const spacingIdx = THEME_CSS.indexOf("@import './tokens/spacing.css'")
    const primitivesIdx = THEME_CSS.indexOf("@import './tokens/primitives.css'")
    expect(colorsIdx, 'colors.css @import missing').toBeGreaterThan(-1)
    expect(typographyIdx, 'typography.css @import missing').toBeGreaterThan(-1)
    expect(spacingIdx, 'spacing.css @import missing').toBeGreaterThan(-1)
    expect(primitivesIdx, 'primitives.css @import missing').toBeGreaterThan(-1)
    expect(colorsIdx).toBeLessThan(typographyIdx)
    expect(typographyIdx).toBeLessThan(spacingIdx)
    expect(spacingIdx).toBeLessThan(primitivesIdx)
  })
})

describe('tokens/colors.css — chassis + accents + derived washes', () => {
  it.each([
    ['--bg', '#0b1b2b'],
    ['--surface', '#152638'],
    ['--ink', '#ffffff'],
    ['--ink-dim', '#a8bcd4'],
    ['--ink-mute', '#7a8fa6'],
    ['--map-highlight', '#39ff14'],
    ['--hot', '#ef4444'],
  ])('declares %s = %s', (name, value) => {
    expect(TOKENS.colors).toMatch(new RegExp(`${name}\\s*:\\s*${value.replace('#', '#')}`, 'i'))
  })

  it.each([['blue', '#0ea5e9'], ['orange', '#fb923c'], ['purple', '#a855f7'], ['pink', '#ff2d7a'], ['red', '#ef4444'], ['green', '#22c55e']])(
    'dark-mode accent %s = %s',
    (color, hex) => {
      // Match the `[data-color='blue'] { --acid: #0ea5e9; … }` rule shape.
      const rule = new RegExp(`\\[data-color='${color}'\\][^}]*--acid:\\s*${hex}`, 'i')
      expect(TOKENS.colors).toMatch(rule)
    },
  )

  it('exposes derived accent washes', () => {
    expect(TOKENS.colors).toMatch(/--accent-soft:\s*color-mix\(in srgb, var\(--acid\) 14%, transparent\)/)
    expect(TOKENS.colors).toMatch(/--accent-soft-2:\s*color-mix\(in srgb, var\(--acid\) 8%, transparent\)/)
    expect(TOKENS.colors).toMatch(/--accent-soft-strong:\s*color-mix\(in srgb, var\(--acid\) 18%, transparent\)/)
    expect(TOKENS.colors).toMatch(/--accent-ring:\s*color-mix\(in srgb, var\(--acid\) 35%, transparent\)/)
    expect(TOKENS.colors).toMatch(/--accent-avatar:\s*color-mix\(in srgb, var\(--acid\) 22%, transparent\)/)
    expect(TOKENS.colors).toMatch(/--acid-dim:\s*color-mix\(in srgb, var\(--acid\) 60%, transparent\)/)
  })

  it('exposes Soft Ink ink washes + danger tokens (dark + light)', () => {
    expect(TOKENS.colors).toMatch(/--wash-hover:\s*color-mix\(in srgb, var\(--ink\) 4%, transparent\)/)
    expect(TOKENS.colors).toMatch(/--hairline-soft:\s*color-mix\(in srgb, var\(--ink\) 6%, transparent\)/)
    // Dark chassis --line + danger pair.
    expect(TOKENS.colors).toMatch(/--line:\s*#24364e/)
    expect(TOKENS.colors).toMatch(/--hot-text:\s*#f87171/)
    expect(TOKENS.colors).toMatch(/--hot-soft:\s*rgba\(239, 68, 68, 0\.18\)/)
    // Light overrides: darker danger + lighter shadows.
    expect(TOKENS.colors).toMatch(/--hot-text:\s*#dc2626/)
    expect(TOKENS.colors).toMatch(/--hot-soft:\s*rgba\(220, 38, 38, 0\.12\)/)
    expect(TOKENS.colors).toMatch(/--edge-highlight:/)
    expect(TOKENS.colors).toMatch(/--shadow-card:\s*0 2px 10px rgba\(11, 27, 43, 0\.08\)/)
    expect(TOKENS.colors).toMatch(/--shadow-panel:\s*0 4px 16px rgba\(11, 27, 43, 0\.1\)/)
  })

  it('light-mode shadow overrides out-specify the spacing.css :root base', () => {
    // spacing.css @imports AFTER colors.css, so a bare `[data-mode='light']`
    // (equal specificity, earlier source) loses the cascade and light mode
    // silently inherits the heavy dark rgba(0,0,0,…) shadows. The override
    // MUST use `:root[data-mode='light']` (0,2,0) to beat `:root` (0,1,0).
    // Guard the exact selector so the fix can't regress unnoticed.
    expect(TOKENS.colors).toMatch(
      /:root\[data-mode='light'\],\s*:root\[data-theme='light'\]\s*\{\s*--shadow-card:\s*0 2px 10px rgba\(11, 27, 43, 0\.08\);\s*--shadow-panel:\s*0 4px 16px rgba\(11, 27, 43, 0\.1\);/,
    )
  })

})

describe('tokens/typography.css — families + size scale + tracking', () => {
  it('declares the three font families', () => {
    expect(TOKENS.typography).toMatch(/--font-display:\s*'Archivo Black'/)
    expect(TOKENS.typography).toMatch(/--font-body:\s*'Space Grotesk'/)
    expect(TOKENS.typography).toMatch(/--font-mono:\s*'Space Mono'/)
  })

  it.each([
    ['--text-display-xl', '40px'],
    ['--text-display-lg', '34px'],
    ['--text-display-md', '30px'],
    ['--text-display-sm', '20px'],
    ['--text-lg', '16px'],
    ['--text-md', '14px'],
    ['--text-sm', '13px'],
    ['--text-xs', '12px'],
    ['--text-mono-eyebrow', '9px'],
    ['--text-mono-nav', '12px'],
    ['--text-mono-meta', '11px'],
  ])('declares %s = %s', (name, value) => {
    expect(TOKENS.typography).toMatch(new RegExp(`${name}\\s*:\\s*${value}`))
  })

  it('declares tracking + leading scales', () => {
    for (const t of ['--tracking-display', '--tracking-tight', '--tracking-eyebrow', '--tracking-nav', '--tracking-caps']) {
      expect(TOKENS.typography, `${t} missing`).toMatch(new RegExp(`${t}\\s*:`))
    }
    for (const l of ['--leading-display', '--leading-body', '--leading-tight']) {
      expect(TOKENS.typography, `${l} missing`).toMatch(new RegExp(`${l}\\s*:`))
    }
  })
})

describe('tokens/spacing.css — spacing, borders, radius, shadows, motion', () => {
  it.each([
    ['--space-3', '12px'],
    ['--space-4', '16px'],
    ['--space-5', '20px'],
  ])('spacing scale %s = %s', (name, value) => {
    expect(TOKENS.spacing).toMatch(new RegExp(`${name}\\s*:\\s*${value}`))
  })

  it.each([
    ['--radius-badge', '4px'],
    ['--radius-sm', '6px'],
    ['--radius-checkbox', '7px'],
    ['--radius-md', '8px'],
    ['--radius-seg-active', '8px'],
    ['--radius-nav', '10px'],
    ['--radius-lg', '12px'],
    ['--radius-xl', '14px'],
    ['--radius-pill', '22px'],
    ['--radius-round', '999px'],
  ])('radius scale %s = %s', (name, value) => {
    expect(TOKENS.spacing).toMatch(new RegExp(`${name}\\s*:\\s*${value}`))
  })

  it.each(['--border-width', '--border-width-thin', '--border-accent'])('border token %s defined', (name) => {
    expect(TOKENS.spacing).toMatch(new RegExp(`${name}\\s*:`))
  })

  it.each([
    '--shadow-card',
    '--shadow-panel',
    '--shadow-flyout',
    '--shadow-fab',
    '--shadow-tabbar',
    '--shadow-toast',
  ])('shadow token %s defined', (name) => {
    expect(TOKENS.spacing).toMatch(new RegExp(`${name}\\s*:`))
  })

  it('Soft Ink shadows + glows use the spec values', () => {
    expect(TOKENS.spacing).toMatch(/--shadow-card:\s*0 2px 10px rgba\(0, 0, 0, 0\.18\)/)
    expect(TOKENS.spacing).toMatch(/--shadow-panel:\s*0 4px 16px rgba\(0, 0, 0, 0\.22\)/)
    expect(TOKENS.spacing).toMatch(/--glow-accent:\s*0 2px 8px color-mix\(in srgb, var\(--acid\) 42%, transparent\)/)
    expect(TOKENS.spacing).toMatch(/--glow-accent-strong:\s*0 2px 8px color-mix\(in srgb, var\(--acid\) 45%, transparent\)/)
    expect(TOKENS.spacing).toMatch(/--shadow-fab:\s*0 8px 24px color-mix\(in srgb, var\(--acid\) 45%, transparent\)/)
    expect(TOKENS.spacing).toMatch(/--shadow-tabbar:\s*0 10px 30px rgba\(0, 0, 0, 0\.35\)/)
  })

  it('declares glass blur + motion vars', () => {
    expect(TOKENS.spacing).toMatch(/--blur-glass:\s*blur\(20px\) saturate\(180%\)/)
    expect(TOKENS.spacing).toMatch(/--dur-fast:\s*180ms/)
    expect(TOKENS.spacing).toMatch(/--dur-base:\s*200ms/)
    expect(TOKENS.spacing).toMatch(/--ease-out:\s*ease-out/)
  })
})

describe('tokens/primitives.css — utility classes resolved off tokens', () => {
  // `.pl-chip` lives in shell.css (single home for its .repeat / .toggle
  // modifiers); the rest of the kit's primitives layer is here.
  it.each(['.eyebrow', '.meta', '.display', '.chip', '.chip-solid', '.btn-brutal', '.btn-ghost', '.btn-hot', '.cyber-input', '.cyber-checkbox', '.progress', '.divider'])(
    'declares %s',
    (selector) => {
      // `.mono` is bodyless (back-compat), so just require the selector exists.
      const re = new RegExp(`\\${selector}\\s*[\\{,]`)
      expect(TOKENS.primitives).toMatch(re)
    },
  )

  it('.cyber-checkbox tints from the live accent', () => {
    expect(TOKENS.primitives).toMatch(/\.cyber-checkbox[\s\S]*accent-color:\s*var\(--acid\)/)
  })
})

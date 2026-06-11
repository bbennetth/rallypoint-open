import { ACCENT_HEX, COLORS_ORDER, useThemeStore } from '../store/theme.js'

// Ink dual-axis theme picker: a 6-dot accent chip (taps → cycleColor) and a
// sun/moon mode chip (taps → toggleMode). Dot fills are the literal accent
// hexes so the swatch reads the same in either chassis; the live accent is
// outlined with --ink. Ported from the Planner design handoff (lib.jsx
// ThemeToggle) and promoted here as the canonical chrome control.
//
// When rendered inside a role="menu" container, pass `inMenu` to give each chip
// a menuitem-family role per ARIA 1.2 §menu (every interactive descendant of a
// menu must be a menuitem/menuitemcheckbox/menuitemradio). The chips aren't a
// single-select radio group: the accent chip cycles colors (an action →
// menuitem) and the mode chip toggles a binary light/dark state
// (menuitemcheckbox, checked when dark). Default rendering is unchanged.

export interface ThemeToggleProps {
  /**
   * Set to true when ThemeToggle is rendered inside a role="menu" container.
   * Gives each chip a menuitem-family role so the menu satisfies ARIA 1.2
   * §menu (no bare <button> interactive descendants).
   */
  inMenu?: boolean
}

function SunGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  )
}

function MoonGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  )
}

export function ThemeToggle({ inMenu = false }: ThemeToggleProps) {
  const mode = useThemeStore((s) => s.mode)
  const color = useThemeStore((s) => s.color)
  const cycleColor = useThemeStore((s) => s.cycleColor)
  const toggleMode = useThemeStore((s) => s.toggleMode)

  // In a menu context the accent chip is an action (cycles the accent), so it
  // reads as a plain menuitem; the mode chip is a binary dark/light toggle, so
  // it reads as a menuitemcheckbox (checked when dark). Both keep the menu free
  // of bare interactive descendants per ARIA 1.2 §menu.
  const colorChip = (
    <button
      type="button"
      className="tt-chip"
      onClick={cycleColor}
      title="Accent color"
      aria-label="Cycle accent color"
      {...(inMenu ? { role: 'menuitem' as const } : {})}
    >
      {COLORS_ORDER.map((c) => (
        <span
          key={c}
          className="dot"
          aria-hidden
          style={{
            background: ACCENT_HEX[c],
            outline: color === c ? '1.5px solid var(--ink)' : '1.5px solid transparent',
          }}
        />
      ))}
    </button>
  )

  const modeChip = (
    <button
      type="button"
      className="tt-chip tt-chip--mode"
      onClick={toggleMode}
      title={mode === 'dark' ? 'Dark — tap for light' : 'Light — tap for dark'}
      aria-label={mode === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
      {...(inMenu ? { role: 'menuitemcheckbox' as const, 'aria-checked': mode === 'dark' } : {})}
    >
      {mode === 'dark' ? <SunGlyph /> : <MoonGlyph />}
    </button>
  )

  return (
    <span className="tt-row">
      {colorChip}
      {modeChip}
    </span>
  )
}

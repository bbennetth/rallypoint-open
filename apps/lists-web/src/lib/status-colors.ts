// Status color palette (RPL v1.0.0 S2). A status's `color` is a free-form
// key server-side ("the UI owns the palette"), so the mapping from key to
// CSS lives here. A chip is rendered with the hue as its border + text and
// a faint tint as its background; an unknown or null key falls back to a
// neutral chip so a hand-set color never breaks rendering.

export interface StatusColorStyle {
  borderColor: string
  color: string
  background: string
}

// Ordered for the swatch picker in the manage-statuses drawer. The first
// three (slate/amber/green) are the seeded defaults' colors.
export const STATUS_COLOR_KEYS = [
  'slate',
  'amber',
  'green',
  'sky',
  'blue',
  'violet',
  'pink',
  'rose',
  'red',
  'orange',
  'teal',
  'gray',
] as const

export type StatusColorKey = (typeof STATUS_COLOR_KEYS)[number]

// Mid-tone hues that read on both the light and dark Ink themes.
const PALETTE: Record<StatusColorKey, string> = {
  slate: '#64748b',
  amber: '#f59e0b',
  green: '#22c55e',
  sky: '#0ea5e9',
  blue: '#3b82f6',
  violet: '#8b5cf6',
  pink: '#ec4899',
  rose: '#f43f5e',
  red: '#ef4444',
  orange: '#f97316',
  teal: '#14b8a6',
  gray: '#6b7280',
}

// Resolve a palette key to its base hue, or null for an unknown/empty key.
export function statusHue(color: string | null | undefined): string | null {
  if (!color) return null
  return PALETTE[color as StatusColorKey] ?? null
}

// Chip styling for a status color. Unknown/null keys fall back to the
// neutral line/ink-dim theme tokens.
export function statusColorStyle(color: string | null | undefined): StatusColorStyle {
  const hue = statusHue(color)
  if (hue === null) {
    return {
      borderColor: 'var(--line)',
      color: 'var(--ink-dim)',
      background: 'var(--surface-2)',
    }
  }
  return {
    borderColor: hue,
    color: hue,
    background: `color-mix(in srgb, ${hue} 14%, transparent)`,
  }
}

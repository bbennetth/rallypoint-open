// Single source of truth for the product's brand strings. Imported by
// UI code (BrandLockup) and by each app's `vite.config.ts` to drive the
// HTML <title> and PWA manifest. Infrastructure identifiers (npm
// package names, Cloudflare slugs, DB names) are intentionally NOT
// wired through here — those are storage/deploy identities, not brand.

export const BRAND = {
  name: 'rallypoint',
  shortName: 'rallypt',
  // Long-form product name for prose/metadata. NOT the chrome lockup —
  // every app's header renders the two-tone `wordmark` split below.
  displayName: 'rallypoint',
  // Wordmark splits per the logo spec: "rally" in ink, "pt" in accent.
  wordmark: { primary: 'rally', accent: 'pt' },
  domain: 'rallypt.app',
  url: 'https://rallypt.app',
  tagline: 'Plan together, offline-ready',
  description: 'Collaborative group planning for festivals and events',
  // Palette — matches the theme tokens in `theme.css`. Use `BRAND.colors.*`
  // only when a hex literal is needed (inline SVG strokes, off-page
  // surfaces like manifest icons / og:image). CSS vars (`var(--acid)` etc.)
  // are preferred for in-page coloring.
  colors: {
    ink: '#0A0A0A',
    white: '#FFFFFF',
    gray100: '#F7F7F8',
    gray200: '#EEEEF0',
    gray300: '#E5E5E7',
    gray700: '#5A5A60',
    red: '#C8302B',
    // Default (dark chassis / blue accent) theme values — colors.css:29
    // (--bg) and colors.css:78 (--acid). For off-DOM rendering (canvas,
    // data-URL rasterization) where CSS custom properties don't resolve;
    // see brand-svg.ts. Kept in parity by tokens.test.ts.
    acid: '#0EA5E9',
    bg: '#0B1B2B',
  },
} as const

export type Brand = typeof BRAND

// The Rallypoint compass logo, copied verbatim from the design handoff:
// circle with tick marks, accent play-triangle, accent dot at NE. Used at
// 26px in the header and (stripped-down) as the 520px hero watermark.
export function Logo({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" aria-hidden="true">
      <circle cx="256" cy="256" r="200" stroke="currentColor" strokeWidth="16" fill="none" />
      <line x1="256" y1="40" x2="256" y2="74" stroke="currentColor" strokeWidth="16" strokeLinecap="round" />
      <line x1="256" y1="438" x2="256" y2="472" stroke="currentColor" strokeWidth="16" strokeLinecap="round" />
      <line x1="40" y1="256" x2="74" y2="256" stroke="currentColor" strokeWidth="16" strokeLinecap="round" />
      <line x1="438" y1="256" x2="472" y2="256" stroke="currentColor" strokeWidth="16" strokeLinecap="round" />
      <polygon points="343.1,168.9 183.73,258.41 253.59,328.27" fill="var(--acid)" />
      <circle cx="397.4" cy="114.6" r="24" fill="var(--acid)" />
      <circle cx="397.4" cy="114.6" r="10" fill="var(--bg)" />
    </svg>
  )
}

// Simplified circle + play mark for the home hero watermark (7% opacity,
// currentColor so the accent tint comes from the parent).
export function LogoWatermark({ size = 520 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" aria-hidden="true">
      <circle cx="256" cy="256" r="200" stroke="currentColor" strokeWidth="10" fill="none" />
      <polygon points="343.1,168.9 183.73,258.41 253.59,328.27" fill="currentColor" />
    </svg>
  )
}

import type { ReactNode } from 'react'

// Inline status banner — info / success / error. Themed via CSS vars so
// it inverts correctly in light mode. Used for form-level messages and
// transient notices.

export type BannerTone = 'info' | 'success' | 'error'

const TONE_COLOR: Record<BannerTone, string> = {
  info: 'var(--acid)',
  success: 'var(--map-highlight)',
  error: 'var(--hot)',
}

export interface BannerProps {
  tone?: BannerTone
  children: ReactNode
}

export function Banner({ tone = 'info', children }: BannerProps) {
  const color = TONE_COLOR[tone]
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className="mono"
      style={{
        border: `1.5px solid ${color}`,
        background: `color-mix(in srgb, ${color} 10%, transparent)`,
        color: 'var(--ink)',
        padding: '10px 12px',
        fontSize: 12,
        letterSpacing: '0.02em',
      }}
    >
      {children}
    </div>
  )
}

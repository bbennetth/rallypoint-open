import { useState } from 'react'
import { avatarBackground, initials, type InitialsInput } from '../lib/initials.js'

// User avatar — renders the uploaded image when `pictureUrl` is set,
// otherwise a deterministic initials swatch. Shared across every app's
// user chrome (account page, planner/events/money user bars). The
// fallback logic lives in `../lib/initials.ts` (pure, unit-tested).

export interface AvatarProps extends InitialsInput {
  pictureUrl?: string | null
  // Pixel diameter. Defaults to 32 (the user-bar size).
  size?: number
  className?: string
}

export function Avatar({ pictureUrl, size = 32, className, ...nameParts }: AvatarProps) {
  // If the image 404s / fails (e.g. a reaped object), fall back to
  // initials rather than a broken-image glyph.
  const [imgFailed, setImgFailed] = useState(false)

  const label = initials(nameParts)
  const seed =
    nameParts.name?.trim() ||
    [nameParts.firstName, nameParts.lastName].filter(Boolean).join(' ').trim() ||
    nameParts.email?.trim() ||
    label
  const showImage = pictureUrl && !imgFailed

  const base: React.CSSProperties = {
    width: size,
    height: size,
    borderRadius: '50%',
    flex: '0 0 auto',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    userSelect: 'none',
  }

  if (showImage) {
    return (
      <img
        src={pictureUrl}
        alt=""
        width={size}
        height={size}
        className={className}
        style={{ ...base, objectFit: 'cover' }}
        onError={() => setImgFailed(true)}
      />
    )
  }

  return (
    <span
      aria-hidden="true"
      className={className}
      style={{
        ...base,
        background: avatarBackground(seed),
        color: '#fff',
        fontFamily: 'var(--font-mono, monospace)',
        fontWeight: 700,
        fontSize: Math.round(size * 0.4),
        letterSpacing: '0.02em',
      }}
    >
      {label}
    </span>
  )
}

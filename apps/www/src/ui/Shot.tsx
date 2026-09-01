// Phone-framed screenshot slot. Real 390×844 captures ship under
// `/screens/*.webp`; pass `src` to render one edge-to-edge in the
// 22px-radius slot, and the slot falls back to a styled placeholder for
// any shot that hasn't been captured yet. Images lazy-load by default —
// pass `eager` for above-the-fold heroes, which are LCP candidates.
// `caption` adds the mono shot-cap line under the frame.
export function Shot({
  placeholder,
  src,
  caption,
  width,
  eager,
}: {
  /** Placeholder text shown until a real screenshot ships. Also the img alt. */
  placeholder: string
  src?: string
  caption?: string
  width?: number
  /** Load immediately instead of lazily — for above-the-fold hero shots. */
  eager?: boolean
}) {
  return (
    <div>
      <div className="phone" style={width ? { width } : undefined}>
        {src ? (
          <img
            className="slot"
            src={src}
            alt={placeholder}
            // Eager shots are LCP candidates: high fetch priority is the
            // lever that helps them, while async decoding only lets the
            // browser defer the paint — so it stays on the lazy shots.
            loading={eager ? 'eager' : 'lazy'}
            fetchPriority={eager ? 'high' : undefined}
            decoding={eager ? undefined : 'async'}
          />
        ) : (
          <div className="slot" aria-hidden>
            {placeholder}
          </div>
        )}
      </div>
      {caption && <span className="shot-cap">{caption}</span>}
    </div>
  )
}

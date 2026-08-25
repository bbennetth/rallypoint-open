// Phone-framed screenshot slot. Real 390×844 captures don't exist yet, so
// the slot renders a styled placeholder until a `src` is provided; drop
// real screenshots in by passing `src` (they render edge-to-edge in the
// 22px-radius slot). `caption` adds the mono shot-cap line under the frame.
export function Shot({
  placeholder,
  src,
  caption,
  width,
}: {
  /** Placeholder text shown until a real screenshot ships. Also the img alt. */
  placeholder: string
  src?: string
  caption?: string
  width?: number
}) {
  return (
    <div>
      <div className="phone" style={width ? { width } : undefined}>
        {src ? (
          <img className="slot" src={src} alt={placeholder} />
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

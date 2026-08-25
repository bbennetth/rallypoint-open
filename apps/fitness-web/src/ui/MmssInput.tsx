// Live microwave-style mm:ss input. While focused it keeps a digit
// buffer that fills positionally from the right (type 1 → 0:01,
// 10 → 0:10, 100 → 1:00) — the display is raw positional ("90" shows
// 0:90) so every keystroke is reversible; overflow seconds normalize on
// commit (0:90 → 1:30). Blur/Enter converts the buffer to seconds,
// clamps to maxS, and commits. Two value modes: default commits an
// "m:ss" STRING ('' = no prescription; callers parseMmss at save time,
// matching the composer's string-typed rest fields), while
// valueAsSeconds commits a plain seconds string ("60") for callers
// whose save path runs Number(...) on the field.

import { useRef, useState } from 'react'
import {
  formatMmss,
  mmssDigitsToDisplay,
  mmssDigitsToSeconds,
  mmssSeedDigits,
  mmssTextToDigits,
} from '@rallypoint/fitness-shared'

interface MmssInputProps {
  /** Current value ('' = no prescription). "m:ss" text by default; a
   *  plain seconds string when valueAsSeconds is set. */
  value: string
  onCommit: (v: string) => void
  /** Commit a plain seconds string ("60") instead of "m:ss" text. */
  valueAsSeconds?: boolean
  /** Ceiling in seconds (values clamp on commit). */
  maxS?: number
  placeholder?: string
  className?: string
  style?: React.CSSProperties
  'aria-label'?: string
  disabled?: boolean
}

export function MmssInput({
  value,
  onCommit,
  valueAsSeconds,
  maxS,
  placeholder = '1:30',
  className = 'pl-input',
  style,
  'aria-label': ariaLabel,
  disabled,
}: MmssInputProps) {
  const [digits, setDigits] = useState<string | null>(null) // null = not focused
  const inputRef = useRef<HTMLInputElement>(null)

  const restingText =
    valueAsSeconds && value !== '' ? formatMmss(Number(value)) : value

  const commit = () => {
    if (digits == null) return
    const parsed = mmssDigitsToSeconds(digits)
    const clamped =
      parsed == null ? null : maxS != null ? Math.min(maxS, parsed) : parsed
    const next =
      clamped == null ? '' : valueAsSeconds ? String(clamped) : formatMmss(clamped)
    setDigits(null)
    if (next !== value) onCommit(next)
  }

  // Pin the caret to the end — microwave digits only append/pop there.
  const pinCaret = () => {
    const el = inputRef.current
    if (!el) return
    const end = el.value.length
    if (el.selectionStart !== end || el.selectionEnd !== end) {
      el.setSelectionRange(end, end)
    }
  }

  return (
    <input
      ref={inputRef}
      className={className}
      style={style}
      type="text"
      inputMode="numeric"
      placeholder={placeholder}
      aria-label={ariaLabel}
      disabled={disabled}
      value={digits == null ? restingText : mmssDigitsToDisplay(digits)}
      onFocus={() => {
        // Seed (not the keystroke normalizer): an explicit zero value
        // must survive a no-edit focus/blur instead of erasing itself.
        setDigits(mmssSeedDigits(restingText))
        requestAnimationFrame(pinCaret)
      }}
      onChange={(e) => {
        setDigits(mmssTextToDigits(e.target.value))
        requestAnimationFrame(pinCaret)
      }}
      onSelect={pinCaret}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
      }}
    />
  )
}

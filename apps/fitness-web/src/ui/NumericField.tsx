// Controlled numeric input that owns a local STRING while focused and
// only commits a parsed number on blur/Enter (via useCommitOnBlurText).
// Kills the whole class of "can't delete the default" bugs caused by
// binding value={number} and re-coercing on every keystroke (erasing
// the field parses '' → 0 → clamp → the digit snaps right back).
//
// Semantics:
// - While focused, whatever the user types stays verbatim.
// - Blur/Enter parses: finite number → round to `decimals` → clamp to
//   [min, max] → onCommit; empty/garbage → onCommit(null) when
//   allowEmpty, else min ?? 0.

import { useCommitOnBlurText } from './useCommitOnBlurText.js'

interface NumericFieldProps {
  value: number | null
  onCommit: (v: number | null) => void
  /** Blank/garbage commits null instead of min. */
  allowEmpty?: boolean
  min?: number
  max?: number
  /** Round the committed value to this many decimals (default 0 =
   *  integers; pass e.g. 1 for half-steps via step 0.5 + rounding). */
  decimals?: number
  step?: number | string
  placeholder?: string
  className?: string
  style?: React.CSSProperties
  'aria-label'?: string
  disabled?: boolean
  inputMode?: 'numeric' | 'decimal'
}

function toText(v: number | null): string {
  return v == null ? '' : String(v)
}

export function NumericField({
  value,
  onCommit,
  allowEmpty = false,
  min,
  max,
  decimals = 0,
  step,
  placeholder,
  className = 'pl-input',
  style,
  'aria-label': ariaLabel,
  disabled,
  inputMode,
}: NumericFieldProps) {
  function parse(raw: string): number | null {
    const t = raw.trim()
    if (t === '') return allowEmpty ? null : (min ?? 0)
    const n = Number(t)
    if (!Number.isFinite(n)) return allowEmpty ? null : (min ?? 0)
    const factor = 10 ** decimals
    let v = Math.round(n * factor) / factor
    if (min != null) v = Math.max(min, v)
    if (max != null) v = Math.min(max, v)
    return v
  }

  const { inputProps } = useCommitOnBlurText({
    value: toText(value),
    onCommit: (next) => onCommit(next === '' ? null : Number(next)),
    normalize: (raw) => toText(parse(raw)),
  })

  return (
    <input
      className={className}
      style={style}
      type="number"
      inputMode={inputMode}
      step={step}
      placeholder={placeholder}
      aria-label={ariaLabel}
      disabled={disabled}
      {...inputProps}
    />
  )
}

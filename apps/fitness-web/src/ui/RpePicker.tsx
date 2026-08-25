// RPE 1–10 picker per the design handoff (live.jsx RpePicker): ten
// equal-flex mono buttons; the selected value and everything below it
// get the accent wash + acid border, the selected value itself reads
// in acid at weight 700. Styled via `.rpe-seg` in fitness.css (shares
// the `.fit-seg` geometry) so the buttons pick up the coarse-pointer
// tap floor instead of hand-rolled inline styles.

interface RpePickerProps {
  value: number | null
  onChange: (value: number) => void
}

export function RpePicker({ value, onChange }: RpePickerProps) {
  const v = value ?? 0
  return (
    <div className="rpe-seg" role="group" aria-label="RPE">
      {Array.from({ length: 10 }, (_x, i) => i + 1).map((n) => (
        <button
          key={n}
          type="button"
          aria-label={`RPE ${n}`}
          aria-pressed={n === v}
          className={(n <= v ? 'fill' : '') + (n === v ? ' on' : '')}
          onClick={() => onChange(n)}
        >
          {n}
        </button>
      ))}
    </div>
  )
}

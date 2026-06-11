// A 3- or 4-segment LOW/MED/HIGH priority control, reusing the shared `.seg`
// style. `value` is the Lists priority string ('low' | 'medium' | 'high') or
// null for no priority. The active segment is highlighted. Calls `onChange`
// with the tapped segment's value; the caller treats same-value taps as no-ops.
//
// When `allowClear` is true a leading NONE segment is rendered and `onChange`
// may be called with null. When false (the default) only the three value
// segments are shown and clearing is not possible.

const VALUE_OPTIONS: { value: 'low' | 'medium' | 'high'; label: string }[] = [
  { value: 'low', label: 'LOW' },
  { value: 'medium', label: 'MED' },
  { value: 'high', label: 'HIGH' },
]

export function PriorityPicker({
  value,
  onChange,
  disabled,
  allowClear = false,
}: {
  value: string | null
  onChange: (priority: 'low' | 'medium' | 'high' | null) => void
  disabled?: boolean
  allowClear?: boolean
}) {
  const current = value ? value.toLowerCase() : null
  return (
    <div className="seg" role="group" aria-label="Priority">
      {allowClear && (
        <button
          key="none"
          type="button"
          className={current === null ? 'on' : ''}
          aria-pressed={current === null}
          disabled={disabled}
          onClick={() => onChange(null)}
        >
          NONE
        </button>
      )}
      {VALUE_OPTIONS.map((o) => (
        <button
          key={o.value}
          type="button"
          className={current === o.value ? 'on' : ''}
          aria-pressed={current === o.value}
          disabled={disabled}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

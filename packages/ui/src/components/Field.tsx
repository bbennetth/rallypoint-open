import { useId, type InputHTMLAttributes, type ReactNode } from 'react'

// Labeled text input using the Rallypoint Minimal `.cyber-input`. A sentence-case label
// sits above the field; an optional error (red) or hint (muted) line sits below.
// Forwards all native input props; generates an id so the <label> is associated for a11y.

export interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> {
  label: ReactNode
  error?: string
  hint?: string
}

export function Field({ label, error, hint, className, ...rest }: FieldProps) {
  const id = useId()
  const describedById = `${id}-desc`
  const inputCls = className ? `cyber-input ${className}` : 'cyber-input'
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <label
        htmlFor={id}
        style={{
          fontSize: 12,
          fontWeight: 500,
          color: 'var(--ink)',
        }}
      >
        {label}
      </label>
      <input
        id={id}
        className={inputCls}
        aria-invalid={error ? true : undefined}
        aria-describedby={error || hint ? describedById : undefined}
        {...rest}
      />
      {error ? (
        <span id={describedById} style={{ fontSize: 12, color: 'var(--hot)' }}>
          {error}
        </span>
      ) : hint ? (
        <span id={describedById} style={{ fontSize: 12, color: 'var(--ink-mute)' }}>
          {hint}
        </span>
      ) : null}
    </div>
  )
}

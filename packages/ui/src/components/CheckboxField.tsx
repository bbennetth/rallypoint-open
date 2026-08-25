import { useId, type InputHTMLAttributes, type ReactNode } from 'react'

export interface CheckboxFieldProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'id' | 'type'
> {
  label: ReactNode
  hint?: string
  error?: string
}

/** A controlled-or-uncontrolled native checkbox with Ink field chrome. */
export function CheckboxField({ label, hint, error, className, ...rest }: CheckboxFieldProps) {
  const id = useId()
  const descriptionId = `${id}-description`
  const inputClass = className ? `cyber-checkbox ${className}` : 'cyber-checkbox'

  return (
    <div className="checkbox-field">
      <label className="checkbox-field__control" htmlFor={id}>
        <input
          {...rest}
          id={id}
          type="checkbox"
          className={inputClass}
          aria-invalid={error ? true : undefined}
          aria-describedby={error || hint ? descriptionId : undefined}
        />
        <span>{label}</span>
      </label>
      {error ? (
        <span id={descriptionId} className="checkbox-field__message checkbox-field__message--error">
          {error}
        </span>
      ) : hint ? (
        <span id={descriptionId} className="checkbox-field__message">
          {hint}
        </span>
      ) : null}
    </div>
  )
}

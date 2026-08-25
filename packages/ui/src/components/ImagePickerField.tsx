import { useEffect, useId, useState } from 'react'
import { useFilePicker } from '../hooks/useFilePicker.js'
import { Button } from './Button.js'
import { Icon } from './icons.js'

export type ImagePickerVariant = 'card' | 'tile'
export type ImagePickerStatus = 'idle' | 'working' | 'success' | 'error'

export interface ImagePickerFieldProps {
  label: string
  hint?: string | undefined
  required?: boolean
  file: File | null
  onChange: (file: File | null) => void
  error?: string | undefined
  disabled?: boolean
  variant?: ImagePickerVariant | undefined
  status?: ImagePickerStatus | undefined
  accept?: string | undefined
}

/**
 * Controlled image picker. One "Add photo" button opening the OS chooser —
 * which offers Take Photo / Photo Library itself, so reproducing that split
 * in-app would only cost a tap. Object URLs belong to this component and are
 * revoked whenever the controlled file changes or the field unmounts; the
 * input value is reset so the same file can be selected again after
 * replacement/removal.
 */
export function ImagePickerField({
  label,
  hint,
  required = false,
  file,
  onChange,
  error,
  disabled = false,
  variant = 'card',
  status = error ? 'error' : file ? 'success' : 'idle',
  accept = 'image/*',
}: ImagePickerFieldProps) {
  const id = useId()
  const descriptionId = `${id}-description`
  const [preview, setPreview] = useState<string | null>(null)
  const busy = status === 'working'
  const picker = useFilePicker({
    onPick: onChange,
    accept,
    ariaLabel: `${label}: add a photo`,
    disabled: disabled || busy,
    required,
  })

  useEffect(() => {
    if (!file) {
      setPreview(null)
      return
    }
    const url = URL.createObjectURL(file)
    setPreview(url)
    return () => URL.revokeObjectURL(url)
  }, [file])

  const describedBy = error || hint ? descriptionId : undefined
  const stateLabel =
    status === 'working'
      ? 'Working'
      : status === 'success'
        ? 'Selected'
        : status === 'error'
          ? 'Needs attention'
          : 'No image selected'

  return (
    <fieldset
      className={`image-picker image-picker--${variant} image-picker--${status}${
        file ? '' : ' image-picker--empty'
      }`}
      disabled={disabled}
      aria-describedby={describedBy}
      aria-invalid={error ? true : undefined}
    >
      <legend className="image-picker__label">
        {label}
        {required ? <span aria-hidden> *</span> : null}
        {required ? <span className="sr-only"> (required)</span> : null}
      </legend>

      <div className="image-picker__surface">
        {preview ? (
          <img className="image-picker__preview" src={preview} alt="" />
        ) : (
          <span className="image-picker__placeholder" aria-hidden>
            <Icon name="file" size={variant === 'tile' ? 20 : 24} />
          </span>
        )}
        <span className="image-picker__state" aria-live="polite">
          {busy ? <span className="image-picker__spinner" aria-hidden /> : null}
          {/* No room for the words beside a 56px thumb, so the card variant
              hides them — but only visually: the live region and the
              spinner stay, and screen readers still get the update. */}
          <span className={variant === 'card' ? 'sr-only' : undefined}>{stateLabel}</span>
        </span>
      </div>

      <div className="image-picker__actions">
        <Button variant="ghost" onClick={picker.open} disabled={disabled || busy}>
          {file ? 'Replace photo' : 'Add photo'}
        </Button>
        {file ? (
          <Button variant="ghost" onClick={() => onChange(null)} disabled={disabled || busy}>
            Remove
          </Button>
        ) : null}
      </div>

      {picker.input}

      {error ? (
        <span id={descriptionId} className="image-picker__message image-picker__message--error">
          {error}
        </span>
      ) : hint ? (
        <span id={descriptionId} className="image-picker__message">
          {hint}
        </span>
      ) : null}
    </fieldset>
  )
}

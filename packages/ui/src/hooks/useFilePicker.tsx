// Hidden-file-input primitive shared by every capture surface (menu rows,
// FABs, ImagePickerField). It exists to make "one tap opens the OS picker"
// safe to write: the caller owns the button markup, this owns the input and
// the two rules that are easy to get wrong (see `open` and `input` below).
//
// Deliberately no `capture` attribute and no prop for one. Bare
// `accept="image/*"` makes iOS Safari and Android Chrome show their own
// Take Photo / Photo Library / Browse chooser — one tap, and the user keeps
// both sources. `capture="environment"` jumps straight to the camera and
// REMOVES the library, which is strictly worse for a general "add a photo".

import { useRef, type ReactElement } from 'react'

export interface UseFilePickerOptions {
  // Called with the first selected file. Never called with null — a
  // cancelled picker fires no change event at all.
  onPick: (file: File) => void
  accept?: string | undefined
  // Accessible name for the hidden input. Give each picker a distinct one
  // when a component renders more than one.
  ariaLabel?: string | undefined
  disabled?: boolean | undefined
  // Mirrors the owning field's required state onto the input for a11y.
  required?: boolean | undefined
}

export interface FilePicker {
  /**
   * Opens the OS picker.
   *
   * MUST be called synchronously from inside a user-gesture handler (an
   * `onClick` body). Any `await`, `setTimeout`, or post-render effect
   * between the gesture and this call drops Safari's user-activation token
   * and the picker silently never opens. If you need to navigate as well,
   * call `open()` FIRST and navigate from `onPick`.
   */
  open: () => void
  /**
   * Render this ONCE and UNCONDITIONALLY in the component that owns the
   * trigger.
   *
   * Never place it inside a `{menuOpen && …}` branch: menus close on pick,
   * and an unmounted input never fires `change`, so the user picks a photo
   * and nothing happens. That failure is invisible on desktop (where the
   * picker resolves fast) and reproducible on a phone.
   */
  input: ReactElement
}

export function useFilePicker({
  onPick,
  accept = 'image/*',
  ariaLabel = 'Choose a file',
  disabled = false,
  required = false,
}: UseFilePickerOptions): FilePicker {
  const ref = useRef<HTMLInputElement | null>(null)

  return {
    open: () => {
      if (!disabled) ref.current?.click()
    },
    input: (
      <input
        ref={ref}
        className="sr-only"
        type="file"
        accept={accept}
        aria-label={ariaLabel}
        aria-required={required}
        disabled={disabled}
        onChange={(event) => {
          const next = event.currentTarget.files?.[0] ?? null
          // Browsers suppress `change` for the same path unless the native
          // value is cleared after every selection — reset before handing
          // off so a re-pick of the same file still fires.
          event.currentTarget.value = ''
          if (next) onPick(next)
        }}
      />
    ),
  }
}

// The commit-on-blur buffering contract shared by NumericField and
// MmssInput: own a local STRING while focused (so typing never snaps
// back), resync from the committed prop while unfocused, and normalize
// + commit on blur or Enter. The components supply only their
// parse/format/clamp logic via `normalize`.

import { useEffect, useRef, useState } from 'react'

export function useCommitOnBlurText({
  value,
  onCommit,
  normalize,
}: {
  /** The committed text (already formatted by the owner). */
  value: string
  /** Called with the normalized text when it differs from `value`. */
  onCommit: (next: string) => void
  /** Turn whatever the user typed into committed text. */
  normalize: (raw: string) => string
}) {
  const [text, setText] = useState(value)
  const [focused, setFocused] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  // Resync from props while not being edited (an external update or a
  // unit toggle changed the committed value).
  useEffect(() => {
    if (!focused) setText(value)
  }, [value, focused])

  function commit() {
    const next = normalize(text)
    setText(next)
    if (next !== value) onCommit(next)
  }

  return {
    inputRef,
    inputProps: {
      ref: inputRef,
      value: text,
      onChange: (e: React.ChangeEvent<HTMLInputElement>) => setText(e.target.value),
      onFocus: () => setFocused(true),
      onBlur: () => {
        setFocused(false)
        commit()
      },
      onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') {
          commit()
          inputRef.current?.blur()
        }
      },
    },
  }
}

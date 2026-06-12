// Shared multi-select for the desktop power UI (RPL v1.0.0 S6). The range
// math is a pure function (unit-tested); the hook is a thin state wrapper
// the checklist, grid, and board all share so selection behaves identically
// across views.

import { useCallback, useRef, useState } from 'react'

// The inclusive id range between `anchorId` and `targetId` in the current
// visible order — the set a shift-click adds. Order-independent (anchor may
// be above or below the target). If either id isn't in `orderedIds`, falls
// back to just the target (or empty when the target is gone too).
export function selectionRange(
  orderedIds: readonly string[],
  anchorId: string,
  targetId: string,
): string[] {
  const a = orderedIds.indexOf(anchorId)
  const b = orderedIds.indexOf(targetId)
  if (a === -1 || b === -1) return orderedIds.includes(targetId) ? [targetId] : []
  const [lo, hi] = a <= b ? [a, b] : [b, a]
  return orderedIds.slice(lo, hi + 1)
}

export interface SelectionApi {
  selected: Set<string>
  count: number
  isSelected: (id: string) => boolean
  // Plain toggle (checkbox change / keyboard x). `on` forces the state;
  // omitted flips it. Updates the range anchor to this id.
  toggle: (id: string, on?: boolean) => void
  // Shift-click: extend the selection to the inclusive range from the
  // anchor to `id` within `orderedIds`. With no anchor yet, behaves as a
  // plain toggle.
  extendTo: (id: string, orderedIds: readonly string[]) => void
  // Replace the whole selection (select-all / select-none in a view).
  replace: (ids: Iterable<string>) => void
  clear: () => void
}

export function useSelection(): SelectionApi {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const anchor = useRef<string | null>(null)

  const toggle = useCallback((id: string, on?: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev)
      const shouldSelect = on ?? !next.has(id)
      if (shouldSelect) next.add(id)
      else next.delete(id)
      return next
    })
    anchor.current = id
  }, [])

  const extendTo = useCallback((id: string, orderedIds: readonly string[]) => {
    if (anchor.current === null) {
      toggle(id)
      return
    }
    const range = selectionRange(orderedIds, anchor.current, id)
    setSelected((prev) => new Set([...prev, ...range]))
    // Anchor stays put so successive shift-clicks grow from the same origin.
  }, [toggle])

  const replace = useCallback((ids: Iterable<string>) => {
    const set = new Set(ids)
    setSelected(set)
    anchor.current = null
  }, [])

  const clear = useCallback(() => {
    setSelected(new Set())
    anchor.current = null
  }, [])

  const isSelected = useCallback((id: string) => selected.has(id), [selected])

  // The returned object is a fresh literal each render — do NOT put the whole
  // `selection` value in a useEffect dep array (it would loop). Depend on
  // `selection.selected` for data, or call the stable methods directly.
  return { selected, count: selected.size, isSelected, toggle, extendTo, replace, clear }
}

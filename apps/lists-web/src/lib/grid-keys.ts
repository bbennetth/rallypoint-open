// Pure keyboard-shortcut decision for the grid view (Lists v2 slice 7).
// Maps a keydown to a navigation/selection/edit action against the current
// active-row state, clamping at the list bounds. The component owns DOM
// concerns (ignoring keystrokes while a cell control has focus, focusing a
// title input on edit); this stays pure so the j/k/x/e contract is unit-
// tested without a DOM.

export type GridKeyAction =
  | { type: 'move'; row: number }
  | { type: 'select' }
  | { type: 'edit' }
  | { type: 'none' }

export function gridKeyAction(
  key: string,
  state: { activeRow: number; rowCount: number },
): GridKeyAction {
  const { activeRow, rowCount } = state
  if (rowCount <= 0) return { type: 'none' }
  switch (key) {
    case 'j':
      return { type: 'move', row: Math.min(activeRow + 1, rowCount - 1) }
    case 'k':
      // A negative/unset active row resolves to the first row on first nav.
      return { type: 'move', row: Math.max(Math.min(activeRow, rowCount - 1) - 1, 0) }
    case 'x':
      return activeRow >= 0 && activeRow < rowCount ? { type: 'select' } : { type: 'none' }
    case 'e':
      return activeRow >= 0 && activeRow < rowCount ? { type: 'edit' } : { type: 'none' }
    default:
      return { type: 'none' }
  }
}

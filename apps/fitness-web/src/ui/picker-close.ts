// Pure close-decision logic for ExercisePicker's dropdown, extracted so
// it can be unit-tested without a DOM.
//
// The dropdown must survive an on-screen-keyboard dismissal: on iOS,
// tapping the keyboard's "done"/collapse blurs the input with no focus
// destination (`relatedTarget === null`), and closing there hides the
// results the user was about to read. So blur alone only closes the
// dropdown when focus verifiably moved to an element *outside* the
// picker; the null-target case stays open and outside taps are handled
// by a document-level pointerdown listener instead.

/** Should an input blur close the dropdown?
 *  - No relatedTarget (keyboard dismissed, window blur): keep open.
 *  - Focus moved inside the picker container: keep open.
 *  - Focus moved elsewhere (tab / tap into another field): close. */
export function shouldCloseOnBlur(
  hasRelatedTarget: boolean,
  relatedTargetInsideContainer: boolean,
): boolean {
  return hasRelatedTarget && !relatedTargetInsideContainer
}

/** Should a document-level pointerdown close the dropdown?
 *  Any press outside the picker container closes it; presses inside
 *  (input, option rows, scrollbar) keep it open. */
export function shouldCloseOnOutsidePointerDown(targetInsideContainer: boolean): boolean {
  return !targetInsideContainer
}

/** Should the input's focus event open the dropdown?
 *  No when the focus is the one `pick()` puts back after a selection —
 *  `.focus()` dispatches focusin synchronously, so treating that as a
 *  user focus would re-open the dropdown being closed (same React
 *  batch, last write wins) and re-scroll the row on every pick. */
export function shouldOpenOnFocus(restoringFocusAfterPick: boolean): boolean {
  return !restoringFocusAfterPick
}

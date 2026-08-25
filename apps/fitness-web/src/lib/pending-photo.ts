// Take-once handoff for a photo picked on one route and consumed on
// another.
//
// The entry-point FABs live in the sub-bars of /log, /plan, /library and
// /stats, so "Snap a meal" must open the OS picker THERE (the input.click()
// has to be synchronous inside the onClick or Safari drops the
// user-activation token) and only navigate once a file comes back. That
// leaves the file needing to cross a route change, which this slot does.
//
// Module scope, not sessionStorage: a File isn't serializable, and a hard
// reload legitimately loses the pick.

export type PendingPhotoKind = 'meal' | 'board'

let slot: { kind: PendingPhotoKind; file: File } | null = null

export function stashPendingPhoto(kind: PendingPhotoKind, file: File): void {
  slot = { kind, file }
}

/** Reads and clears the slot. Returns null when empty or when the stashed
 *  photo was for a different destination — a kind mismatch leaves the slot
 *  intact so the intended consumer can still claim it. */
export function takePendingPhoto(kind: PendingPhotoKind): File | null {
  if (!slot || slot.kind !== kind) return null
  const { file } = slot
  slot = null
  return file
}

// Test-only: module scope outlives a jsdom cleanup().
export function clearPendingPhoto(): void {
  slot = null
}

// A tiny window-event bus so the global quick-add FAB can tell a live page
// to refetch after it creates something. There's no shared query cache in
// planner-web (pages own their own state and refetch on mount), so when the
// FAB creates a task / event / note / chore / diary entry while a relevant
// page is already mounted, it dispatches here and the page re-pulls. Pages not
// mounted simply refetch on their next visit — so this is a best-effort
// freshness nudge, not a correctness dependency.

export type CreatedKind = 'task' | 'event' | 'note' | 'shopping' | 'chore' | 'diary'

const EVENT = 'planner:created'

export function notifyCreated(kind: CreatedKind): void {
  window.dispatchEvent(new CustomEvent<CreatedKind>(EVENT, { detail: kind }))
}

// Subscribe to creations of a given kind; returns an unsubscribe fn suitable
// for a useEffect cleanup.
export function onCreated(kind: CreatedKind, handler: () => void): () => void {
  const listener = (e: Event) => {
    if ((e as CustomEvent<CreatedKind>).detail === kind) handler()
  }
  window.addEventListener(EVENT, listener)
  return () => window.removeEventListener(EVENT, listener)
}

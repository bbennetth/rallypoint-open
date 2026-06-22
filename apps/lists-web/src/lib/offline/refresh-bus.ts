// Tiny pub/sub the offline layer uses to tell pages "revalidate now". The
// outbox flusher publishes here after it drains (so the page refetches and
// reconciles temp ids to real ones); pages subscribe via `subscribeRefresh`.
// Ported from events-web's identical bus — no payload, no per-key targeting.

type Listener = () => void
const listeners = new Set<Listener>()

export function publishRefresh(): void {
  for (const l of [...listeners]) {
    try {
      l()
    } catch {
      // A misbehaving subscriber must not strand its siblings.
    }
  }
}

export function subscribeRefresh(fn: Listener): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

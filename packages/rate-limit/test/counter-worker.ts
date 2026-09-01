// Minimal Worker entry for the RateLimitCounter Durable Object tests. The
// vitest-pool-workers config binds `COUNTER` to this script's
// RateLimitCounter export; the tests drive the DO via env.COUNTER directly,
// so the default fetch is just a stub.
export { RateLimitCounter } from '../src/do.js'

export default {
  fetch(): Response {
    return new Response('rate-limit counter test worker')
  },
}

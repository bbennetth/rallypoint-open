// Minimal Worker entry for the RealtimeHub Durable Object tests. The
// vitest-pool-workers config binds `HUB` to this script's RealtimeHub
// export; the tests drive the DO via env.HUB directly, so the default
// fetch is just a stub.
export { RealtimeHub } from '../src/hub.js'

export default {
  fetch(): Response {
    return new Response('realtime hub test worker')
  },
}

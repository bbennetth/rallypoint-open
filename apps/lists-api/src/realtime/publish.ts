import type { Context } from 'hono'
import type { RealtimeEnvelope } from '@rallypoint/realtime'
import type { HonoApp } from '../context.js'

// Best-effort publish: realtime is a convenience layer, so a NOTIFY
// failure must never fail the mutation that triggered it. Fire-and-forget
// and log on error; the client refetches on reconnect to converge anyway.
export function publish(c: Context<HonoApp>, channel: string, env: RealtimeEnvelope): void {
  // try/catch guards a bus that throws synchronously; the .catch guards the
  // async rejection. Either way the triggering mutation response is unaffected.
  try {
    void c.var.realtime.publish(channel, env).catch((err: unknown) => {
      c.var.logger.warn({ err, channel }, 'realtime publish failed')
    })
  } catch (err) {
    c.var.logger.warn({ err, channel }, 'realtime publish failed')
  }
}

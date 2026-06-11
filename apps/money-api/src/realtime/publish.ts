import type { Context } from 'hono'
import type { RealtimeEnvelope } from '@rallypoint/realtime'
import type { HonoApp } from '../context.js'

// Best-effort publish: realtime is a convenience layer, so a NOTIFY
// failure must never fail the mutation that triggered it.
export function publish(c: Context<HonoApp>, channel: string, env: RealtimeEnvelope): void {
  try {
    void c.var.realtime.publish(channel, env).catch((err: unknown) => {
      c.var.logger.warn({ err, channel }, 'realtime publish failed')
    })
  } catch (err) {
    c.var.logger.warn({ err, channel }, 'realtime publish failed')
  }
}

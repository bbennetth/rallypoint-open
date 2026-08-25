// Shared Workers AI call options. Both vision passes (the WOD whiteboard
// scan and the food-photo scan) run through `env.AI.run(model, input,
// options)`; when the deployment sets AI_GATEWAY_ID the third arg routes
// the inference through a Cloudflare AI Gateway (logging, caching, rate
// limiting, cost visibility). Dev leaves it unset → `undefined`, which is
// byte-for-byte the same as the pre-gateway two-arg call.

export interface AiRunOptions {
  gateway: { id: string }
}

/** Build the AI Gateway option block, or `undefined` when no gateway is
 *  configured (so `ai.run(model, input, undefined)` === the old behavior). */
export function aiGatewayOptions(gatewayId?: string): AiRunOptions | undefined {
  const id = gatewayId?.trim()
  return id ? { gateway: { id } } : undefined
}

// Pure MCP-token status (RPL v1.0.0 S11 UI). Revocation wins over expiry;
// a null expiry never expires. `nowMs` is injected for deterministic tests.

import type { McpTokenDto } from './api.js'

export type TokenStatus = 'active' | 'revoked' | 'expired'

export function tokenStatus(token: McpTokenDto, nowMs: number): TokenStatus {
  if (token.revoked_at !== null) return 'revoked'
  if (token.expires_at !== null && Date.parse(token.expires_at) <= nowMs) return 'expired'
  return 'active'
}

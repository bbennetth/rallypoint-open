// Build + send a Web Push request for one subscription. `buildPushRequest`
// returns the wire request (so callers can inspect or batch it); `sendPush`
// dispatches it and classifies the response.

import { base64UrlToBytes, type Bytes } from './base64url.js'
import { encryptPayload, type EncryptInput } from './encrypt.js'
import { signVapidJwt, type VapidKeys } from './vapid.js'

export interface WebPushSubscription {
  endpoint: string
  keys: { p256dh: string; auth: string }
}

export interface BuildPushRequestOptions {
  subscription: WebPushSubscription
  payload: string | Bytes
  vapid: VapidKeys
  /** Push-service retention if the device is offline. Default 28 days. */
  ttlSeconds?: number
  urgency?: 'very-low' | 'low' | 'normal' | 'high'
  /** Optional collapse key — a newer message with the same topic replaces it. */
  topic?: string
  // Deterministic-test injection, forwarded downstream.
  salt?: Bytes
  serverKeyPair?: CryptoKeyPair
  now?: number
}

export interface PreparedPushRequest {
  endpoint: string
  headers: Record<string, string>
  body: Bytes
}

export async function buildPushRequest(
  opts: BuildPushRequestOptions,
): Promise<PreparedPushRequest> {
  const payload =
    typeof opts.payload === 'string' ? new TextEncoder().encode(opts.payload) : opts.payload
  const encryptInput: EncryptInput = {
    uaPublicKey: base64UrlToBytes(opts.subscription.keys.p256dh),
    authSecret: base64UrlToBytes(opts.subscription.keys.auth),
    payload,
    ...(opts.salt ? { salt: opts.salt } : {}),
    ...(opts.serverKeyPair ? { serverKeyPair: opts.serverKeyPair } : {}),
  }
  const { body } = await encryptPayload(encryptInput)

  const url = new URL(opts.subscription.endpoint)
  const jwt = await signVapidJwt({
    audience: `${url.protocol}//${url.host}`,
    keys: opts.vapid,
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  })

  const headers: Record<string, string> = {
    authorization: `vapid t=${jwt}, k=${opts.vapid.publicKey}`,
    'content-encoding': 'aes128gcm',
    'content-type': 'application/octet-stream',
    ttl: String(opts.ttlSeconds ?? 2_419_200),
    urgency: opts.urgency ?? 'normal',
  }
  if (opts.topic) headers.topic = opts.topic

  return { endpoint: opts.subscription.endpoint, headers, body }
}

export interface SendPushOptions extends BuildPushRequestOptions {
  fetch?: typeof globalThis.fetch
}

export interface SendPushResult {
  ok: boolean
  statusCode: number
  /** 404/410 — the subscription is gone; the caller should delete it. */
  expired: boolean
}

export async function sendPush(opts: SendPushOptions): Promise<SendPushResult> {
  const prepared = await buildPushRequest(opts)
  const fetchFn = opts.fetch ?? globalThis.fetch
  const res = await fetchFn(prepared.endpoint, {
    method: 'POST',
    headers: prepared.headers,
    body: prepared.body,
  })
  return {
    ok: res.ok,
    statusCode: res.status,
    // 410 Gone is the definitive "subscription expired"; 404 Not Found is
    // treated the same (the endpoint no longer exists) — the conservative,
    // widely-adopted rule. The caller deletes the subscription on `expired`.
    expired: res.status === 404 || res.status === 410,
  }
}

import { z } from 'zod'

// Shared pagination toolkit for the HTTP APIs (epic: unify the five drifted
// pagination shapes onto one wire contract). Before this module every app
// hand-rolled its own request parsing, cursor encoding, and response shape:
// events-api alone had three (zod {limit,cursor}, hand-rolled Number(), and a
// before-keyset), admin-api took a cursor from a POST body, and fitness-api
// emitted camelCase {photos,nextBefore,nextBeforeId}. This is the single
// source of truth for:
//
//   - the ONE request shape:  { limit?, cursor? }
//   - the ONE response shape: { items, next_cursor }   (snake_case)
//   - one opaque, tamper-evident cursor codec (base64url JSON, versioned)
//
// The codec is deliberately opaque so clients can never again build code that
// depends on a cursor's internal `<iso>|<id>` structure — the mistake that let
// every endpoint's format drift. Endpoints migrating off a legacy format pass a
// per-endpoint `legacy` parser so in-flight cursors (and stale SPA bundles)
// keep working through the transition; the server only ever EMITS the opaque v1
// form.
//
// No `Buffer` here — the module runs in the plain-node vitest pool as well as
// workerd, so base64url goes through the `btoa`/`atob` globals (present in both)
// with a UTF-8 bridge, not the Node-only Buffer API.

// --- base64url (UTF-8 safe, no padding) -------------------------------------

function bytesToBase64url(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64urlToBytes(raw: string): Uint8Array {
  const b64 = raw.replace(/-/g, '+').replace(/_/g, '/')
  // atob tolerates missing padding in workerd/node, but restore it anyway so
  // the input is canonical base64 before decoding.
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
  const bin = atob(padded) // throws on invalid base64 — caller catches
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

// --- cursor codec -----------------------------------------------------------

/** The decoded key inside a cursor — an ordered tuple of JSON scalars matching
 *  the endpoint's keyset columns, e.g. `[isoTimestamp, id]` or `[position, id]`. */
export type CursorKey = (string | number)[]

/** base64url(JSON.stringify({ v: 1, k: key })), no padding. Opaque to clients. */
export function encodeCursor(key: CursorKey): string {
  const json = JSON.stringify({ v: 1, k: key })
  return bytesToBase64url(new TextEncoder().encode(json))
}

/** Strict v1 decode: base64url → JSON → validated `{ v: 1, k: scalar[] }`.
 *  Returns null on ANY failure (tamper, wrong/absent version, non-array `k`,
 *  non-scalar element) and never throws. Legacy (non-v1) cursor strings that
 *  are valid base64url but not our JSON envelope also decode to null here, so
 *  callers can cleanly fall through to a per-endpoint legacy parser. */
export function decodeCursorStrict(raw: string): CursorKey | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(base64urlToBytes(raw)))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const env = parsed as { v?: unknown; k?: unknown }
  if (env.v !== 1 || !Array.isArray(env.k)) return null
  for (const el of env.k) {
    if (typeof el !== 'string' && typeof el !== 'number') return null
  }
  return env.k as CursorKey
}

/** Typed cursor codec for one endpoint. `decode` tries the opaque v1 form
 *  first and, only if that is not a v1 envelope, the optional `legacy` parser. */
export interface CursorCodec<T> {
  encode(value: T): string
  decode(raw: string): T | null
}

export function createCursorCodec<T>(spec: {
  /** Map the typed cursor to its scalar key tuple for encoding. */
  toKey(value: T): CursorKey
  /** Validate + rebuild the typed cursor from a decoded key. Return null on
   *  arity/type mismatch (e.g. a cursor minted for a different endpoint). */
  fromKey(key: CursorKey): T | null
  /** Transition-only fallback for this endpoint's pre-unification cursor
   *  string. Tried ONLY when the raw is not a valid v1 envelope. */
  legacy?(raw: string): T | null
}): CursorCodec<T> {
  return {
    encode(value) {
      return encodeCursor(spec.toKey(value))
    },
    decode(raw) {
      const key = decodeCursorStrict(raw)
      // A valid v1 envelope that fails fromKey is a wrong-endpoint / tampered
      // cursor, not a legacy one — reject it rather than mis-routing to legacy.
      if (key) return spec.fromKey(key)
      return spec.legacy ? spec.legacy(raw) : null
    },
  }
}

/** The dominant keyset shape across the APIs: a `(timestamp, id)` tuple.
 *  Callers supply only the endpoint's legacy parser (if any); encoding and v1
 *  decoding are handled here. */
export interface KeysetCursor {
  at: Date
  id: string
}

export function createKeysetCursorCodec(
  legacy?: (raw: string) => KeysetCursor | null,
): CursorCodec<KeysetCursor> {
  return createCursorCodec<KeysetCursor>({
    toKey: (v) => [v.at.toISOString(), v.id],
    fromKey: (k) => {
      if (k.length !== 2) return null
      const [iso, id] = k
      if (typeof iso !== 'string' || typeof id !== 'string' || id === '') return null
      const at = new Date(iso)
      return Number.isNaN(at.getTime()) ? null : { at, id }
    },
    ...(legacy ? { legacy } : {}),
  })
}

// --- request validation -----------------------------------------------------

/** Parsed pagination request params. `cursor` is the still-encoded string —
 *  routes decode it through the endpoint's `CursorCodec`. */
export interface PaginationParams {
  limit: number
  cursor: string | undefined
}

/** Raw pagination input as it arrives from a route: `limit` is a query string
 *  (or a body number), `cursor` may be null (POST bodies) or absent. */
export interface PaginationQueryInput {
  limit?: string | number | undefined
  cursor?: string | null | undefined
}

export interface PaginationQueryOptions {
  defaultLimit: number
  maxLimit: number
  /**
   * `reject` (default): a present-but-invalid or out-of-range `limit` produces a
   * zod issue (route does safeParse → errors.validation). `clamp`: `limit` is
   * clamped into `[1, maxLimit]` and malformed values fall back to the default —
   * reads never 400 on `limit` (the historical chat-list behavior).
   */
  mode?: 'reject' | 'clamp'
  /** Reject cursors longer than this in both modes (cheap abuse guard). Default 256. */
  maxCursorLength?: number
}

/** Build a zod schema for `{ limit?, cursor? }`. Inputs are the raw query values
 *  (`string | undefined`), so callers pass e.g.
 *  `{ limit: c.req.query('limit'), cursor: c.req.query('cursor') }`. */
export function paginationQuery(
  opts: PaginationQueryOptions,
): z.ZodType<PaginationParams, z.ZodTypeDef, PaginationQueryInput> {
  const { defaultLimit, maxLimit, mode = 'reject', maxCursorLength = 256 } = opts
  const base = z.object({
    limit: z.union([z.string(), z.number()]).optional(),
    cursor: z
      .string()
      .max(maxCursorLength, { message: `cursor must be at most ${maxCursorLength} characters` })
      .nullish(),
  })
  return base.transform((val, ctx): PaginationParams => {
    const cursor = val.cursor ?? undefined
    // Treat an explicitly empty `?limit=` as absent.
    const rawLimit = val.limit === '' ? undefined : val.limit
    if (rawLimit === undefined) return { limit: defaultLimit, cursor }
    const n = typeof rawLimit === 'number' ? rawLimit : Number(rawLimit)
    if (mode === 'clamp') {
      const limit = Number.isFinite(n)
        ? Math.min(maxLimit, Math.max(1, Math.floor(n)))
        : defaultLimit
      return { limit, cursor }
    }
    if (!Number.isInteger(n) || n < 1 || n > maxLimit) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['limit'],
        message: `limit must be an integer between 1 and ${maxLimit}`,
      })
      return z.NEVER
    }
    return { limit: n, cursor }
  })
}

// --- page shaping -----------------------------------------------------------

/** Shape an over-fetched result set into a page. Rows MUST be fetched with
 *  `LIMIT limit + 1`: the extra row is how we know a further page exists without
 *  a COUNT. Slices to `limit` and emits `nextCursor` from the LAST KEPT row iff
 *  an extra row was present, else null. */
export function buildPage<Row, T>(
  rows: Row[],
  limit: number,
  codec: CursorCodec<T>,
  cursorOf: (row: Row) => T,
): { items: Row[]; nextCursor: string | null } {
  const hasMore = rows.length > limit
  const items = hasMore ? rows.slice(0, limit) : rows
  const nextCursor =
    hasMore && items.length > 0 ? codec.encode(cursorOf(items[items.length - 1]!)) : null
  return { items, nextCursor }
}

// --- response shape ---------------------------------------------------------

/** The ONE list-response wire shape. `next_cursor` is snake_case and null at
 *  end-of-collection. */
export type PageDto<T> = { items: T[]; next_cursor: string | null }

/** Serialize an internal page into the wire DTO, centralizing the snake_case
 *  `next_cursor` key so no route re-invents it. */
export function toPageDto<Row, R>(
  page: { items: Row[]; nextCursor: string | null },
  serialize: (row: Row) => R,
): PageDto<R> {
  return { items: page.items.map(serialize), next_cursor: page.nextCursor }
}

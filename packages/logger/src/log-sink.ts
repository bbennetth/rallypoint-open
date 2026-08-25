// A logger sink that forwards structured records to the PostHog Logs
// product (https://posthog.com/docs/logs) as OpenTelemetry log records,
// giving the Worker APIs full server-side visibility in the same project
// the client analytics + exception tracking already report to. Records
// are buffered and flushed as one OTLP/HTTP POST per request (or per
// cron tick) via `executionCtx.waitUntil`, so the send survives the
// response.
//
// PostHog's log ingestion speaks standard OTLP/HTTP JSON at
// `/i/v1/logs`, authenticated with the project token as a bearer token.
// We build the `ExportLogsServiceRequest` envelope by hand rather than
// pulling in the OpenTelemetry SDK: the SDK's Node exporters aren't
// workerd-friendly and would dwarf the ~100 lines below.
//
// Design constraints (mirror packages/logger/src/posthog.ts):
//   - Missing api key → no-op (FOSS/local dev).
//   - Telemetry must NEVER break the request path — flush swallows every
//     failure and never rejects.
//   - The records handed to the sink are ALREADY redacted by the logger
//     (cloneRedacted runs before the sink), so forwarding is safe.

import { LEVELS, type LogLevel, type Sink } from './index.js'
import { DEFAULT_POSTHOG_HOST } from './posthog.js'

export interface PostHogLogSinkConfig {
  /** PostHog project API key (public `phc_…`). Undefined → no-op. */
  apiKey: string | undefined
  /** Ingestion host; defaults to the US cloud. */
  host?: string | undefined
  /** Service name — the OTel `service.name` resource attribute, which is
   *  how the PostHog Logs UI groups and filters by service. */
  service: string
  /** Deployment environment (`qa` / `prod`) — the OTel
   *  `deployment.environment` resource attribute. QA and prod share one
   *  PostHog project, so without this their logs are indistinguishable.
   *  Undefined → attribute omitted. */
  environment?: string | undefined
  /** Minimum level to forward. Defaults to `info` so per-request access
   *  logs land in PostHog Logs alongside failures. */
  minLevel?: LogLevel
  /** Hard cap on the in-memory buffer. Guards against unbounded growth if
   *  a flush stalls; excess records are dropped. Defaults to 200. */
  maxBuffer?: number
}

export interface PostHogLogSink {
  /** Tee this into `createLogger`'s sink alongside `consoleSink`. */
  sink: Sink
  /** Drain the buffer to PostHog. Pass the returned promise to
   *  `executionCtx.waitUntil`. Never rejects. */
  flush: () => Promise<void>
}

// ── OTLP payload shapes ─────────────────────────────────────────────
// Hand-rolled subset of the OTLP/HTTP JSON encoding of
// ExportLogsServiceRequest. Only the fields PostHog reads are modelled.

export type OtlpAnyValue =
  | { stringValue: string }
  // int64 rides as a decimal STRING per the proto3 JSON mapping — a raw
  // number would lose precision past 2^53 on the wire.
  | { intValue: string }
  | { doubleValue: number }
  | { boolValue: boolean }
  | { arrayValue: { values: OtlpAnyValue[] } }
  | { kvlistValue: { values: OtlpKeyValue[] } }

export interface OtlpKeyValue {
  key: string
  value: OtlpAnyValue
}

export interface OtlpLogRecord {
  timeUnixNano: string
  severityText: string
  severityNumber: number
  body: { stringValue: string }
  attributes: OtlpKeyValue[]
}

/** OTel severity numbers per level. PostHog buckets these back into its
 *  six severity filters (trace 1-4, debug 5-8, … fatal 21-24). */
export const OTEL_SEVERITY: Record<LogLevel, number> = {
  trace: 1,
  debug: 5,
  info: 9,
  warn: 13,
  error: 17,
  fatal: 21,
}

// Record keys encoded elsewhere in the log record (severity, timestamp,
// body) or on the resource — forwarding them again as attributes would
// just duplicate them in the Logs UI.
const ENCODED_KEYS: ReadonlySet<string> = new Set(['level', 'time', 'msg', 'service'])

// Depth cap for attribute conversion. cloneRedacted has already broken
// cycles ('[Circular]'), so this is belt-and-braces against a pathological
// nesting depth blowing the isolate stack.
const MAX_ATTR_DEPTH = 6

/**
 * Convert a JS value to an OTLP `AnyValue`. Returns undefined for
 * null/undefined so the caller drops the attribute entirely (OTLP has no
 * null variant).
 */
export function toAnyValue(value: unknown, depth = 0): OtlpAnyValue | undefined {
  if (value === null || value === undefined) return undefined
  if (typeof value === 'string') return { stringValue: value }
  if (typeof value === 'boolean') return { boolValue: value }
  if (typeof value === 'number') {
    // NaN / ±Infinity have no JSON number encoding — stringify them
    // rather than emitting a payload that fails to serialize cleanly.
    if (!Number.isFinite(value)) return { stringValue: String(value) }
    // isSafeInteger, NOT isInteger: `Number.isInteger(1e21)` is true, but
    // `String(1e21)` is '1e+21' — exponential notation is not a valid
    // decimal string for an OTLP int64 field, so a large-magnitude
    // attribute would ship malformed. Safe integers (< 2^53) always
    // stringify in plain decimal; everything else falls through to
    // doubleValue, a native JSON number that encodes exponents fine.
    return Number.isSafeInteger(value) ? { intValue: String(value) } : { doubleValue: value }
  }
  // BigInt reaches here only if a caller bypassed the logger; cloneRedacted
  // normally renders it as a decimal string first.
  if (typeof value === 'bigint') return { intValue: value.toString() }
  if (depth >= MAX_ATTR_DEPTH) return { stringValue: safeStringify(value) }
  if (Array.isArray(value)) {
    return {
      arrayValue: {
        // Array elements keep their positions: a null element becomes the
        // literal 'null' rather than shifting every later index.
        values: value.map((v) => toAnyValue(v, depth + 1) ?? { stringValue: 'null' }),
      },
    }
  }
  if (typeof value === 'object') {
    const values: OtlpKeyValue[] = []
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const converted = toAnyValue(v, depth + 1)
      if (converted) values.push({ key: k, value: converted })
    }
    return { kvlistValue: { values } }
  }
  // Symbols / functions can't survive cloneRedacted, but never throw here.
  return { stringValue: safeStringify(value) }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/**
 * ISO timestamp → nanoseconds since the epoch, as a decimal string.
 *
 * The BigInt is load-bearing: ms × 1e6 is ~1.75e18 today, well past
 * Number.MAX_SAFE_INTEGER (9.0e15), so Number arithmetic silently
 * corrupts the low digits. The result must be a string — JSON.stringify
 * throws on a raw BigInt.
 *
 * An absent or unparseable timestamp falls back to now, so a malformed
 * record still lands (with a slightly late time) rather than being
 * rejected by ingestion.
 */
export function isoToUnixNano(iso: string | undefined, nowMs: () => number = Date.now): string {
  const ms = iso ? Date.parse(iso) : Number.NaN
  const millis = Number.isNaN(ms) ? nowMs() : ms
  return (BigInt(Math.trunc(millis)) * 1_000_000n).toString()
}

/** Build one OTLP log record from a logger record. Pure. */
export function buildLogRecord(
  level: LogLevel,
  line: string,
  record: Record<string, unknown>,
  nowMs?: () => number,
): OtlpLogRecord {
  const attributes: OtlpKeyValue[] = []
  for (const [key, value] of Object.entries(record)) {
    if (ENCODED_KEYS.has(key)) continue
    const converted = toAnyValue(value)
    if (converted) attributes.push({ key, value: converted })
  }
  return {
    timeUnixNano: isoToUnixNano(
      typeof record.time === 'string' ? record.time : undefined,
      nowMs,
    ),
    severityText: level,
    severityNumber: OTEL_SEVERITY[level],
    // `msg` is the human-readable body; fall back to the rendered line so
    // a msg-less record still shows something searchable.
    body: { stringValue: typeof record.msg === 'string' ? record.msg : line },
    attributes,
  }
}

/** Wrap log records in the OTLP ExportLogsServiceRequest envelope. Pure. */
export function buildLogsPayload(
  records: OtlpLogRecord[],
  resource: { service: string; environment?: string | undefined },
): unknown {
  const attributes: OtlpKeyValue[] = [
    { key: 'service.name', value: { stringValue: resource.service } },
  ]
  if (resource.environment) {
    attributes.push({
      key: 'deployment.environment',
      value: { stringValue: resource.environment },
    })
  }
  return {
    resourceLogs: [
      {
        resource: { attributes },
        scopeLogs: [{ logRecords: records }],
      },
    ],
  }
}

// ── sink ────────────────────────────────────────────────────────────

const NOOP: PostHogLogSink = { sink: () => {}, flush: async () => {} }

// Parse the JSON line back to an object. In prod the logger emits JSON, so
// this is the structured record; the caller normally passes the record
// directly (no parse needed). Dev mode emits pretty lines, but dev has no
// api key so the sink is a no-op there — this fallback is only a guard.
function toProps(line: string, record?: Record<string, unknown>): Record<string, unknown> {
  if (record) return record
  try {
    const v = JSON.parse(line) as unknown
    if (v && typeof v === 'object') return v as Record<string, unknown>
  } catch {
    // fall through
  }
  return { msg: line }
}

export function createPostHogLogSink(config: PostHogLogSinkConfig): PostHogLogSink {
  const apiKey = config.apiKey?.trim()
  if (!apiKey) return NOOP
  const host = (config.host?.trim() || DEFAULT_POSTHOG_HOST).replace(/\/+$/, '')
  const threshold = LEVELS[config.minLevel ?? 'info']
  const maxBuffer = config.maxBuffer ?? 200
  const resource = { service: config.service, environment: config.environment }

  let buffer: OtlpLogRecord[] = []

  const sink: Sink = (level, line, record) => {
    if (LEVELS[level] < threshold) return
    // Drop rather than grow without bound if a flush is wedged.
    if (buffer.length >= maxBuffer) return
    buffer.push(buildLogRecord(level, line, toProps(line, record)))
  }

  const flush = async (): Promise<void> => {
    if (buffer.length === 0) return
    // Swap the buffer out up front so records logged during the in-flight
    // POST accumulate for the next flush instead of being cleared with it.
    const batch = buffer
    buffer = []
    try {
      await fetch(`${host}/i/v1/logs`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(buildLogsPayload(batch, resource)),
      })
    } catch {
      // Swallowed — telemetry must never take down the request path. The
      // batch is dropped (not re-buffered) so a persistently failing sink
      // can't grow memory without bound.
    }
  }

  return { sink, flush }
}

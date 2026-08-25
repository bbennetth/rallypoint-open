// @rallypoint/logger — a tiny structured logger that runs on both Node
// and Workers (workerd). Replaces pino, whose transports lean on Node
// internals (worker_threads, process.stdout) that don't exist on
// Workers. Emits one JSON line per record via console; preserves the
// pino-compatible call surface (`info(obj, msg)` / `info(msg)` +
// `child`) so existing call sites are unchanged.

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'

// Numeric rank per level. Exported so downstream sinks (e.g. the PostHog
// log sink) share one source of truth for level thresholds.
export const LEVELS: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
}

// A log destination. Receives the level, the ready-to-write line (JSON in
// prod, pretty in dev), and the already-redacted structured record so a
// sink can forward fields without re-parsing the line.
export type Sink = (level: LogLevel, line: string, record?: Record<string, unknown>) => void

/** Combine several sinks into one — each receives every record. Used to
 *  write to console AND forward to PostHog. */
export function teeSink(...sinks: Sink[]): Sink {
  return (level, line, record) => {
    for (const s of sinks) s(level, line, record)
  }
}

const CENSOR = '[REDACTED]'

// Fixed full-path specs: redacted only at this exact path. These header
// fields are sensitive under `req.headers.*` / `res.headers.*` but the
// same key name elsewhere isn't, so they stay path-anchored.
const REDACT_EXACT_PATHS: ReadonlyArray<ReadonlyArray<string>> = [
  ['req', 'headers', 'authorization'],
  ['req', 'headers', 'cookie'],
  ['res', 'headers', 'set-cookie'],
]

// Secret-bearing leaf key names: redacted wherever they appear, at ANY
// depth including top-level. Previously these were depth-1 wildcards
// (`['*', 'token']`) that only matched at exactly depth 2, so both
// `log.warn({ accessToken })` (too shallow) and `{ a: { b: { token } } }`
// (too deep) leaked the raw value — and `log.warn({ accessToken }, …)` is
// the natural way to write it. Matching on the leaf key at any depth
// closes both gaps. (Deliberately NOT bare `key` — it's too broad and
// would censor benign fields like cache/idempotency keys.)
const REDACT_KEYS: ReadonlySet<string> = new Set([
  'password',
  'token',
  'code',
  'secret',
  'apiKey',
  'accessToken',
  'refreshToken',
  'csrfToken',
  'privateKey',
])

function shouldRedact(path: string[]): boolean {
  if (path.length === 0) return false
  const leaf = path[path.length - 1]!
  if (REDACT_KEYS.has(leaf)) return true
  return REDACT_EXACT_PATHS.some(
    (spec) => spec.length === path.length && spec.every((seg, i) => seg === path[i]),
  )
}

// Produce a JSON-safe, redaction-applied copy of a value. Never mutates
// the input. Errors are unwound to a serializable shape (pino logs the
// stack); other non-plain objects fall through to their entries. `seen`
// tracks the ancestor objects on the current path so a cyclic reference
// renders as '[Circular]' instead of recursing until the isolate
// stack-overflows.
function cloneRedacted(value: unknown, path: string[], seen = new WeakSet<object>()): unknown {
  if (value instanceof Error) {
    return { type: value.name, message: value.message, stack: value.stack }
  }
  // BigInt would otherwise reach JSON.stringify and throw; render it as
  // its decimal string (money-shared logs BigInt money amounts).
  if (typeof value === 'bigint') return value.toString()
  // Path-scoped visited set: add before recursing into children, remove
  // after. Flags only true ancestor cycles as '[Circular]', not a shared
  // but acyclic reference that legitimately appears in two siblings.
  if (Array.isArray(value)) {
    if (seen.has(value)) return '[Circular]'
    seen.add(value)
    const out = value.map((v, i) => cloneRedacted(v, [...path, String(i)], seen))
    seen.delete(value)
    return out
  }
  if (value !== null && typeof value === 'object') {
    if (seen.has(value)) return '[Circular]'
    seen.add(value)
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = shouldRedact([...path, k]) ? CENSOR : cloneRedacted(v, [...path, k], seen)
    }
    seen.delete(value)
    return out
  }
  return value
}

export interface Logger {
  trace(obj: object, msg?: string): void
  trace(msg: string): void
  debug(obj: object, msg?: string): void
  debug(msg: string): void
  info(obj: object, msg?: string): void
  info(msg: string): void
  warn(obj: object, msg?: string): void
  warn(msg: string): void
  error(obj: object, msg?: string): void
  error(msg: string): void
  fatal(obj: object, msg?: string): void
  fatal(msg: string): void
  child(bindings: Record<string, unknown>): Logger
}

export interface LoggerOptions {
  // pino level string; unknown values fall back to 'info', 'silent' mutes.
  level?: string
  service: string
  // Pretty single-line output for local dev; JSON otherwise (prod/Workers).
  dev?: boolean
  // Seam for tests and for teeing to extra destinations (PostHog).
  sink?: Sink
  now?: () => string
}

// Writes to console — the one place console is the intended output
// (Workers has no stdout). Exported as `consoleSink` so apps can tee it
// alongside the PostHog log sink.
export function consoleSink(level: LogLevel, line: string): void {
  /* eslint-disable no-console */
  if (LEVELS[level] >= LEVELS.error) console.error(line)
  else console.log(line)
  /* eslint-enable no-console */
}

function normalizeLevel(level: string | undefined): number {
  if (level === 'silent') return Number.POSITIVE_INFINITY
  if (level && level in LEVELS) return LEVELS[level as LogLevel]
  return LEVELS.info
}

export function createLogger(opts: LoggerOptions): Logger {
  const threshold = normalizeLevel(opts.level)
  const sink = opts.sink ?? consoleSink
  const now = opts.now ?? (() => new Date().toISOString())
  const dev = opts.dev ?? false

  function emit(level: LogLevel, bindings: Record<string, unknown>, a?: object | string, b?: string): void {
    if (LEVELS[level] < threshold) return

    let merge: Record<string, unknown> = {}
    let msg: string | undefined
    if (typeof a === 'string') {
      msg = a
    } else if (a !== undefined) {
      merge = a as Record<string, unknown>
      msg = b
    }

    const record: Record<string, unknown> = {
      level,
      time: now(),
      service: opts.service,
      ...bindings,
      ...(cloneRedacted(merge, []) as Record<string, unknown>),
    }
    if (msg !== undefined) record.msg = msg

    if (dev) {
      const { level: _l, time, service, msg: _m, ...rest } = record
      const parts = [
        `${String(time)} ${level.toUpperCase()} [${service}]`,
        msg,
        Object.keys(rest).length ? JSON.stringify(rest) : '',
      ]
      sink(level, parts.filter(Boolean).join(' '), record)
    } else {
      sink(level, JSON.stringify(record), record)
    }
  }

  function build(bindings: Record<string, unknown>): Logger {
    const method =
      (level: LogLevel) =>
      (a?: object | string, b?: string): void =>
        emit(level, bindings, a, b)
    return {
      trace: method('trace'),
      debug: method('debug'),
      info: method('info'),
      warn: method('warn'),
      error: method('error'),
      fatal: method('fatal'),
      // Run cloneRedacted on the new bindings BEFORE storing them on the
      // child logger. Otherwise nested secrets like
      // `log.child({ req: { headers: { authorization } } })` are spread
      // raw into every record this child emits (the per-call merge arg
      // IS redacted at emit time, but the stored bindings aren't —
      // bypassing every REDACT_PATHS rule). The accumulated `bindings`
      // chain is already-redacted from prior child() calls, so we only
      // need to redact each new layer once. (E1 #16 in the 2026-06-24
      // audit. Secret-bearing leaf keys are redacted at any depth,
      // including top-level bindings — see REDACT_KEYS.)
      child: (extra) =>
        build({
          ...bindings,
          ...(cloneRedacted(extra, []) as Record<string, unknown>),
        }),
    }
  }

  return build({})
}

export {
  DEFAULT_POSTHOG_HOST,
  buildEvent,
  buildExceptionEvent,
  createEventCapture,
  createExceptionCapture,
  errorCauseChain,
  posthogSessionProps,
  type CaptureEvent,
  type CaptureException,
  type EventCaptureConfig,
  type EventOptions,
  type ExceptionCaptureConfig,
  type ExceptionEvent,
  type PostHogEvent,
} from './posthog.js'

export {
  OTEL_SEVERITY,
  buildLogRecord,
  buildLogsPayload,
  createPostHogLogSink,
  isoToUnixNano,
  toAnyValue,
  type OtlpAnyValue,
  type OtlpKeyValue,
  type OtlpLogRecord,
  type PostHogLogSink,
  type PostHogLogSinkConfig,
} from './log-sink.js'

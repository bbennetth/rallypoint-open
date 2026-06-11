// @rallypoint/logger — a tiny structured logger that runs on both Node
// and Workers (workerd). Replaces pino, whose transports lean on Node
// internals (worker_threads, process.stdout) that don't exist on
// Workers. Emits one JSON line per record via console; preserves the
// pino-compatible call surface (`info(obj, msg)` / `info(msg)` +
// `child`) so existing call sites are unchanged.

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'

const LEVELS: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
}

const CENSOR = '[REDACTED]'

// Same redaction list as the previous pino config. Each spec is a full
// path; `*` matches exactly one key at that depth (pino's `*.x`
// semantics — depth-1 wildcard, NOT recursive).
const REDACT_PATHS: ReadonlyArray<ReadonlyArray<string>> = [
  ['req', 'headers', 'authorization'],
  ['req', 'headers', 'cookie'],
  ['res', 'headers', 'set-cookie'],
  ['*', 'password'],
  ['*', 'token'],
  ['*', 'code'],
  ['*', 'secret'],
]

function shouldRedact(path: string[]): boolean {
  return REDACT_PATHS.some(
    (spec) => spec.length === path.length && spec.every((seg, i) => seg === '*' || seg === path[i]),
  )
}

// Produce a JSON-safe, redaction-applied copy of a value. Never mutates
// the input. Errors are unwound to a serializable shape (pino logs the
// stack); other non-plain objects fall through to their entries.
function cloneRedacted(value: unknown, path: string[]): unknown {
  if (value instanceof Error) {
    return { type: value.name, message: value.message, stack: value.stack }
  }
  if (Array.isArray(value)) {
    return value.map((v, i) => cloneRedacted(v, [...path, String(i)]))
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = shouldRedact([...path, k]) ? CENSOR : cloneRedacted(v, [...path, k])
    }
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
  // Seams for tests.
  sink?: (level: LogLevel, line: string) => void
  now?: () => string
}

function defaultSink(level: LogLevel, line: string): void {
  // The one place console is the intended output (Workers has no stdout).
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
  const sink = opts.sink ?? defaultSink
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
      sink(level, parts.filter(Boolean).join(' '))
    } else {
      sink(level, JSON.stringify(record))
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
      child: (extra) => build({ ...bindings, ...extra }),
    }
  }

  return build({})
}

import { withD1Retry, type D1RetryOptions } from './d1-retry.js'

// Structural views of the Workers D1 binding — api-kit deliberately avoids a
// dependency on @cloudflare/workers-types (mirrors repos/sessions.ts, which
// types its DB handle structurally too). The generic signature hands the
// caller's concrete D1Database type straight back.
interface D1StatementLike {
  bind(...values: unknown[]): D1StatementLike
  all(...args: unknown[]): Promise<unknown>
  raw(...args: unknown[]): Promise<unknown>
  first(...args: unknown[]): Promise<unknown>
  run(...args: unknown[]): Promise<unknown>
}
interface D1BindingLike {
  prepare(sql: string): D1StatementLike
  batch?(statements: D1StatementLike[], ...rest: unknown[]): Promise<unknown>
}

// Handle back to the native statement under a SELECT Proxy. `batch` must hand
// workerd the real brand-checked statements, not Proxies — drizzle's batch()
// prepares each statement through this wrapped binding before passing the
// array to d1.batch().
const RAW_STATEMENT = Symbol('apiKitRawD1Statement')

function unwrapStatement(stmt: D1StatementLike): D1StatementLike {
  return ((stmt as unknown as Record<symbol, unknown>)[RAW_STATEMENT] as D1StatementLike) ?? stmt
}

// Transparent read-retry decorator for the raw D1 binding. The session repo
// wraps its own statements in withD1Retry, but every *domain* repo across the
// apps talks to drizzle → D1 unwrapped — so a single transient storage reset
// on any domain SELECT (observed in production on a fitness-api
// `training_plans` lookup, 2026-08-24 20:16 UTC) surfaces straight to the
// user as a 500. Wrapping the binding once in each app's `createDb` gives
// every query the same bounded retry with no per-repo changes.
//
// Only SELECTs are retried: they're idempotent by construction. Writes pass
// through untouched — a failed INSERT/UPDATE is ambiguous (it may have
// committed before the error surfaced), which is the same reason the session
// repo's `create` stays un-retried. `batch`/`exec` also pass through: a batch
// is atomic-ish but may mix writes, and `exec` is dev-only.

function isSelect(sql: string): boolean {
  // Leading whitespace/comments then SELECT (or WITH … SELECT, which drizzle
  // emits for CTE reads). Anything else is treated as a write and not retried.
  const head = sql.replace(/^\s*(--[^\n]*\n\s*|\/\*[\s\S]*?\*\/\s*)*/, '')
  return /^(select|with)\b/i.test(head)
}

function wrapStatement(
  stmt: D1StatementLike,
  sql: string,
  options: D1RetryOptions | undefined,
): D1StatementLike {
  if (!isSelect(sql)) return stmt
  return new Proxy(stmt, {
    get(target, prop) {
      if (prop === RAW_STATEMENT) return target
      if (prop === 'bind') {
        return (...values: unknown[]) =>
          wrapStatement(target.bind(...values), sql, options)
      }
      if (prop === 'all' || prop === 'raw' || prop === 'first' || prop === 'run') {
        return (...args: unknown[]) =>
          withD1Retry(
            () => target[prop](...args) as Promise<never>,
            options,
          )
      }
      return passThrough(target, prop)
    },
  })
}

// Native workerd objects brand-check `this`; a method pulled through a Proxy
// and invoked with the proxy as receiver would fail. Bind functions back to
// the real target.
function passThrough<T extends object>(target: T, prop: string | symbol): unknown {
  const value = Reflect.get(target, prop) as unknown
  return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value
}

/**
 * Wrap a D1 binding so every prepared SELECT retries transient runtime
 * failures (storage resets, network blips — see {@link withD1Retry}) with
 * bounded backoff. Non-SELECT statements, `batch`, and `exec` pass through
 * unretried. Apply in each app's `createDb` before handing the binding to
 * drizzle.
 */
export function withD1ReadRetry<T extends D1BindingLike>(d1: T, options?: D1RetryOptions): T {
  return new Proxy(d1, {
    get(target, prop) {
      if (prop === 'prepare') {
        return (sql: string) => wrapStatement(target.prepare(sql), sql, options)
      }
      if (prop === 'batch' && typeof target.batch === 'function') {
        // Not retried (may mix writes) — but the statements drizzle prepared
        // through this proxy must be unwrapped back to native before workerd
        // sees them.
        return (statements: D1StatementLike[], ...rest: unknown[]) =>
          target.batch!(statements.map(unwrapStatement), ...rest)
      }
      return passThrough(target, prop)
    },
  })
}

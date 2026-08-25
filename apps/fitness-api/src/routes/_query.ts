import { errors } from '../errors.js'

// Shared query-string parsers. Routes that take a `from`/`to` time
// window have to reject malformed values up front — `new Date('garbage')`
// silently produces an Invalid Date whose `.getTime()` is `NaN`, which
// turns a 400 into either silently-wrong D1 results or a 500 when the
// Date is later serialised back via `toISOString()`.

function parseDateOrThrow(value: string, paramName: string): Date {
  const d = new Date(value)
  if (isNaN(d.getTime())) {
    throw errors.validation({
      issues: [
        {
          code: 'custom',
          path: [paramName],
          message: `Query param "${paramName}" must be an ISO-8601 date.`,
        },
      ],
    })
  }
  return d
}

// Parse the standard `?from=<ISO>&to=<ISO>` window. Both bounds are
// optional and independent; returns `{}` when neither is supplied.
export function parseDateRangeQuery(url: URL): { from?: Date; to?: Date } {
  const out: { from?: Date; to?: Date } = {}
  const fromParam = url.searchParams.get('from')
  const toParam = url.searchParams.get('to')
  if (fromParam) out.from = parseDateOrThrow(fromParam, 'from')
  if (toParam) out.to = parseDateOrThrow(toParam, 'to')
  return out
}

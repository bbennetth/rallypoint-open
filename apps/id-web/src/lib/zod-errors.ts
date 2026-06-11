import type { ZodError, ZodIssue } from 'zod'

// Convert zod issues (from client-side schema validation, OR from
// the API's validation_failed response details.issues) into a
// field-keyed map the form code can consume.

export type FieldErrors = Record<string, string>

export function issuesToFieldErrors(issues: ZodIssue[]): FieldErrors {
  const out: FieldErrors = {}
  for (const issue of issues) {
    const key = issue.path.length > 0 ? String(issue.path[0]) : '_'
    if (!(key in out)) out[key] = issue.message
  }
  return out
}

export function zodToFieldErrors(err: ZodError): FieldErrors {
  return issuesToFieldErrors(err.issues)
}

// When the API rejects with `validation_failed`, its details.issues
// is a zod-issue-shaped array. Decode safely.
export function apiValidationToFieldErrors(
  details: Record<string, unknown> | undefined,
): FieldErrors {
  if (!details) return {}
  const issues = (details as { issues?: ZodIssue[] }).issues
  if (!Array.isArray(issues)) return {}
  return issuesToFieldErrors(issues)
}

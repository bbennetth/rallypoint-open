import { z } from 'zod'

// Submission AI scans — automatic AI triage of incoming review-queue
// items (exercise + food submissions). A scan is advisory only: it
// attaches a verdict + findings badge to the admin queues and never
// mutates the submission. Shared between fitness-api (producer),
// admin-api (proxy) and admin-web (badge UI).

export const SCAN_SUBJECT_TYPES = ['exercise', 'food'] as const
export type ScanSubjectType = (typeof SCAN_SUBJECT_TYPES)[number]
export const scanSubjectTypeSchema = z.enum(SCAN_SUBJECT_TYPES)

export const SCAN_STATUSES = ['pending', 'done', 'failed'] as const
export type ScanStatus = (typeof SCAN_STATUSES)[number]
export const scanStatusSchema = z.enum(SCAN_STATUSES)

// Overall verdict = the max finding severity ('info' findings alone
// still read as 'ok' — informational, nothing to act on).
export const SCAN_VERDICTS = ['ok', 'warn', 'flag'] as const
export type ScanVerdict = (typeof SCAN_VERDICTS)[number]
export const scanVerdictSchema = z.enum(SCAN_VERDICTS)

export const SCAN_DIMENSIONS = ['quality', 'duplicate', 'moderation'] as const
export type ScanDimension = (typeof SCAN_DIMENSIONS)[number]
export const scanDimensionSchema = z.enum(SCAN_DIMENSIONS)

export const SCAN_SEVERITIES = ['info', 'warn', 'flag'] as const
export type ScanSeverity = (typeof SCAN_SEVERITIES)[number]
export const scanSeveritySchema = z.enum(SCAN_SEVERITIES)

export const scanFindingSchema = z.object({
  dimension: scanDimensionSchema,
  severity: scanSeveritySchema,
  message: z.string().max(300),
  // Name/brand cleanups the admin can copy into an edit before approval.
  suggestedName: z.string().max(120).optional(),
  suggestedBrand: z.string().max(120).optional(),
  // Duplicate findings only: the global catalog id the item likely
  // duplicates. Always one of the SQL-shortlisted candidates — unknown
  // ids the model invents are dropped during normalization.
  duplicateId: z.string().optional(),
})
export type ScanFinding = z.infer<typeof scanFindingSchema>
export const scanFindingsSchema = z.array(scanFindingSchema).max(20)

// The scan DTO attached to admin submission list/detail responses.
export const submissionScanDtoSchema = z.object({
  id: z.string(),
  status: scanStatusSchema,
  verdict: scanVerdictSchema.nullable(),
  findings: z.array(scanFindingSchema),
  model: z.string(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
})
export type SubmissionScanDto = z.infer<typeof submissionScanDtoSchema>

/** Overall verdict from a findings list: the max severity present,
 * where 'info' findings (or none at all) read as 'ok'. */
export function deriveScanVerdict(findings: ScanFinding[]): ScanVerdict {
  if (findings.some((f) => f.severity === 'flag')) return 'flag'
  if (findings.some((f) => f.severity === 'warn')) return 'warn'
  return 'ok'
}

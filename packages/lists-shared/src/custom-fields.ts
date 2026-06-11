import { z } from 'zod'
import type { FieldType, SelectChoiceInput } from './validators.js'

// Pure helpers for Rallypoint Lists v2 custom fields. No PG — both
// apps/lists-api and apps/lists-web agree on these. Slice 1 shipped the
// options-blob shape and the create/merge builders; slice 3 adds
// `validateCustomFields` (dynamic per-type value validation).

// Stored shape of list_field_defs.options (the jsonb column). Only
// select-type fields use `choices`; text fields use `multiline`.
export interface SelectChoice {
  id: string
  label: string
  color?: string
  archived?: boolean
}

export interface FieldDefOptions {
  choices?: SelectChoice[]
  multiline?: boolean
}

function normalizeChoice(c: SelectChoiceInput, id: string): SelectChoice {
  const choice: SelectChoice = { id, label: c.label }
  if (c.color !== undefined) choice.color = c.color
  if (c.archived !== undefined) choice.archived = c.archived
  return choice
}

// Overlay an edit (label/color/archived) onto an existing choice, keeping
// its id stable so values that reference it survive the edit.
function applyChoiceEdits(prev: SelectChoice, edit: SelectChoiceInput): SelectChoice {
  const next: SelectChoice = { id: prev.id, label: edit.label }
  const color = edit.color ?? prev.color
  if (color !== undefined) next.color = color
  const archived = edit.archived ?? prev.archived
  if (archived !== undefined) next.archived = archived
  return next
}

// Build the options blob for a NEW field def from validated create input.
// Mints a fresh id for every choice (clients never set choice ids on
// create). `mintId` is injected to keep this pure and unit-testable; the
// route passes `() => \`opt_${ulid()}\``.
export function buildCreateOptions(
  fieldType: FieldType,
  input: { choices?: SelectChoiceInput[] | undefined; multiline?: boolean | undefined },
  mintId: () => string,
): FieldDefOptions {
  const options: FieldDefOptions = {}
  if ((fieldType === 'single_select' || fieldType === 'multi_select') && input.choices) {
    options.choices = input.choices.map((c) => normalizeChoice(c, mintId()))
  }
  if (fieldType === 'text' && input.multiline !== undefined) {
    options.multiline = input.multiline
  }
  return options
}

// Merge an update's choices/multiline onto a field def's existing options.
// Choice semantics (anti-orphan): a payload choice carrying a known id
// edits that choice in place; a choice with no id (or an unknown id) mints
// a fresh one; an existing choice the payload omits is PRESERVED (appended
// after the payload order) so values still resolve — removal is expressed
// by sending `archived: true`, never by dropping the choice. `multiline`
// is text-only.
export function mergeUpdateOptions(
  fieldType: FieldType,
  existing: FieldDefOptions,
  input: { choices?: SelectChoiceInput[] | undefined; multiline?: boolean | undefined },
  mintId: () => string,
): FieldDefOptions {
  const merged: FieldDefOptions = { ...existing }

  if (fieldType === 'single_select' || fieldType === 'multi_select') {
    if (input.choices !== undefined) {
      const existingChoices = existing.choices ?? []
      const byId = new Map(existingChoices.map((c) => [c.id, c]))
      const seen = new Set<string>()
      const next: SelectChoice[] = []
      for (const c of input.choices) {
        const prev = c.id ? byId.get(c.id) : undefined
        if (prev) {
          next.push(applyChoiceEdits(prev, c))
          seen.add(prev.id)
        } else {
          next.push(normalizeChoice(c, mintId()))
        }
      }
      for (const prev of existingChoices) {
        if (!seen.has(prev.id)) next.push(prev)
      }
      merged.choices = next
    }
  } else if (merged.choices !== undefined) {
    // Defensive: a non-select field must never carry choices.
    delete merged.choices
  }

  if (fieldType === 'text' && input.multiline !== undefined) {
    merged.multiline = input.multiline
  }
  return merged
}

// A select field def is UNSATISFIABLE when it is `required` yet has zero
// active (non-archived) choices: no value can ever be picked, so the item
// Add form's required-field gate (missingRequiredFieldIds → isEmptyValue)
// can never clear and Add is permanently disabled (#258). Authoring guards
// use this to block the state at its source — create already requires ≥1
// choice, so the gap is the update path: archiving the last active choice
// of a required select, or making a choiceless select required. Non-select
// or optional fields are never unsatisfiable.
export function isUnsatisfiableRequiredSelect(
  fieldType: FieldType,
  required: boolean,
  options: FieldDefOptions,
): boolean {
  const isSelect = fieldType === 'single_select' || fieldType === 'multi_select'
  if (!isSelect || !required) return false
  const activeCount = (options.choices ?? []).filter((c) => !c.archived).length
  return activeCount === 0
}

// --- value validation (slice 3) --------------------------------------

// The minimal field-def shape `validateCustomFields` reads. Both the
// server's FieldDefRecord and the web's FieldDefDto satisfy it
// structurally, so neither side has to adapt its records.
export interface FieldDefForValidation {
  id: string
  fieldType: FieldType
  required: boolean
  options: FieldDefOptions
}

// A custom-field value map keyed by field-def id (`lfd_…`).
export type CustomFieldValues = Record<string, unknown>

// Zod-issue-shaped error so routes can feed it straight into
// `errors.validation({ issues })` exactly as a schema parse failure.
export interface CustomFieldIssue {
  code: string
  path: (string | number)[]
  message: string
}

export type ValidateCustomFieldsResult =
  | { ok: true; values: CustomFieldValues }
  | { ok: false; issues: CustomFieldIssue[] }

// Active (non-archived) choice ids for a select field — the only values a
// new edit may reference. Archived choices keep resolving historical
// values but can't be picked.
function activeChoiceIds(def: FieldDefForValidation): Set<string> {
  return new Set((def.options.choices ?? []).filter((c) => !c.archived).map((c) => c.id))
}

const HTTP_URL_RE = /^https?:\/\//i

// Build the per-type zod schema for ONE field's (non-null) value. Date
// accepts an ISO string or epoch-ms number and normalises to an ISO
// string (JSON-symmetric across client/server, mirroring dueDateField).
// Select values are checked against the field's active choice ids.
function fieldTypeSchema(def: FieldDefForValidation): z.ZodTypeAny {
  switch (def.fieldType) {
    case 'text':
      return z.string().max(10000, 'Text value must be at most 10000 characters.')
    case 'number':
      return z
        .number({ invalid_type_error: 'Value must be a number.' })
        .finite('Value must be a finite number.')
    case 'checkbox':
      return z.boolean({ invalid_type_error: 'Value must be a boolean.' })
    case 'date':
      return z.union([z.string(), z.number()]).transform((v, ctx) => {
        const d = new Date(v)
        if (Number.isNaN(d.getTime())) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Value is not a valid date.' })
          return z.NEVER
        }
        return d.toISOString()
      })
    case 'person':
      return z
        .string()
        .trim()
        .min(1, 'Person id is required.')
        .max(64, 'Person id must be at most 64 characters.')
    case 'url':
      return z
        .string()
        .trim()
        .max(2048, 'URL must be at most 2048 characters.')
        .refine((s) => HTTP_URL_RE.test(s), 'URL must start with http:// or https://.')
    case 'single_select': {
      const ids = activeChoiceIds(def)
      return z.string().refine((v) => ids.has(v), 'Value is not an active choice.')
    }
    case 'multi_select': {
      const ids = activeChoiceIds(def)
      return z
        .array(z.string().refine((v) => ids.has(v), 'Value is not an active choice.'))
        .max(100, 'At most 100 selections are allowed.')
    }
  }
}

// A value that means "unset" — absent, explicit clear, empty string, or
// empty multi-select array. A required field rejects these; an optional
// field simply omits the key from the stored map. Exported so the web
// can gate its add form on the same rule the server enforces here.
export function isEmptyValue(v: unknown): boolean {
  return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)
}

// Validate a complete intended custom-field value map against a list's
// active field defs. The caller passes the FINAL intended state (on
// PATCH: existing values filtered to active defs, merged with the patch,
// nulls dropped) so `required` is enforced on the resulting item, not on
// the partial patch. Returns normalised values (date→ISO) keyed by def
// id, dropping empty/optional keys; or zod-issue-shaped errors.
export function validateCustomFields(
  defs: FieldDefForValidation[],
  input: CustomFieldValues,
): ValidateCustomFieldsResult {
  const issues: CustomFieldIssue[] = []
  const values: CustomFieldValues = {}
  const defById = new Map(defs.map((d) => [d.id, d]))

  // Reject any input key that doesn't name an active field def.
  for (const key of Object.keys(input)) {
    if (!defById.has(key)) {
      issues.push({
        code: 'unrecognized_keys',
        path: ['customFields', key],
        message: `Unknown field "${key}".`,
      })
    }
  }

  for (const def of defs) {
    const raw = input[def.id]
    if (isEmptyValue(raw)) {
      if (def.required) {
        issues.push({
          code: 'custom',
          path: ['customFields', def.id],
          message: 'This field is required.',
        })
      }
      continue
    }
    const parsed = fieldTypeSchema(def).safeParse(raw)
    if (!parsed.success) {
      for (const iss of parsed.error.issues) {
        issues.push({
          code: iss.code,
          path: ['customFields', def.id, ...iss.path],
          message: iss.message,
        })
      }
    } else {
      values[def.id] = parsed.data
    }
  }

  if (issues.length > 0) return { ok: false, issues }
  return { ok: true, values }
}

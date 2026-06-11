// Pure, DB-free filter & sort spec for Rallypoint Lists v2 (slice 4).
// Both apps/lists-api (translates specs to SQL / applies them in the
// memory repo) and apps/lists-web (builds the filter/sort bar) agree on
// these. No PG — sibling to custom-fields.ts/field-form.ts, unit-tested
// in isolation.
//
// A spec's `field` is either a built-in column name or a custom field
// def id (`lfd_…`). Every field maps to a coarse "kind" that decides
// which operators apply, how a value is coerced, and how rows compare —
// so one set of predicates covers built-ins and custom fields alike.

import type { FieldType } from './validators.js'

export const FILTER_OPS = [
  'eq',
  'neq',
  'contains',
  'gt',
  'gte',
  'lt',
  'lte',
  'is_empty',
  'has_any',
] as const
export type FilterOp = (typeof FILTER_OPS)[number]

export interface FilterSpec {
  field: string
  op: FilterOp
  // Raw string from the query; coerced per kind at eval / SQL time.
  // Absent only for the value-less `is_empty`.
  value?: string
}

export interface SortSpec {
  field: string
  dir: 'asc' | 'desc'
}

export interface ListQuery {
  filters: FilterSpec[]
  sort: SortSpec[]
}

// The coarse comparison kind a field reduces to.
export type FilterKind = 'text' | 'number' | 'date' | 'bool' | 'select' | 'multi'

// Built-in (non-custom) columns that can be filtered/sorted, with the
// kind each reduces to. lists-shared knows only the name→kind map; the
// pg repo owns the actual Drizzle column for each name.
export const BUILTIN_FIELDS: Record<string, FilterKind> = {
  title: 'text',
  notes: 'text',
  assigned_to: 'select',
  completed: 'bool',
  status: 'select',
  priority: 'select',
  due_date: 'date',
  created_at: 'date',
  position: 'number',
}

const FIELD_TYPE_KIND: Record<FieldType, FilterKind> = {
  text: 'text',
  url: 'text',
  number: 'number',
  date: 'date',
  checkbox: 'bool',
  single_select: 'select',
  person: 'select',
  multi_select: 'multi',
}

// Which operators each kind accepts. A spec naming an op outside its
// kind's set is dropped before it can reach SQL.
const OPS_BY_KIND: Record<FilterKind, readonly FilterOp[]> = {
  text: ['eq', 'neq', 'contains', 'is_empty'],
  number: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'is_empty'],
  date: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'is_empty'],
  bool: ['eq'],
  select: ['eq', 'neq', 'is_empty'],
  multi: ['has_any', 'is_empty'],
}

// The operators a kind accepts, for the web filter bar to offer (and to
// keep the bar from building a spec validateListQuery would just drop).
export function opsForKind(kind: FilterKind): readonly FilterOp[] {
  return OPS_BY_KIND[kind]
}

// Minimal field-def shape the query layer reads (FieldDefRecord and the
// web's FieldDefDto both satisfy it structurally).
export interface FieldDefForQuery {
  id: string
  fieldType: FieldType
}

export interface ResolvedField {
  field: string
  source: 'builtin' | 'custom'
  kind: FilterKind
}

// Resolve a spec's field name to its source + kind, or null when it
// names neither a built-in column nor a current def (so a stale saved
// view referencing a deleted field is silently ignored, not a 400).
export function resolveQueryField(field: string, defs: FieldDefForQuery[]): ResolvedField | null {
  const builtin = BUILTIN_FIELDS[field]
  if (builtin) return { field, source: 'builtin', kind: builtin }
  const def = defs.find((d) => d.id === field)
  if (def) return { field, source: 'custom', kind: FIELD_TYPE_KIND[def.fieldType] }
  return null
}

export interface ValidatedFilter extends FilterSpec {
  resolved: ResolvedField
}
export interface ValidatedSort extends SortSpec {
  resolved: ResolvedField
}

// Validate a parsed query against the list's defs: drop filters/sorts
// that name an unknown field, use an op the kind doesn't allow, lack a
// required value, or sort by a non-orderable multi-select. The result
// carries the resolved kind so the repos never re-resolve.
export function validateListQuery(
  query: ListQuery,
  defs: FieldDefForQuery[],
): { filters: ValidatedFilter[]; sort: ValidatedSort[] } {
  const filters: ValidatedFilter[] = []
  for (const f of query.filters) {
    const resolved = resolveQueryField(f.field, defs)
    if (!resolved) continue
    if (!OPS_BY_KIND[resolved.kind].includes(f.op)) continue
    if (f.op !== 'is_empty' && (f.value === undefined || f.value === '')) continue
    // A date filter with an unparseable value would cast-fail in pg (500);
    // drop it so both repos agree on "no rows" (the JS path is NaN-safe).
    if (resolved.kind === 'date' && f.op !== 'is_empty' && Number.isNaN(Date.parse(f.value!)))
      continue
    filters.push({ ...f, resolved })
  }
  const sort: ValidatedSort[] = []
  for (const s of query.sort) {
    const resolved = resolveQueryField(s.field, defs)
    if (!resolved) continue
    if (resolved.kind === 'multi') continue // multi-select has no total order
    sort.push({ ...s, resolved })
  }
  return { filters, sort }
}

// --- query-string encoding (symmetric parse/encode) ------------------
// Wire form: `filter=<field>:<op>[:<value>]` and `sort=<field>:<dir>`,
// each repeatable. Value may itself contain ':' (only the first two
// segments are split off).

export function parseFilterParam(raw: string): FilterSpec | null {
  const first = raw.indexOf(':')
  if (first <= 0) return null
  const field = raw.slice(0, first)
  const rest = raw.slice(first + 1)
  const second = rest.indexOf(':')
  const op = second === -1 ? rest : rest.slice(0, second)
  if (!(FILTER_OPS as readonly string[]).includes(op)) return null
  const spec: FilterSpec = { field, op: op as FilterOp }
  if (second !== -1) spec.value = rest.slice(second + 1)
  return spec
}

export function parseSortParam(raw: string): SortSpec | null {
  const i = raw.indexOf(':')
  if (i <= 0) return null
  const dir = raw.slice(i + 1)
  if (dir !== 'asc' && dir !== 'desc') return null
  return { field: raw.slice(0, i), dir }
}

export function parseListQuery(filterParams: string[], sortParams: string[]): ListQuery {
  return {
    filters: filterParams.map(parseFilterParam).filter((s): s is FilterSpec => s !== null),
    sort: sortParams.map(parseSortParam).filter((s): s is SortSpec => s !== null),
  }
}

export function encodeFilterParam(spec: FilterSpec): string {
  return spec.value === undefined ? `${spec.field}:${spec.op}` : `${spec.field}:${spec.op}:${spec.value}`
}

export function encodeSortParam(spec: SortSpec): string {
  return `${spec.field}:${spec.dir}`
}

// --- predicate evaluation (memory repo) ------------------------------

function isNullish(v: unknown): boolean {
  return v === undefined || v === null || v === ''
}

function isEmptyForKind(kind: FilterKind, v: unknown): boolean {
  if (kind === 'multi') return !Array.isArray(v) || v.length === 0
  return isNullish(v)
}

function cmpNumberOp(op: FilterOp, a: number, b: number): boolean {
  switch (op) {
    case 'eq':
      return a === b
    case 'neq':
      return a !== b
    case 'gt':
      return a > b
    case 'gte':
      return a >= b
    case 'lt':
      return a < b
    case 'lte':
      return a <= b
    default:
      return false
  }
}

// Does one already-resolved item value satisfy a filter? `itemValue` is
// the field's value on the row (built-in or custom_fields[id]); dates
// arrive as ISO strings, numbers as numbers, multi as a string[].
export function evalFilter(
  kind: FilterKind,
  op: FilterOp,
  itemValue: unknown,
  rawValue: string | undefined,
): boolean {
  if (op === 'is_empty') return isEmptyForKind(kind, itemValue)
  switch (kind) {
    case 'text':
    case 'select': {
      const s = itemValue == null ? '' : String(itemValue)
      const v = rawValue ?? ''
      if (op === 'eq') return s === v
      if (op === 'neq') return s !== v
      if (op === 'contains') return s.toLowerCase().includes(v.toLowerCase())
      return false
    }
    case 'bool': {
      if (op !== 'eq') return false
      return (itemValue === true) === (rawValue === 'true')
    }
    case 'number': {
      if (isNullish(itemValue)) return false
      const a = Number(itemValue)
      const b = Number(rawValue)
      if (!Number.isFinite(a) || !Number.isFinite(b)) return false
      return cmpNumberOp(op, a, b)
    }
    case 'date': {
      if (isNullish(itemValue)) return false
      const a = Date.parse(String(itemValue))
      const b = Date.parse(String(rawValue))
      if (Number.isNaN(a) || Number.isNaN(b)) return false
      return cmpNumberOp(op, a, b)
    }
    case 'multi': {
      const arr = Array.isArray(itemValue) ? itemValue : []
      if (op === 'has_any') return rawValue !== undefined && arr.includes(rawValue)
      return false
    }
  }
}

function baseCompare(kind: FilterKind, a: unknown, b: unknown): number {
  switch (kind) {
    case 'number':
      return Number(a) - Number(b)
    case 'date':
      return Date.parse(String(a)) - Date.parse(String(b))
    case 'bool':
      return (a === true ? 1 : 0) - (b === true ? 1 : 0)
    default:
      return String(a).localeCompare(String(b))
  }
}

// Order two resolved values for a sort, nulls/empties last regardless of
// direction (so descending doesn't float unset rows to the top).
export function compareForSort(
  kind: FilterKind,
  a: unknown,
  b: unknown,
  dir: 'asc' | 'desc',
): number {
  const ae = isNullish(a)
  const be = isNullish(b)
  if (ae && be) return 0
  if (ae) return 1
  if (be) return -1
  const base = baseCompare(kind, a, b)
  return dir === 'desc' ? -base : base
}

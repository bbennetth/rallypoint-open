import { and, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm'
import type { BatchItem } from 'drizzle-orm/batch'
import { listItems } from '@rallypoint/lists-db'
import {
  BUILTIN_FIELDS,
  statusMirrorsCompleted,
  type FilterOp,
  type TaskPriority,
  type TaskStatus,
  type ValidatedFilter,
  type ValidatedSort,
} from '@rallypoint/lists-shared'
import type {
  CreateListItemInput,
  ListItemRecord,
  ListItemRepo,
  UpdateListItemInput,
} from '../types.js'
import type { Db } from './db.js'

type Stmt = BatchItem<'sqlite'>

// --- filter & sort SQL (Lists v2 slice 4) ----------------------------
// Translated for SQLite/D1. Semantics must match memory.ts (tested by
// the contract tests). Key differences from the Postgres impl:
//   • ILIKE → lower(col) LIKE lower(?): SQLite's lower() is ASCII-only
//     whereas the memory repo uses JS toLowerCase() which is full Unicode.
//     Best-effort match — for purely ASCII content they are identical.
//   • `has_any` (multi-field containment): D1 has no `@>` / GIN, so the
//     stored array is expanded with json_each and probed for membership
//     (see filterToSql). This is semantically identical to memory.ts.
//   • Custom JSON path: `->> key` extracts a text value from the JSON
//     column. `customFields` is a JSON text column with mode:'json', so
//     drizzle stores and returns it as an object transparently.

const BUILTIN_COLUMN = {
  title: listItems.title,
  notes: listItems.notes,
  assigned_to: listItems.assignedTo,
  completed: listItems.completed,
  status: listItems.status,
  priority: listItems.priority,
  due_date: listItems.dueDate,
  created_at: listItems.createdAt,
  position: listItems.position,
} as const

// Drift guard (#242): BUILTIN_COLUMN must mirror lists-shared's
// BUILTIN_FIELDS (the validation gate that decides a spec resolves to
// `source: 'builtin'`). If the two ever diverge, a validated builtin spec
// would reach `builtinColumn` with no column and embed `sql${undefined}`.
// Assert once at import so a drift fails loudly at startup, not as a
// malformed query at runtime.
for (const field of Object.keys(BUILTIN_FIELDS)) {
  if (!(field in BUILTIN_COLUMN)) {
    throw new Error(`BUILTIN_COLUMN is missing a Drizzle column for builtin field "${field}"`)
  }
}

// Exported for the drift-guard unit test. Every caller passes a field that
// already resolved to `source: 'builtin'` (gated by BUILTIN_FIELDS), so a
// miss here is a programming error — throw rather than build bad SQL.
export function builtinColumn(field: string): SQL {
  const col = BUILTIN_COLUMN[field as keyof typeof BUILTIN_COLUMN]
  if (col === undefined) {
    throw new Error(`No builtin column mapping for field "${field}"`)
  }
  return sql`${col}`
}

// Escape LIKE metacharacters so `contains` is a literal substring match
// (parity with the memory repo's String.includes).
function likeLiteral(v: string): string {
  return `%${v.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
}

// Build a JSON-path expression for a custom field id: `'$.' || fieldId`.
// Used by every custom-field branch in filterToSql / sortToSql so the
// expression is not duplicated across ~6 call sites.
function customPath(field: string): SQL {
  return sql`'$.' || ${field}`
}

function comparison(op: FilterOp, lhs: SQL, rhs: SQL): SQL | null {
  switch (op) {
    case 'eq':
      return sql`${lhs} = ${rhs}`
    case 'neq':
      return sql`${lhs} <> ${rhs}`
    case 'gt':
      return sql`${lhs} > ${rhs}`
    case 'gte':
      return sql`${lhs} >= ${rhs}`
    case 'lt':
      return sql`${lhs} < ${rhs}`
    case 'lte':
      return sql`${lhs} <= ${rhs}`
    default:
      return null
  }
}

// Returns null only when an op/kind combo has no SQL form (guarded by the
// caller). `has_any` (multi) is translated to a json_each containment probe.
function filterToSql(f: ValidatedFilter): SQL | null {
  const { kind, source, field } = f.resolved
  const isCustom = source === 'custom'
  const v = f.value

  if (f.op === 'is_empty') {
    if (isCustom) return sql`json_extract(${listItems.customFields}, ${customPath(field)}) IS NULL`
    const col = builtinColumn(field)
    if (kind === 'text' || kind === 'select') return sql`(${col} IS NULL OR ${col} = '')`
    return sql`${col} IS NULL`
  }

  switch (kind) {
    case 'text':
    case 'select': {
      // SQLite: ILIKE → lower(col) LIKE lower(pattern).
      // lower() is ASCII-only — differs from JS toLowerCase() for non-ASCII.
      const lhs = isCustom
        ? sql`json_extract(${listItems.customFields}, ${customPath(field)})`
        : builtinColumn(field)
      const expr = sql`coalesce(${lhs}, '')`
      if (f.op === 'contains')
        // ESCAPE backslash is needed because likeLiteral may produce
        // backslashes. NOTE: write '\\' in the JS template literal — `'\'`
        // collapses to `ESCAPE ''` (empty), which SQLite rejects at parse
        // time, crashing every `contains` filter. (See artists.ts.)
        return sql`lower(${expr}) LIKE lower(${likeLiteral(v!)}) ESCAPE '\\'`
      return comparison(f.op, expr, sql`${v}`)
    }
    case 'number': {
      const n = Number(v)
      if (!Number.isFinite(n)) return sql`1 = 0`
      const lhs = isCustom
        ? sql`CAST(json_extract(${listItems.customFields}, ${customPath(field)}) AS NUMERIC)`
        : builtinColumn(field)
      return comparison(f.op, lhs, sql`${n}`)
    }
    case 'date': {
      if (isCustom) {
        // Custom date values are stored as ISO text in the JSON blob; ISO-8601
        // lexicographic order == chronological order, so a text compare matches
        // memory.ts.
        const lhs = sql`json_extract(${listItems.customFields}, ${customPath(field)})`
        return comparison(f.op, lhs, sql`${v}`)
      }
      // Builtin date columns (due_date, created_at) are integer epoch-ms. Bind
      // the filter value as epoch-ms too — comparing the integer column to an
      // ISO text literal would make SQLite coerce the text to ~year and always
      // mis-compare. Date.parse matches memory.ts's chronological compare.
      const ms = Date.parse(v!)
      if (Number.isNaN(ms)) return sql`1 = 0`
      return comparison(f.op, builtinColumn(field), sql`${ms}`)
    }
    case 'bool': {
      const want = v === 'true' ? 1 : 0
      if (isCustom) {
        return sql`coalesce(CAST(json_extract(${listItems.customFields}, ${customPath(field)}) AS INTEGER), 0) = ${want}`
      }
      return sql`${builtinColumn(field)} = ${want}`
    }
    case 'multi': {
      // has_any (is_empty handled above): D1 has no Postgres @> / GIN, but
      // SQLite's json_each expands the stored array so containment becomes
      // `EXISTS (… WHERE value = ?)`. The json_type guard restricts the probe
      // to genuine arrays — without it a scalar value would yield one
      // json_each row and false-match, whereas memory's `arr.includes(v)`
      // (mirrored in lists-shared evalFilter) treats a non-array as no match.
      const path = customPath(field)
      return sql`(json_type(${listItems.customFields}, ${path}) = 'array' AND EXISTS (SELECT 1 FROM json_each(${listItems.customFields}, ${path}) WHERE value = ${v}))`
    }
  }
}

// Unlike the filter builders, sortToSql casts custom number/bool values
// with no validation guard. That's safe here for two reasons (#242): (1)
// SQLite's CAST is total — `CAST('abc' AS NUMERIC)` yields 0, it never
// throws the way Postgres `::numeric` would, so a malformed stored value
// can't crash the query (only sort oddly); and (2) validateCustomFields
// normalizes/rejects values on write, so stored custom values are always
// well-typed anyway. NULLs sort last via the explicit `nulls last` below.
function sortToSql(s: ValidatedSort): SQL {
  const { kind, source, field } = s.resolved
  let lhs: SQL
  if (source === 'builtin') {
    lhs = builtinColumn(field)
  } else if (kind === 'number') {
    lhs = sql`CAST(json_extract(${listItems.customFields}, ${customPath(field)}) AS NUMERIC)`
  } else if (kind === 'date') {
    lhs = sql`json_extract(${listItems.customFields}, ${customPath(field)})`
  } else if (kind === 'bool') {
    lhs = sql`CAST(json_extract(${listItems.customFields}, ${customPath(field)}) AS INTEGER)`
  } else {
    lhs = sql`json_extract(${listItems.customFields}, ${customPath(field)})`
  }
  const dir = s.dir === 'desc' ? sql`desc` : sql`asc`
  return sql`${lhs} ${dir} nulls last`
}

// Append-at-end position scalar subquery. D1 lacks the interactive
// transactions needed to make this atomic, so two concurrent inserts can
// compute the same position (both read max=N, both write N+1). This is
// benign: listForList already sorts by (position ASC, createdAt ASC, id ASC),
// so ties break deterministically and the UI shows a stable order. A true fix
// (retry loop on UniqueConstraintError) is deferred until position becomes a
// hard invariant (#352). Position is a display hint, not a unique key.
function appendPosition(listId: string) {
  return sql<number>`(select coalesce(max(${listItems.position}), -1) + 1 from ${listItems} where ${listItems.listId} = ${listId})`
}

function buildUpdateSet(fields: UpdateListItemInput): Record<string, unknown> {
  const set: Record<string, unknown> = { updatedAt: new Date() }
  if (fields.title !== undefined) set.title = fields.title
  if (fields.notes !== undefined) set.notes = fields.notes
  if (fields.assignedTo !== undefined) set.assignedTo = fields.assignedTo
  if (fields.priority !== undefined) set.priority = fields.priority
  if (fields.dueDate !== undefined) set.dueDate = fields.dueDate
  if (fields.customFields !== undefined) set.customFields = fields.customFields
  if (fields.createdBy !== undefined) set.createdBy = fields.createdBy
  if (fields.completed !== undefined) {
    set.completed = fields.completed
    set.completedAt = fields.completed ? new Date() : null
  }
  if (fields.status !== undefined) {
    set.status = fields.status
    if (fields.status !== null) {
      const { completed } = statusMirrorsCompleted(fields.status)
      set.completed = completed
      set.completedAt = completed ? new Date() : null
    }
  }
  // Custom-status linkage (RPL v1.0.0). The route resolves status_id ↔
  // category and dual-writes `status` (above) for the completed mirror;
  // here we just persist the id verbatim. null clears the linkage.
  if (fields.statusId !== undefined) set.statusId = fields.statusId
  // Sub-item parent (RPL v1.0.0). Route-validated; persisted verbatim.
  if (fields.parentId !== undefined) set.parentId = fields.parentId
  if (fields.listId !== undefined) {
    set.listId = fields.listId
    if (fields.position === undefined) set.position = appendPosition(fields.listId)
  }
  if (fields.position !== undefined) set.position = fields.position
  return set
}

// #247: uniform base-only batch collapses to one UPDATE statement.
function patchValuesEqual(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime()
  return a === b
}

export function isCollapsibleBaseBatch(
  items: { id: string; fields: UpdateListItemInput }[],
): boolean {
  if (items.length < 2) return false
  if (items.some(({ fields }) => fields.customFields !== undefined)) return false
  const first = items[0]!.fields
  const firstKeys = Object.keys(first)
  return items.slice(1).every(({ fields }) => {
    const keys = Object.keys(fields)
    if (keys.length !== firstKeys.length) return false
    return firstKeys.every((k) =>
      patchValuesEqual(
        (first as Record<string, unknown>)[k],
        (fields as Record<string, unknown>)[k],
      ),
    )
  })
}

function rowToItem(row: typeof listItems.$inferSelect): ListItemRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    listId: row.listId,
    title: row.title,
    notes: row.notes,
    assignedTo: row.assignedTo,
    completed: row.completed,
    completedAt: row.completedAt,
    status: row.status as TaskStatus | null,
    statusId: row.statusId,
    parentId: row.parentId,
    priority: row.priority as TaskPriority | null,
    dueDate: row.dueDate,
    customFields: (row.customFields ?? {}) as Record<string, unknown>,
    position: row.position,
    seriesId: row.seriesId,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  }
}

export class D1ListItemRepo implements ListItemRepo {
  constructor(private readonly db: Db) {}

  async create(input: CreateListItemInput): Promise<ListItemRecord> {
    const position = input.position ?? appendPosition(input.listId)
    const status = input.status ?? null
    const completedFromStatus = status !== null ? statusMirrorsCompleted(status).completed : false

    const [row] = await this.db
      .insert(listItems)
      .values({
        id: input.id,
        tenantId: input.tenantId,
        listId: input.listId,
        title: input.title,
        notes: input.notes ?? null,
        assignedTo: input.assignedTo ?? null,
        status,
        statusId: input.statusId ?? null,
        parentId: input.parentId ?? null,
        priority: input.priority ?? null,
        dueDate: input.dueDate ?? null,
        completed: completedFromStatus,
        completedAt: completedFromStatus ? new Date() : null,
        customFields: input.customFields ?? {},
        position,
        createdBy: input.createdBy,
      })
      .returning()
    return rowToItem(row!)
  }

  async findById(id: string): Promise<ListItemRecord | null> {
    const rows = await this.db.select().from(listItems).where(eq(listItems.id, id)).limit(1)
    return rows[0] ? rowToItem(rows[0]) : null
  }

  async listForList(
    listId: string,
    opts: {
      includeDeleted?: boolean
      filters?: ValidatedFilter[]
      sort?: ValidatedSort[]
      limit?: number
    } = {},
  ): Promise<ListItemRecord[]> {
    const conds: SQL[] = [eq(listItems.listId, listId)]
    if (!opts.includeDeleted) conds.push(isNull(listItems.deletedAt))

    // Every validated filter now has a SQL form (has_any uses json_each — see
    // filterToSql). filterToSql still returns null for op/kind combos with no
    // SQL representation, which we skip.
    for (const f of opts.filters ?? []) {
      const cond = filterToSql(f)
      if (cond) conds.push(cond)
    }

    const order: SQL[] = [
      ...(opts.sort ?? []).map(sortToSql),
      sql`${listItems.position} asc`,
      sql`${listItems.createdAt} asc`,
      sql`${listItems.id} asc`,
    ]

    // SQLite has no JSON-containment index, so a `has_any` (or unfiltered)
    // query is a per-row json_each scan. `limit` lets the route bound it
    // (LIMIT short-circuits the scan once enough rows match — see #472).
    const base = this.db.select().from(listItems).where(and(...conds)).orderBy(...order)
    const rows = await (opts.limit !== undefined ? base.limit(opts.limit) : base)

    return rows.map(rowToItem)
  }

  async update(id: string, fields: UpdateListItemInput): Promise<ListItemRecord | null> {
    const [row] = await this.db
      .update(listItems)
      .set(buildUpdateSet(fields))
      .where(eq(listItems.id, id))
      .returning()
    return row ? rowToItem(row) : null
  }

  async softDelete(id: string, when: Date): Promise<void> {
    await this.db
      .update(listItems)
      .set({ deletedAt: when, updatedAt: new Date() })
      .where(eq(listItems.id, id))
  }

  async restore(id: string): Promise<void> {
    await this.db
      .update(listItems)
      .set({ deletedAt: null, updatedAt: new Date() })
      .where(eq(listItems.id, id))
  }

  async bulkUpdate(
    listId: string,
    items: { id: string; fields: UpdateListItemInput }[],
  ): Promise<string[]> {
    if (items.length === 0) return []

    // Fast path: uniform base-only patch — one scoped UPDATE statement.
    if (isCollapsibleBaseBatch(items)) {
      const ids = items.map((i) => i.id)
      const rows = await this.db
        .update(listItems)
        .set(buildUpdateSet(items[0]!.fields))
        .where(
          and(
            inArray(listItems.id, ids),
            eq(listItems.listId, listId),
            isNull(listItems.deletedAt),
          ),
        )
        .returning({ id: listItems.id })
      const hit = new Set(rows.map((r) => r.id))
      return ids.filter((id) => hit.has(id))
    }

    // Fallback: per-item updates via db.batch() for atomicity.
    // Each UPDATE is scoped to (id, listId, not-deleted) so stray ids
    // from another list or already-deleted items update nothing.
    const stmts = items.map(({ id, fields }) =>
      this.db
        .update(listItems)
        .set(buildUpdateSet(fields))
        .where(
          and(eq(listItems.id, id), eq(listItems.listId, listId), isNull(listItems.deletedAt)),
        )
        .returning({ id: listItems.id }) as Stmt,
    )

    const results = await this.db.batch(stmts as [Stmt, ...Stmt[]])
    const updated: string[] = []
    for (let i = 0; i < items.length; i++) {
      const rows = results[i] as { id: string }[]
      if (rows.length > 0) updated.push(items[i]!.id)
    }
    return updated
  }

  async bulkSoftDelete(listId: string, itemIds: string[], when: Date): Promise<string[]> {
    if (itemIds.length === 0) return []
    const rows = await this.db
      .update(listItems)
      .set({ deletedAt: when, updatedAt: new Date() })
      .where(
        and(
          inArray(listItems.id, itemIds),
          eq(listItems.listId, listId),
          isNull(listItems.deletedAt),
        ),
      )
      .returning({ id: listItems.id })
    return rows.map((r) => r.id)
  }

  async clearChildParent(listId: string, parentId: string): Promise<number> {
    const rows = await this.db
      .update(listItems)
      .set({ parentId: null, updatedAt: new Date() })
      .where(
        and(
          eq(listItems.listId, listId),
          eq(listItems.parentId, parentId),
          isNull(listItems.deletedAt),
        ),
      )
      .returning({ id: listItems.id })
    return rows.length
  }

  async bulkClearChildParent(listId: string, parentIds: string[]): Promise<number> {
    if (parentIds.length === 0) return 0
    const rows = await this.db
      .update(listItems)
      .set({ parentId: null, updatedAt: new Date() })
      .where(
        and(
          eq(listItems.listId, listId),
          inArray(listItems.parentId, parentIds),
          isNull(listItems.deletedAt),
        ),
      )
      .returning({ id: listItems.id })
    return rows.length
  }
}

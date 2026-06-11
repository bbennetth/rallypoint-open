import { z } from 'zod'
import { viewConfigField } from './views.js'

// Cross-target validators for Rallypoint Lists. apps/lists-api
// validates request bodies with these; apps/lists-web reuses the same
// schemas client-side so users see field errors before a network
// round trip. Evolve the rules HERE, never in two places. Mirrors
// @rallypoint/events-shared's field-builder style.

// --- Enums -----------------------------------------------------------

// The V1 list types. `tasks` carries the status/priority/due-date
// kanban extension; `standard` is the plain check-off list that covers
// generic purposes (packing, meals, …) with the generic item fields;
// `shopping` is a standard-shaped check-off list (title = item,
// completed = purchased) given its own discriminator so the Plan hub
// can route a shopping-specific surface to it; `notes` is a standard-
// shaped list whose items are free-form notes (title = heading, the
// generic `notes` column = body) — its own discriminator lets a
// consumer route a notes surface to it and hide it from task lists.
// None of these adds a column — the discriminator lives in the one core
// `lists` row (DB column is plain text, no check constraint, so adding a
// type needs no migration). Task-only columns stay null on non-task types.
export const LIST_TYPES = ['tasks', 'standard', 'shopping', 'notes'] as const
export const listTypeField = z.enum(LIST_TYPES)
export type ListType = (typeof LIST_TYPES)[number]

// List visibility within its scope. Two values (#128 dropped 'custom'):
//   all     = any member of the list's scope can read.
//   private = the list creator + anyone they've explicitly shared with
//             via the share-by-email flow (the shared-with set lives
//             in `list_shares`).
// 'custom' was the original third value but its semantics collapsed
// into 'private' once shares-by-email became the user-facing surface.
export const VISIBILITIES = ['all', 'private'] as const
export const visibilityField = z.enum(VISIBILITIES)
export type Visibility = (typeof VISIBILITIES)[number]

// Scope discriminator (locked scope decision 3): 'group' references an
// Events group_id opaquely (was 'crew' before the Phase R rename);
// 'list_group' references a Lists-local list_groups row. Distinct values
// so callers can tell where to resolve the scope_id.
export const SCOPE_TYPES = ['group', 'list_group'] as const
export const scopeTypeField = z.enum(SCOPE_TYPES)
export type ScopeType = (typeof SCOPE_TYPES)[number]

// --- Field-level building blocks -------------------------------------

// List display name. Matches lists.name (notNull) — 1–100 chars after
// trimming.
export const listNameField = z
  .string()
  .trim()
  .min(1, 'List name is required.')
  .max(100, 'List name must be at most 100 characters.')

// Opaque scope identifier: a group_<ulid> (scope_type=group) or a
// list-group id (scope_type=group). Validated as a non-empty bounded
// string here; cross-schema referential integrity is enforced at the
// app layer, not the DB (no cross-schema FKs).
export const scopeIdField = z
  .string()
  .trim()
  .min(1, 'Scope id is required.')
  .max(64, 'Scope id must be at most 64 characters.')

// Optional UI color tag. Empty string normalises to null. Matches
// lists.color (nullable).
export const listColorField = z
  .string()
  .trim()
  .max(32, 'Color must be at most 32 characters.')
  .transform((s) => (s.length === 0 ? null : s))
  .nullable()
  .optional()

// --- Request schemas -------------------------------------------------

// POST /api/v1/ui/lists — create a list. visibility defaults to 'all'
// when omitted.
export const CreateListSchema = z.object({
  name: listNameField,
  listType: listTypeField,
  scopeType: scopeTypeField,
  scopeId: scopeIdField,
  visibility: visibilityField.default('all'),
  color: listColorField,
})

export type CreateListInput = z.infer<typeof CreateListSchema>

// --- List items (slice 2) --------------------------------------------

// The membership roles a user can hold in a list group. The creator is
// auto-enrolled as 'owner'.
export const GROUP_ROLES = ['owner', 'sidekick', 'member'] as const
export const groupRoleField = z.enum(GROUP_ROLES)
export type GroupRole = (typeof GROUP_ROLES)[number]

// Item title. Matches list_items.title (notNull) — 1–200 chars trimmed.
export const itemTitleField = z
  .string()
  .trim()
  .min(1, 'Item title is required.')
  .max(200, 'Item title must be at most 200 characters.')

// Optional free-form notes. Empty string normalises to null. Matches
// list_items.notes (nullable).
export const itemNotesField = z
  .string()
  .trim()
  .max(2000, 'Notes must be at most 2000 characters.')
  .transform((s) => (s.length === 0 ? null : s))
  .nullable()
  .optional()

// Optional single-owner assignee (a Rallypoint ID user_<ulid>). Empty
// string normalises to null. Matches list_items.assigned_to (nullable).
export const assignedToField = z
  .string()
  .trim()
  .max(64, 'Assignee id must be at most 64 characters.')
  .transform((s) => (s.length === 0 ? null : s))
  .nullable()
  .optional()

// Per-list integer ordering. The app appends at max+1 when omitted; a
// reorder is a position PATCH (Events nested-CRUD convention).
export const positionField = z
  .number()
  .int('Position must be an integer.')
  .min(0, 'Position must be non-negative.')

// --- Task-type item extensions (slice 3) -----------------------------

// Task workflow state (festival-planner port). Only `tasks` lists set
// this; other types leave it null. For a task list `status` is the
// source of truth and the app mirrors completed/completed_at off it.
export const TASK_STATUSES = ['todo', 'in_progress', 'done'] as const
export const taskStatusField = z.enum(TASK_STATUSES)
export type TaskStatus = (typeof TASK_STATUSES)[number]

// Task priority (festival-planner port). Defaults to 'medium' server-side.
export const TASK_PRIORITIES = ['low', 'medium', 'high'] as const
export const taskPriorityField = z.enum(TASK_PRIORITIES)
export type TaskPriority = (typeof TASK_PRIORITIES)[number]

// Optional task due date. Accepts an ISO-8601 string or epoch-ms number
// on the wire; '' and null normalise to null. Normalises to an ISO
// string so the parsed shape is JSON-symmetric across client and server
// (the API route casts it to a Date for the timestamptz column).
// transform is inner (then .nullable().optional()) so an OMITTED dueDate
// stays undefined — matching itemNotesField, and keeping the UpdateList-
// ItemSchema empty-patch superRefine honest.
export const dueDateField = z
  .union([z.string(), z.number()])
  .transform((v, ctx) => {
    if (v === '') return null
    const d = new Date(v)
    if (Number.isNaN(d.getTime())) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Due date is not a valid date.' })
      return z.NEVER
    }
    return d.toISOString()
  })
  .nullable()
  .optional()

// POST /api/v1/ui/lists/:listId/items — create an item. position is
// optional (the app appends when omitted). status/priority/dueDate are
// task-only; the route defaults status→'todo' and priority→'medium' for
// task-type lists and leaves them null for other types.
// Custom-field values keyed by field-def id (`lfd_…`). The schema only
// asserts the wire shape (an object of unknown values); per-type and
// per-def validation is dynamic — the route runs `validateCustomFields`
// against the list's field defs (a static schema can't know them). A
// `null` value clears that key on PATCH.
export const customFieldsField = z.record(z.unknown())

export const CreateListItemSchema = z.object({
  title: itemTitleField,
  notes: itemNotesField,
  assignedTo: assignedToField,
  position: positionField.optional(),
  status: taskStatusField.optional(),
  // priority on create: omitted → 'medium' (backward-compat server default);
  // explicit null → no-priority (null stored); any enum value → that value.
  // .default() fills only undefined, so null passes through unchanged.
  priority: taskPriorityField.nullable().optional().default('medium'),
  dueDate: dueDateField,
  customFields: customFieldsField.optional(),
})
export type CreateListItemInput = z.infer<typeof CreateListItemSchema>

// PATCH /api/v1/ui/lists/:listId/items/:itemId — sparse update. Every
// field optional; at least one must be present. Covers check-off
// (completed), inline edit (title/notes), reorder (position) and
// re-assign (assignedTo). nulls clear the nullable columns.
// listId is the cross-list move target (slice 3). Bounded like scopeId;
// referential integrity (target exists + access) is checked app-side.
export const moveTargetListIdField = z
  .string()
  .trim()
  .min(1, 'Target list id is required.')
  .max(64, 'Target list id must be at most 64 characters.')

export const UpdateListItemSchema = z
  .object({
    title: itemTitleField.optional(),
    notes: itemNotesField,
    assignedTo: assignedToField,
    completed: z.boolean().optional(),
    position: positionField.optional(),
    status: taskStatusField.optional(),
    priority: taskPriorityField.nullable().optional(),
    dueDate: dueDateField,
    listId: moveTargetListIdField.optional(),
    customFields: customFieldsField.optional(),
  })
  .superRefine((v, ctx) => {
    if (Object.values(v).every((x) => x === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [],
        message: 'At least one field must be supplied.',
      })
    }
  })
export type UpdateListItemInput = z.infer<typeof UpdateListItemSchema>

// --- Bulk item actions (Lists v2 slice 6) ----------------------------

// A bounded set of item ids to act on in one request. Non-empty (an
// empty selection is a client bug, not a no-op to swallow) and capped at
// 200 so a single bulk call can't fan out unboundedly. Each id is bounded
// like any list-item id; cross-list ids are silently ignored server-side
// (the repo scopes every write to :listId), not rejected.
export const bulkItemIdsField = z
  .array(z.string().trim().min(1, 'Item id is required.').max(64))
  .min(1, 'At least one item id is required.')
  .max(200, 'At most 200 items may be acted on at once.')
  // Dedupe (first occurrence wins) at the boundary so a repeated id can't
  // inflate the updated/deleted count or do redundant work downstream —
  // applies uniformly to update + delete and both repo code paths (#247).
  .transform((ids) => [...new Set(ids)])

// The bulk-applicable patch — the subset of UpdateListItemSchema that
// makes sense to set identically across many rows. title/notes are
// per-item content and position/listId are per-item placement/move, so
// they're intentionally absent: a bulk op sets a shared attribute
// (check-off, assignee, task fields, a custom-field value), it doesn't
// rename or move. A plain ZodObject (no refine) so it can sit inside the
// discriminated union; the empty-patch guard lives on the union below.
const bulkItemPatchSchema = z.object({
  completed: z.boolean().optional(),
  assignedTo: assignedToField,
  status: taskStatusField.optional(),
  priority: taskPriorityField.nullable().optional(),
  dueDate: dueDateField,
  customFields: customFieldsField.optional(),
})
export type BulkItemPatchInput = z.infer<typeof bulkItemPatchSchema>

// POST /api/v1/ui/lists/:listId/items/bulk — apply one action across a
// set of items in a single transaction. `update` carries a non-empty
// patch (validated below); `delete` soft-deletes the set and carries no
// patch. Discriminated on `action` so an unknown action is a clean
// rejection rather than a silently-ignored field.
export const BulkItemActionSchema = z
  .discriminatedUnion('action', [
    z.object({
      action: z.literal('update'),
      itemIds: bulkItemIdsField,
      patch: bulkItemPatchSchema,
    }),
    z.object({
      action: z.literal('delete'),
      itemIds: bulkItemIdsField,
    }),
  ])
  .superRefine((v, ctx) => {
    if (v.action === 'update' && Object.values(v.patch).every((x) => x === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['patch'],
        message: 'At least one field must be supplied.',
      })
    }
  })
export type BulkItemActionInput = z.infer<typeof BulkItemActionSchema>

// --- Custom field definitions (Lists v2) -----------------------------

// The user-definable field (column) types. Stored as plain text on
// list_field_defs.field_type with NO DB check constraint (the enum lives
// here, mirroring list_type/visibility). A field's type is IMMUTABLE
// after creation — changing it would invalidate every stored value — so
// UpdateFieldDefSchema omits it.
export const FIELD_TYPES = [
  'text',
  'number',
  'date',
  'checkbox',
  'single_select',
  'multi_select',
  'person',
  'url',
] as const
export const fieldTypeField = z.enum(FIELD_TYPES)
export type FieldType = (typeof FIELD_TYPES)[number]

const SELECT_FIELD_TYPES = new Set<FieldType>(['single_select', 'multi_select'])
export function isSelectFieldType(t: FieldType): boolean {
  return SELECT_FIELD_TYPES.has(t)
}

// Renameable display name for a field. The stable `key` slug (derived
// once at create time) is the per-list identifier; values key off the
// field def's id, so a label rename never orphans data.
export const fieldLabelField = z
  .string()
  .trim()
  .min(1, 'Field label is required.')
  .max(60, 'Field label must be at most 60 characters.')

// A single choice on a select-type field. `id` is an `opt_<ulid>` minted
// server-side — it is what stored values reference (rename-stable). On
// create the client omits id (server mints one per choice); on update
// the client echoes the id of a choice it is editing and omits it for a
// brand-new choice. `archived` soft-removes a choice so historical values
// still resolve a label.
export const SelectChoiceInputSchema = z.object({
  id: z.string().trim().max(40).optional(),
  label: z
    .string()
    .trim()
    .min(1, 'Choice label is required.')
    .max(60, 'Choice label must be at most 60 characters.'),
  color: z.string().trim().max(32, 'Choice color must be at most 32 characters.').optional(),
  archived: z.boolean().optional(),
})
export type SelectChoiceInput = z.infer<typeof SelectChoiceInputSchema>

export const fieldChoicesField = z
  .array(SelectChoiceInputSchema)
  .max(100, 'A select field may have at most 100 choices.')

// POST /api/v1/ui/lists/:listId/fields — define a custom field. `key` is
// derived server-side from the label (not client-supplied). Select types
// require at least one choice; non-select types reject choices; the
// `multiline` flag is text-only. These cross-field rules live here
// because the create payload self-describes its type; the update schema
// can't (it omits fieldType), so the route enforces them against the
// stored def.
export const CreateFieldDefSchema = z
  .object({
    label: fieldLabelField,
    fieldType: fieldTypeField,
    required: z.boolean().optional().default(false),
    multiline: z.boolean().optional(),
    choices: fieldChoicesField.optional(),
    position: positionField.optional(),
  })
  .superRefine((v, ctx) => {
    if (isSelectFieldType(v.fieldType)) {
      if (!v.choices || v.choices.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['choices'],
          message: 'A select field requires at least one choice.',
        })
      }
    } else if (v.choices !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['choices'],
        message: 'Only select fields accept choices.',
      })
    }
    if (v.multiline !== undefined && v.fieldType !== 'text') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['multiline'],
        message: 'Only text fields accept the multiline flag.',
      })
    }
  })
export type CreateFieldDefInput = z.infer<typeof CreateFieldDefSchema>

// PATCH /api/v1/ui/lists/:listId/fields/:fieldId — sparse update. Every
// field optional; at least one must be present. fieldType is immutable so
// it is absent here. The route validates choices-vs-type and
// multiline-vs-type against the stored def's fieldType.
export const UpdateFieldDefSchema = z
  .object({
    label: fieldLabelField.optional(),
    required: z.boolean().optional(),
    multiline: z.boolean().optional(),
    choices: fieldChoicesField.optional(),
    position: positionField.optional(),
  })
  .superRefine((v, ctx) => {
    if (Object.values(v).every((x) => x === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [],
        message: 'At least one field must be supplied.',
      })
    }
  })
export type UpdateFieldDefInput = z.infer<typeof UpdateFieldDefSchema>

// Derive a stable slug from a label: lowercase, runs of non-alphanumerics
// → '_', trim leading/trailing '_', cap at 40. Falls back to 'field' when
// a label slugs to empty (e.g. all punctuation).
export function slugifyFieldKey(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40)
    .replace(/_+$/g, '')
  return slug.length > 0 ? slug : 'field'
}

// Make a label's slug unique within a set of already-taken keys by
// suffixing `_2`, `_3`, … (keeping the whole key within 40 chars).
export function uniqueFieldKey(label: string, existing: Iterable<string>): string {
  const taken = new Set(existing)
  const base = slugifyFieldKey(label)
  if (!taken.has(base)) return base
  for (let i = 2; ; i++) {
    const suffix = `_${i}`
    const candidate = `${base.slice(0, 40 - suffix.length)}${suffix}`
    if (!taken.has(candidate)) return candidate
  }
}

// --- Saved views (Lists v2 slice 5) ----------------------------------

// View display name. Matches list_views.name (notNull) — 1–100 chars.
export const viewNameField = z
  .string()
  .trim()
  .min(1, 'View name is required.')
  .max(100, 'View name must be at most 100 characters.')

// POST /api/v1/ui/lists/:listId/views — save a view. config defaults to
// the empty config when omitted (an as-yet-unconfigured view). position
// is optional (the app appends at max+1 when omitted).
export const CreateListViewSchema = z.object({
  name: viewNameField,
  config: viewConfigField.optional(),
  position: positionField.optional(),
})
export type CreateListViewInput = z.infer<typeof CreateListViewSchema>

// PATCH /api/v1/ui/lists/:listId/views/:viewId — sparse update. Every
// field optional; at least one must be present. Covers rename (name),
// reconfigure (config) and reorder (position).
export const UpdateListViewSchema = z
  .object({
    name: viewNameField.optional(),
    config: viewConfigField.optional(),
    position: positionField.optional(),
  })
  .superRefine((v, ctx) => {
    if (Object.values(v).every((x) => x === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [],
        message: 'At least one field must be supplied.',
      })
    }
  })
export type UpdateListViewInput = z.infer<typeof UpdateListViewSchema>

// --- List groups (slice 2) -------------------------------------------

// Group display name. Matches list_groups.name (notNull) — 1–100 chars.
export const groupNameField = z
  .string()
  .trim()
  .min(1, 'Group name is required.')
  .max(100, 'Group name must be at most 100 characters.')

// Optional group description. Empty string normalises to null. Matches
// list_groups.description (nullable).
export const groupDescriptionField = z
  .string()
  .trim()
  .max(1000, 'Description must be at most 1000 characters.')
  .transform((s) => (s.length === 0 ? null : s))
  .nullable()
  .optional()

// POST /api/v1/ui/groups — create a group (creator auto-enrolled owner).
export const CreateGroupSchema = z.object({
  name: groupNameField,
  description: groupDescriptionField,
})
export type CreateGroupInput = z.infer<typeof CreateGroupSchema>

// PATCH /api/v1/ui/groups/:groupId — sparse update. Every field
// optional; at least one must be present.
export const UpdateGroupSchema = z
  .object({
    name: groupNameField.optional(),
    description: groupDescriptionField,
  })
  .superRefine((v, ctx) => {
    if (Object.values(v).every((x) => x === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [],
        message: 'At least one field must be supplied.',
      })
    }
  })
export type UpdateGroupInput = z.infer<typeof UpdateGroupSchema>

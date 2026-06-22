import { describe, it, expect } from 'vitest'
import {
  BulkItemActionSchema,
  CreateFieldDefSchema,
  CreateGroupSchema,
  CreateListItemSchema,
  CreateListSchema,
  UpdateFieldDefSchema,
  UpdateGroupSchema,
  UpdateListItemSchema,
} from './validators.js'

describe('CreateListSchema', () => {
  const base = {
    name: 'Camp tasks',
    listType: 'tasks',
    scopeType: 'group',
    scopeId: 'grp_01H',
  }

  it('accepts a valid minimal payload and defaults visibility to all', () => {
    const parsed = CreateListSchema.parse(base)
    expect(parsed.visibility).toBe('all')
    expect(parsed.name).toBe('Camp tasks')
    expect(parsed.color).toBeUndefined()
  })

  it('trims the name', () => {
    expect(CreateListSchema.parse({ ...base, name: '  Meals  ' }).name).toBe('Meals')
  })

  it('rejects an empty name', () => {
    expect(CreateListSchema.safeParse({ ...base, name: '   ' }).success).toBe(false)
  })

  it('rejects an unknown list type', () => {
    expect(CreateListSchema.safeParse({ ...base, listType: 'bogus' }).success).toBe(false)
  })

  it('accepts the chores list type (#546)', () => {
    expect(CreateListSchema.safeParse({ ...base, listType: 'chores' }).success).toBe(true)
  })

  it('rejects an unknown scope type', () => {
    expect(CreateListSchema.safeParse({ ...base, scopeType: 'org' }).success).toBe(false)
  })

  it('rejects a missing scope id', () => {
    expect(CreateListSchema.safeParse({ ...base, scopeId: '' }).success).toBe(false)
  })

  it('accepts each list type', () => {
    for (const listType of ['tasks', 'standard', 'shopping', 'notes']) {
      expect(CreateListSchema.safeParse({ ...base, listType }).success).toBe(true)
    }
  })

  it('normalises an empty color string to null', () => {
    expect(CreateListSchema.parse({ ...base, color: '' }).color).toBeNull()
  })

  it("rejects the dropped 'custom' visibility value (#128)", () => {
    // 'custom' collapsed into 'private' + list_shares. Validator rejects it.
    expect(() => CreateListSchema.parse({ ...base, visibility: 'custom' })).toThrow()
  })

  it("accepts 'private' visibility", () => {
    expect(CreateListSchema.parse({ ...base, visibility: 'private' }).visibility).toBe('private')
  })
})

describe('CreateListItemSchema', () => {
  it('accepts a minimal payload (title only)', () => {
    const parsed = CreateListItemSchema.parse({ title: 'Buy ice' })
    expect(parsed.title).toBe('Buy ice')
    expect(parsed.position).toBeUndefined()
  })

  it('trims the title', () => {
    expect(CreateListItemSchema.parse({ title: '  Pack tent  ' }).title).toBe('Pack tent')
  })

  it('rejects an empty title', () => {
    expect(CreateListItemSchema.safeParse({ title: '   ' }).success).toBe(false)
  })

  it('rejects a title over 200 chars', () => {
    expect(CreateListItemSchema.safeParse({ title: 'x'.repeat(201) }).success).toBe(false)
  })

  it('normalises empty notes and assignedTo to null', () => {
    const parsed = CreateListItemSchema.parse({ title: 'A', notes: '', assignedTo: '' })
    expect(parsed.notes).toBeNull()
    expect(parsed.assignedTo).toBeNull()
  })

  it('rejects a negative position', () => {
    expect(CreateListItemSchema.safeParse({ title: 'A', position: -1 }).success).toBe(false)
  })

  it('rejects a non-integer position', () => {
    expect(CreateListItemSchema.safeParse({ title: 'A', position: 1.5 }).success).toBe(false)
  })

  it('accepts task status, priority, and an ISO due date', () => {
    const parsed = CreateListItemSchema.parse({
      title: 'Pack',
      status: 'in_progress',
      priority: 'high',
      dueDate: '2026-06-01T12:00:00.000Z',
    })
    expect(parsed.status).toBe('in_progress')
    expect(parsed.priority).toBe('high')
    expect(parsed.dueDate).toBe('2026-06-01T12:00:00.000Z')
  })

  it('normalises an epoch-ms due date to an ISO string', () => {
    const ms = Date.UTC(2026, 5, 1, 12, 0, 0)
    expect(CreateListItemSchema.parse({ title: 'A', dueDate: ms }).dueDate).toBe(
      new Date(ms).toISOString(),
    )
  })

  it('leaves dueDate undefined when omitted', () => {
    expect(CreateListItemSchema.parse({ title: 'A' }).dueDate).toBeUndefined()
  })

  it('normalises an empty / null due date to null', () => {
    expect(CreateListItemSchema.parse({ title: 'A', dueDate: '' }).dueDate).toBeNull()
    expect(CreateListItemSchema.parse({ title: 'A', dueDate: null }).dueDate).toBeNull()
  })

  it('rejects an unparseable due date', () => {
    expect(CreateListItemSchema.safeParse({ title: 'A', dueDate: 'not-a-date' }).success).toBe(
      false,
    )
  })

  it('rejects an unknown status or priority', () => {
    expect(CreateListItemSchema.safeParse({ title: 'A', status: 'blocked' }).success).toBe(false)
    expect(CreateListItemSchema.safeParse({ title: 'A', priority: 'urgent' }).success).toBe(false)
  })

  // Four create-priority behaviours (the design fix — #430):
  it('defaults priority to medium when omitted', () => {
    // Backward-compat: other callers that omit priority continue to get medium.
    expect(CreateListItemSchema.parse({ title: 'A' }).priority).toBe('medium')
  })

  it('passes explicit null priority through as null (no-priority)', () => {
    // New: quick-add sends priority:null; the schema must not coerce it to medium.
    expect(CreateListItemSchema.parse({ title: 'A', priority: null }).priority).toBeNull()
  })

  it('passes a valid priority value through unchanged', () => {
    expect(CreateListItemSchema.parse({ title: 'A', priority: 'high' }).priority).toBe('high')
  })

  it('rejects an invalid priority string even with nullable', () => {
    expect(CreateListItemSchema.safeParse({ title: 'A', priority: 'bad' }).success).toBe(false)
  })
})

describe('UpdateListItemSchema', () => {
  it('accepts a single field (completed)', () => {
    expect(UpdateListItemSchema.parse({ completed: true }).completed).toBe(true)
  })

  it('accepts a position-only reorder', () => {
    expect(UpdateListItemSchema.parse({ position: 3 }).position).toBe(3)
  })

  it('rejects an empty patch body', () => {
    expect(UpdateListItemSchema.safeParse({}).success).toBe(false)
  })

  it('rejects an empty title when present', () => {
    expect(UpdateListItemSchema.safeParse({ title: '  ' }).success).toBe(false)
  })

  it('clears notes with an empty string', () => {
    expect(UpdateListItemSchema.parse({ notes: '' }).notes).toBeNull()
  })

  it('accepts a status-only patch', () => {
    expect(UpdateListItemSchema.parse({ status: 'done' }).status).toBe('done')
  })

  it('accepts a cross-list move via listId', () => {
    expect(UpdateListItemSchema.parse({ listId: 'lst_target' }).listId).toBe('lst_target')
  })

  it('rejects an empty listId move target', () => {
    expect(UpdateListItemSchema.safeParse({ listId: '' }).success).toBe(false)
  })

  it('clears a due date with null', () => {
    expect(UpdateListItemSchema.parse({ dueDate: null }).dueDate).toBeNull()
  })

  it('accepts priority: null to clear the field', () => {
    expect(UpdateListItemSchema.parse({ priority: null }).priority).toBeNull()
  })

  it('rejects an unrecognised priority string', () => {
    expect(UpdateListItemSchema.safeParse({ priority: 'urgent' }).success).toBe(false)
  })
})

describe('BulkItemActionSchema', () => {
  it('accepts an update action with a single-field patch', () => {
    const parsed = BulkItemActionSchema.parse({
      action: 'update',
      itemIds: ['lit_a', 'lit_b'],
      patch: { completed: true },
    })
    expect(parsed.action).toBe('update')
    expect(parsed.itemIds).toEqual(['lit_a', 'lit_b'])
  })

  it('accepts a delete action without a patch', () => {
    const parsed = BulkItemActionSchema.parse({ action: 'delete', itemIds: ['lit_a'] })
    expect(parsed.action).toBe('delete')
  })

  it('dedupes repeated itemIds, first occurrence wins (#247)', () => {
    const parsed = BulkItemActionSchema.parse({
      action: 'update',
      itemIds: ['lit_b', 'lit_a', 'lit_b', 'lit_a'],
      patch: { completed: true },
    })
    expect(parsed.itemIds).toEqual(['lit_b', 'lit_a'])
  })

  it('rejects an empty itemIds array', () => {
    expect(
      BulkItemActionSchema.safeParse({ action: 'delete', itemIds: [] }).success,
    ).toBe(false)
  })

  it('rejects more than 200 itemIds', () => {
    const ids = Array.from({ length: 201 }, (_, i) => `lit_${i}`)
    expect(
      BulkItemActionSchema.safeParse({ action: 'delete', itemIds: ids }).success,
    ).toBe(false)
  })

  it('rejects an update action with an empty patch', () => {
    expect(
      BulkItemActionSchema.safeParse({ action: 'update', itemIds: ['lit_a'], patch: {} }).success,
    ).toBe(false)
  })

  it('rejects an unknown action', () => {
    expect(
      BulkItemActionSchema.safeParse({ action: 'archive', itemIds: ['lit_a'] }).success,
    ).toBe(false)
  })

  it('normalises an empty assignee to null in the patch', () => {
    const parsed = BulkItemActionSchema.parse({
      action: 'update',
      itemIds: ['lit_a'],
      patch: { assignedTo: '' },
    })
    expect(parsed.action === 'update' && parsed.patch.assignedTo).toBeNull()
  })

  it('rejects a bad task status in the patch', () => {
    expect(
      BulkItemActionSchema.safeParse({
        action: 'update',
        itemIds: ['lit_a'],
        patch: { status: 'bogus' },
      }).success,
    ).toBe(false)
  })

  it('accepts priority: null in the bulk patch to clear the field', () => {
    const parsed = BulkItemActionSchema.parse({
      action: 'update',
      itemIds: ['lit_a'],
      patch: { priority: null },
    })
    expect(parsed.action).toBe('update')
    if (parsed.action === 'update') expect(parsed.patch.priority).toBeNull()
  })

  it('rejects an unrecognised priority string in the bulk patch', () => {
    expect(
      BulkItemActionSchema.safeParse({
        action: 'update',
        itemIds: ['lit_a'],
        patch: { priority: 'urgent' },
      }).success,
    ).toBe(false)
  })
})

describe('CreateGroupSchema', () => {
  it('accepts a name-only payload', () => {
    expect(CreateGroupSchema.parse({ name: 'Group A' }).name).toBe('Group A')
  })

  it('rejects an empty name', () => {
    expect(CreateGroupSchema.safeParse({ name: '   ' }).success).toBe(false)
  })

  it('normalises an empty description to null', () => {
    expect(CreateGroupSchema.parse({ name: 'Group A', description: '' }).description).toBeNull()
  })
})

describe('UpdateGroupSchema', () => {
  it('accepts a name-only patch', () => {
    expect(UpdateGroupSchema.parse({ name: 'Renamed' }).name).toBe('Renamed')
  })

  it('rejects an empty patch body', () => {
    expect(UpdateGroupSchema.safeParse({}).success).toBe(false)
  })
})

describe('CreateFieldDefSchema', () => {
  it('accepts a minimal text field and defaults required to false', () => {
    const parsed = CreateFieldDefSchema.parse({ label: 'Notes', fieldType: 'text' })
    expect(parsed.required).toBe(false)
  })

  it('requires at least one choice for a select field', () => {
    expect(
      CreateFieldDefSchema.safeParse({ label: 'Store', fieldType: 'single_select' }).success,
    ).toBe(false)
    expect(
      CreateFieldDefSchema.safeParse({
        label: 'Store',
        fieldType: 'single_select',
        choices: [{ label: 'Costco' }],
      }).success,
    ).toBe(true)
  })

  it('rejects choices on a non-select field', () => {
    expect(
      CreateFieldDefSchema.safeParse({
        label: 'Budget',
        fieldType: 'number',
        choices: [{ label: 'nope' }],
      }).success,
    ).toBe(false)
  })

  it('rejects the multiline flag on a non-text field', () => {
    expect(
      CreateFieldDefSchema.safeParse({ label: 'Due', fieldType: 'date', multiline: true }).success,
    ).toBe(false)
    expect(
      CreateFieldDefSchema.safeParse({ label: 'Notes', fieldType: 'text', multiline: true }).success,
    ).toBe(true)
  })
})

describe('UpdateFieldDefSchema', () => {
  it('accepts a label-only patch', () => {
    expect(UpdateFieldDefSchema.parse({ label: 'Renamed' }).label).toBe('Renamed')
  })

  it('rejects an empty patch body', () => {
    expect(UpdateFieldDefSchema.safeParse({}).success).toBe(false)
  })

  it('accepts a falsy-but-present sole field (required:false)', () => {
    // Guards against an "at least one" check that mistakes `false` for absent.
    const parsed = UpdateFieldDefSchema.safeParse({ required: false })
    expect(parsed.success).toBe(true)
    expect(parsed.success && parsed.data.required).toBe(false)
  })

  it('has no fieldType key (type is immutable)', () => {
    const parsed = UpdateFieldDefSchema.parse({ label: 'X', fieldType: 'number' }) as Record<
      string,
      unknown
    >
    expect(parsed.fieldType).toBeUndefined()
  })
})

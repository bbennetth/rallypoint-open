// The shopping list's per-item quantity, expressed as a Lists custom field.
//
// Quantity is NOT a planner-specific backend concept — it is an ordinary
// Lists v2 custom field def (`text`) on the user's shopping list, so the
// value rides on the generic `list_items.custom_fields` blob and every
// existing SDK read/write path carries it unchanged. The BFF's only job is
// to make sure the def exists and to tell the client which field id to read
// and write, since custom_fields is keyed by field-def id, not by name.
//
// Free-form `text` rather than `number`: shoppers write "2", but also
// "4 bags" and "3 cs".

import type { FieldDefDto, ListsClient } from '@rallypoint/lists-client'

// lists-api derives a per-list-unique key slug from the label, so the def
// created from 'Quantity' lands on key 'quantity'.
export const QUANTITY_FIELD_LABEL = 'Quantity'
export const QUANTITY_FIELD_KEY = 'quantity'

// The quantity def's id among a list's field defs, or null if undefined.
// Pure — matches on the derived key, never on the label (which the user can
// rename from the Lists UI without breaking the planner's reads).
export function selectQuantityFieldId(defs: readonly FieldDefDto[]): string | null {
  return defs.find((d) => d.key === QUANTITY_FIELD_KEY)?.id ?? null
}

// Find-or-create the shopping list's quantity field def and return its id.
//
// Re-lists after creating rather than trusting the create response: two
// concurrent first-loads can both create, and the loser's def gets a
// deduped key ('quantity_2'). Re-reading picks whichever def actually owns
// the canonical key, so both requests agree on one id and the stray def is
// simply unused.
//
// Returns null instead of throwing when the SDK misbehaves — a shopping
// list that can't resolve its quantity field should still load (the client
// hides the chip and editor), not 500. Mirrors the non-fatal settings read
// in routes/shopping.ts.
export async function ensureQuantityFieldDef(
  lists: ListsClient,
  listId: string,
  actor: string,
): Promise<string | null> {
  try {
    const existing = selectQuantityFieldId(await lists.listFieldDefs(listId, actor))
    if (existing) return existing
    await lists.createFieldDef(
      listId,
      { label: QUANTITY_FIELD_LABEL, fieldType: 'text', required: false },
      actor,
    )
    return selectQuantityFieldId(await lists.listFieldDefs(listId, actor))
  } catch {
    return null
  }
}

import { Hono } from 'hono'
import type { ListsClient } from '@rallypoint/lists-client'
import type { HonoApp } from '../context.js'
import { requireSession } from '../middleware/session.js'
import { proxyLists } from '../lib/sdk-error.js'
import { resolveDiaryList } from '../lib/personal-scope.js'

// Planner Diary BFF (capture-only v1). A single system-managed `diary`-type
// list per user holding dated journal entries; mood + arbitrary metrics ride
// the generic custom-fields machinery. The list is auto-provisioned on first
// access and a default "Mood" field is seeded so the tab works out of the box.
//
// This is the ONLY diary-specific BFF route: entry + field CRUD reuse the
// generic /api/v1/ui/lists/:listId/{items,fields} routes (which authorize any
// of the caller's personal lists), keeping planner-api thin and the domain
// logic in Lists. The diary list is excluded from every task surface by
// excludeDiaryLists, so entries never leak into My Day / Tasks / Upcoming.

export const MOOD_FIELD_LABEL = 'Mood'

// A 5-point mood scale seeded on first provision. Choices are emoji + word so
// they read on a chip; the server mints a stable id per choice that stored
// values reference (rename-safe).
const MOOD_CHOICES = [
  { label: '😞 Rough' },
  { label: '😕 Low' },
  { label: '😐 Okay' },
  { label: '🙂 Good' },
  { label: '😄 Great' },
]

// Seed the default Mood field once. Idempotent: skips if a field labelled
// "Mood" already exists (guards the first-access create race + manual deletes
// staying deleted is not a concern since we only seed right after creating).
async function seedMoodField(lists: ListsClient, listId: string, actor: string): Promise<void> {
  const defs = await lists.listFieldDefs(listId)
  if (defs.some((d) => d.label === MOOD_FIELD_LABEL)) return
  await lists.createFieldDef(
    listId,
    { label: MOOD_FIELD_LABEL, fieldType: 'single_select', required: false, choices: MOOD_CHOICES },
    actor,
  )
}

export const diaryRoutes = new Hono<HonoApp>()
  // --- get THE caller's diary list (auto-provision + seed Mood on first use) ---
  .get('/api/v1/ui/diary/list', requireSession(), async (c) => {
    const actor = c.var.session!.userId
    const lists = c.var.services.listsClient
    const list = await proxyLists(async () => {
      const { list, created } = await resolveDiaryList(lists, actor)
      if (created) await seedMoodField(lists, list.id, actor)
      return list
    })
    return c.json(list)
  })

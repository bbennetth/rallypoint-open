// Reading and reconciling a template's place in the training plan.
//
// A workout's schedule is not a field on the template — it's a separate
// training-plan item pointing at the template (`sourceId`). So the
// composer's SCHEDULE chips can't be hydrated from `getWodTemplate`
// alone, and saving an edit can't just append: an already-scheduled
// workout has to be moved or unscheduled instead of duplicated.
//
// The decision (`planScheduleAction`) is pure so it can be unit-tested;
// the IO wrappers compose the existing typed api.ts calls and the
// tested `nextPositionInDay`, the same way plan-add.ts does.

import { DAY_KEYS, type DayKey, type TrainingPlanItemDto } from '@rallypoint/fitness-shared'
import {
  deleteTrainingPlanItem,
  listTrainingPlanItems,
  listTrainingPlans,
  patchTrainingPlanItem,
} from './api.js'
import { nextPositionInDay } from './plan-build.js'
import { pickActivePlanId, readStoredActivePlanId } from './plan-add.js'

/** Where a template currently sits in the plan, as far as the composer
 *  cares: which plan, which item row, which day. */
export interface ScheduledPlacement {
  planId: string
  itemId: string
  dayKey: DayKey
}

export type ScheduleAction = 'skip' | 'add' | 'move' | 'remove'

/** What saving should do to the plan, given where the template is now
 *  and which day the user left selected. `chosen === null` is the "Not
 *  scheduled" chip. */
export function planScheduleAction(
  current: { dayKey: DayKey } | null,
  chosen: DayKey | null,
): ScheduleAction {
  if (!current) return chosen ? 'add' : 'skip'
  if (!chosen) return 'remove'
  return chosen === current.dayKey ? 'skip' : 'move'
}

/** Find the plan item that scheduled `templateId`, if any.
 *
 *  The chips can only express one day, so a template sitting on two
 *  days has to pick one: the earliest weekday, by `DAY_KEYS` order.
 *  Server order can't be relied on for this — the API sorts by the
 *  `dayKey` text column, which is alphabetical (`fri` before `mon`),
 *  so taking the first row would hydrate a Tue+Fri template to Fri.
 *  Editing such a template moves only the day shown and leaves the
 *  other placement in the plan; that's a limitation of a single-day
 *  picker, not something this fix tries to solve. */
export function findPlacementForTemplate(
  items: readonly TrainingPlanItemDto[],
  planId: string,
  templateId: string,
): ScheduledPlacement | null {
  // An unrecognized dayKey sorts last rather than first: indexOf would
  // give it -1, which would beat every real weekday. The API validates
  // every write against the same DAY_KEYS enum, so this is belt-and-
  // braces against a hand-edited or future-schema row.
  const rank = (d: DayKey): number => {
    const i = DAY_KEYS.indexOf(d)
    return i === -1 ? DAY_KEYS.length : i
  }
  let match: TrainingPlanItemDto | null = null
  for (const it of items) {
    if (it.sourceId !== templateId) continue
    if (!match || rank(it.dayKey) < rank(match.dayKey)) match = it
  }
  if (!match) return null
  return { planId, itemId: match.id, dayKey: match.dayKey }
}

/** Resolve the active plan WITHOUT bootstrapping one. Hydration is a
 *  read — a user with no plans yet should not get an empty "My plan"
 *  created just by opening a workout for editing (plan-add.ts's
 *  `resolveActivePlanId` is the create-on-demand variant, used on save). */
async function resolveActivePlanIdForRead(): Promise<string | null> {
  const { trainingPlans } = await listTrainingPlans()
  return pickActivePlanId(readStoredActivePlanId(), trainingPlans)
}

/** Look up where `templateId` is scheduled in the active plan. Returns
 *  null when there's no plan or no item pointing at the template. */
export async function loadPlacementForTemplate(
  templateId: string,
): Promise<ScheduledPlacement | null> {
  const planId = await resolveActivePlanIdForRead()
  if (!planId) return null
  const { items } = await listTrainingPlanItems(planId)
  return findPlacementForTemplate(items, planId, templateId)
}

/** Apply a 'move' or 'remove' to an existing placement. ('add' goes
 *  through plan-add.ts's `addToActivePlan`, which bootstraps a plan.) */
export async function applyPlacementChange(
  placement: ScheduledPlacement,
  chosen: DayKey | null,
): Promise<void> {
  if (!chosen) {
    await deleteTrainingPlanItem(placement.planId, placement.itemId)
    return
  }
  const { items } = await listTrainingPlanItems(placement.planId)
  await patchTrainingPlanItem(placement.planId, placement.itemId, {
    dayKey: chosen,
    position: nextPositionInDay(items, chosen),
  })
}


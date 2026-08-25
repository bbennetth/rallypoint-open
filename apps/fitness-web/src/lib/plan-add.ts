// Shared "add a workout to the active plan" flow, used by the
// composer's Schedule picker and the WOD library drawer's Add-to-plan
// action. Both surfaces live outside PlanPage, so they can't reuse its
// loaded state — this module resolves the active plan (with the same
// lazy "My plan" bootstrap PlanPage does) and appends an item at the
// end of the chosen day.
//
// The pure selection logic (`pickActivePlanId`) is split from the IO
// wrapper so it can be unit-tested; the IO functions compose the
// existing typed api.ts calls and the tested `nextPositionInDay`.

import type { DayKey, PlanSourceKind, TrainingPlanDto } from '@rallypoint/fitness-shared'
import {
  addTrainingPlanItem,
  createTrainingPlan,
  listTrainingPlanItems,
  listTrainingPlans,
} from './api.js'
import { nextPositionInDay } from './plan-build.js'

/** The localStorage slot PlanPage stamps with the active plan id.
 *  Single source of truth — PlanPage and the composer import this. */
export const ACTIVE_PLAN_KEY = 'rp-fitness-active-plan'

export function readStoredActivePlanId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_PLAN_KEY)
  } catch {
    return null
  }
}

function stampActivePlanId(id: string): void {
  try {
    localStorage.setItem(ACTIVE_PLAN_KEY, id)
  } catch {
    /* ignore quota errors */
  }
}

/** Pick the plan the add should target: the stored active plan when it
 *  still exists, otherwise the first plan, otherwise null (no plans —
 *  caller bootstraps one). Mirrors PlanPage's heal-the-active-id rule. */
export function pickActivePlanId(
  storedId: string | null,
  plans: readonly Pick<TrainingPlanDto, 'id'>[],
): string | null {
  if (storedId && plans.some((p) => p.id === storedId)) return storedId
  return plans[0]?.id ?? null
}

/** Resolve the active plan id, lazily creating "My plan" for a user who
 *  has none (the server's find-or-create makes this idempotent). Stamps
 *  the localStorage slot when it had to fall back or bootstrap, so
 *  PlanPage and this helper agree on the active plan afterwards. */
export async function resolveActivePlanId(): Promise<string> {
  const stored = readStoredActivePlanId()
  const { trainingPlans } = await listTrainingPlans()
  const picked = pickActivePlanId(stored, trainingPlans)
  if (picked) {
    if (picked !== stored) stampActivePlanId(picked)
    return picked
  }
  const created = await createTrainingPlan({ name: 'My plan' })
  stampActivePlanId(created.trainingPlan.id)
  return created.trainingPlan.id
}

/** Append an item at the end of `dayKey` in `planId` (fetches the
 *  current items to compute the dense next position — the server
 *  stores positions verbatim). */
export async function appendTrainingPlanItem(
  planId: string,
  dayKey: DayKey,
  source: { sourceKind: PlanSourceKind; sourceId: string },
): Promise<void> {
  const { items } = await listTrainingPlanItems(planId)
  await addTrainingPlanItem(planId, {
    dayKey,
    position: nextPositionInDay(items, dayKey),
    sourceKind: source.sourceKind,
    sourceId: source.sourceId,
  })
}

/** One-shot: resolve the active plan (bootstrapping if needed) and
 *  append. Returns the plan id it wrote to. */
export async function addToActivePlan(
  dayKey: DayKey,
  source: { sourceKind: PlanSourceKind; sourceId: string },
): Promise<string> {
  const planId = await resolveActivePlanId()
  await appendTrainingPlanItem(planId, dayKey, source)
  return planId
}

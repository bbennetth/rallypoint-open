// Pure mapping from a finished live strength session to the
// createWorkout payload. Extracted from StrengthSessionPage.saveToLog
// so the filtering rules (done-only sets, zero-amount junk dropped,
// per-set achieved RPE forwarded) are unit-tested.

import type {
  CreateWorkoutInput,
  StrengthSessionState,
  WorkoutWeather,
} from '@rallypoint/fitness-shared'
import { strengthTonnage } from '@rallypoint/fitness-shared'

export function buildStrengthWorkoutPayload(
  state: StrengthSessionState,
  sessionRpe: number | null,
  performedAtIso: string,
  weather?: WorkoutWeather | null,
): CreateWorkoutInput {
  const sets = state.blocks.flatMap((b, blockIdx) =>
    b.sets
      .filter((s) => s.done)
      .map((s, setIdx) => ({
        exerciseId: b.exerciseId,
        // Widened from *100 to *1000 (code-review sweep #675) — a free
        // session with >=100 sets in one block previously collided
        // with the next block's setIndex range.
        setIndex: blockIdx * 1000 + setIdx,
        // `|| undefined` intentionally drops zeroes too — a completed
        // set with a 0 amount is junk entry, not data worth logging.
        // (A null load is bodyweight and is dropped the same way.)
        reps: s.reps || undefined,
        loadKg: s.reps != null ? s.loadKg || undefined : undefined,
        calories: s.calories || undefined,
        distanceM: s.distanceM || undefined,
        timeS: s.timeS || undefined,
        // Incline only means something on distance/time (running) work —
        // guard so a stray value on a rep set can't reach the API, which
        // rejects incline on rep/calorie sets.
        inclinePct:
          s.distanceM || s.timeS ? (s.inclinePct != null ? s.inclinePct : undefined) : undefined,
        // Achieved per-set RPE (workout_sets.rpe accepts integers 1-10;
        // the live control only offers integers).
        rpe: s.rpe ?? undefined,
        setType: s.setType ?? 'working',
      })),
  )
  const payload: CreateWorkoutInput = {
    performedAt: performedAtIso,
    modality: 'strength',
    title: state.templateName,
    durationS: state.elapsedS,
    sets,
    payload: {
      sessionId: state.sessionId,
      // Source-template link (custom templates only) so History can
      // offer "update the template" later. Absent for free sessions
      // and pre-link legacy sessions.
      ...(state.templateId ? { templateId: state.templateId } : {}),
      // Which template started this session, custom OR benchmark —
      // unlike templateId above there's no ownership gate, because this
      // one only marks the scheduled plan row done on the /log
      // dashboard. Absent for free sessions.
      ...(state.sourceTemplateId ? { sourceTemplateId: state.sourceTemplateId } : {}),
      tonnageKg: strengthTonnage(state),
      // Point-in-time weather snapshot (running/outdoor sessions) — the
      // same Open-Meteo pipeline Planner's My Day uses. Best-effort:
      // absent when geolocation was declined or the fetch failed.
      ...(weather ? { weather } : {}),
    },
  }
  if (sessionRpe != null) payload.rpe = sessionRpe
  return payload
}

// Shared read of the exercise catalog, reduced to the id→name map that
// every movement-rendering surface needs (see exercise-label.ts).
//
// For pages that don't otherwise need the catalog. A page that ALREADY
// holds a `useCachedQuery(exercisesQuery())` result — ComposerPage,
// PlanPage, HistoryView — should call buildExerciseNameMap() on that
// result instead; calling this hook as well would open a second,
// redundant subscription to the same cache key.

import { useMemo } from 'react'
import { exercisesQuery } from './api.js'
import { useCachedQuery } from './offline/use-cached-query.js'
import { buildExerciseNameMap } from './exercise-label.js'

/** exerciseId → name, from the cached catalog. Empty until the first
 *  read resolves; exerciseLabel() degrades to its fallback in that
 *  window rather than blocking a render. */
export function useExerciseNames(): ReadonlyMap<string, string> {
  const exercisesQ = useCachedQuery(useMemo(() => exercisesQuery(), []))
  return useMemo(() => buildExerciseNameMap(exercisesQ.data ?? []), [exercisesQ.data])
}

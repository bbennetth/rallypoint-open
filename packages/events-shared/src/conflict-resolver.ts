// Pure conflict detection for the My Day aggregator (slice 9b, #131).
//
// Given a day's lineup sets (as [start, end) instant ranges, built by
// schedule-logic.setRange) and a list of point-in-time "due things" (a group
// task's due_date, a rally's start), flag every due thing that lands inside
// one or more sets. This is the "you scheduled a task / meet-up in the
// middle of a set you wanted to catch" warning. All instants are epoch ms in
// the common UTC frame the schedule-logic module composes.

import type { SetRange } from './schedule-logic.js'

// A lineup set carrying a human label for the warning UI.
export interface LabeledSet extends SetRange {
  label: string
}

// A single instant that might fall inside a set: a task due or a rally start.
export interface DueThing {
  id: string
  title: string
  at: number // epoch ms
  kind: 'task' | 'rally'
}

// A detected clash: the due thing plus the set(s) it overlaps.
export interface Conflict {
  id: string
  title: string
  kind: 'task' | 'rally'
  at: number
  sets: LabeledSet[]
}

// Flag each due thing whose instant falls within any set. The range is
// half-open: a thing exactly at a set's start conflicts; one exactly at the
// end does not (that's when the next thing can begin). A thing inside
// several overlapping sets reports all of them.
export function findConflicts(sets: LabeledSet[], things: DueThing[]): Conflict[] {
  const conflicts: Conflict[] = []
  for (const thing of things) {
    const overlapping = sets.filter((s) => thing.at >= s.start && thing.at < s.end)
    if (overlapping.length > 0) {
      conflicts.push({
        id: thing.id,
        title: thing.title,
        kind: thing.kind,
        at: thing.at,
        sets: overlapping,
      })
    }
  }
  return conflicts
}

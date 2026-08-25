import { asc } from 'drizzle-orm'
import { muscleGroups, muscles } from '@rallypoint/fitness-db'
import type { MuscleGroupRecord, MuscleRepo } from '../types.js'
import type { Db } from './db.js'

// The muscle taxonomy is small fixed reference data (seeded), so this reads
// the whole set in two queries and assembles the 2-level shape in memory.
export class D1MuscleRepo implements MuscleRepo {
  constructor(private readonly db: Db) {}

  async listTaxonomy(): Promise<MuscleGroupRecord[]> {
    const [groups, allMuscles] = await Promise.all([
      this.db.select().from(muscleGroups).orderBy(asc(muscleGroups.sort)),
      this.db.select().from(muscles).orderBy(asc(muscles.sort)),
    ])
    const byGroup = new Map<string, MuscleGroupRecord>()
    for (const g of groups) {
      byGroup.set(g.id, { id: g.id, name: g.name, sort: g.sort, muscles: [] })
    }
    for (const m of allMuscles) {
      byGroup.get(m.groupId)?.muscles.push({ id: m.id, name: m.name, sort: m.sort })
    }
    return groups.map((g) => byGroup.get(g.id)!)
  }
}

import { and, eq } from 'drizzle-orm'
import { exerciseMachineSettings } from '@rallypoint/fitness-db'
import type { MachineSettingEntryRow, MachineSettingsRepo } from '../types.js'
import type { Db } from './db.js'

export class D1MachineSettingsRepo implements MachineSettingsRepo {
  constructor(private readonly db: Db) {}

  async get(actorUserId: string, exerciseId: string): Promise<MachineSettingEntryRow[]> {
    const row = await this.db
      .select({ entries: exerciseMachineSettings.entries })
      .from(exerciseMachineSettings)
      .where(
        and(
          eq(exerciseMachineSettings.userId, actorUserId),
          eq(exerciseMachineSettings.exerciseId, exerciseId),
        ),
      )
      .get()
    if (!row) return []
    // A corrupt entries blob must degrade to "no settings", not 500 the
    // exercise surface.
    try {
      const parsed = JSON.parse(row.entries) as unknown
      return Array.isArray(parsed) ? (parsed as MachineSettingEntryRow[]) : []
    } catch {
      return []
    }
  }

  async put(
    actorUserId: string,
    exerciseId: string,
    entries: MachineSettingEntryRow[],
  ): Promise<MachineSettingEntryRow[]> {
    if (entries.length === 0) {
      await this.db
        .delete(exerciseMachineSettings)
        .where(
          and(
            eq(exerciseMachineSettings.userId, actorUserId),
            eq(exerciseMachineSettings.exerciseId, exerciseId),
          ),
        )
        .run()
      return []
    }

    const json = JSON.stringify(entries)
    await this.db
      .insert(exerciseMachineSettings)
      .values({
        userId: actorUserId,
        exerciseId,
        entries: json,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [exerciseMachineSettings.userId, exerciseMachineSettings.exerciseId],
        set: { entries: json, updatedAt: new Date() },
      })
      .run()
    return entries
  }
}

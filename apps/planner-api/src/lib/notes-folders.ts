import type { ListDto, ListItemDto } from '@rallypoint/lists-client'

// Pure helpers for the Planner notes-folders surface (#549). Folders are
// multiple `notes`-type lists in the personal group; these decisions are
// extracted from the route so they can be unit-tested in isolation.

// A note enriched with the id of the folder (notes list) it lives in, so the
// UI can attribute + group notes even when fetching across all folders.
export type NoteWithFolder = ListItemDto & { folderId: string }

// Normalise a folder name for duplicate detection: trimmed + case-folded.
// Two folders collide when their normalised names match.
export function normalizeFolderName(name: string): string {
  return name.trim().toLocaleLowerCase()
}

// Does a live folder with the same (normalised) name already exist? Used to
// reject a duplicate folder create with 409.
export function folderNameTaken(folders: ListDto[], name: string): boolean {
  const target = normalizeFolderName(name)
  return folders.some((f) => normalizeFolderName(f.name) === target)
}

// Is `folderId` one of the actor's notes folders? Gates the move target on a
// note PATCH and the folder-scoped GET filter.
export function isOwnedFolder(folders: ListDto[], folderId: string): boolean {
  return folders.some((f) => f.id === folderId)
}

// The default folder is the oldest notes list (selectNotesLists is already
// oldest-first), i.e. folders[0]. Returns null when the user has no folders.
export function defaultFolder(folders: ListDto[]): ListDto | null {
  return folders[0] ?? null
}

// Tag a folder's items with its id for the cross-folder GET response.
export function tagNotes(items: ListItemDto[], folderId: string): NoteWithFolder[] {
  return items.map((it) => ({ ...it, folderId }))
}

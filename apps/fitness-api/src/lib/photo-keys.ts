import { PROGRESS_PHOTO_MIME_EXTENSIONS, type ProgressPhotoMimeType } from '@rallypoint/fitness-shared'

// Object key for a progress photo — opaque + PII-free, immutable per photo (a
// photo's bytes never change; edits touch only the row). Lives here rather than
// in the upload route because the data-import route mints keys the same way for
// the photos it restores.
export function photoKeyFor(
  userId: string,
  photoId: string,
  contentType: ProgressPhotoMimeType,
): string {
  return `progress-photos/${userId}/${photoId}.${PROGRESS_PHOTO_MIME_EXTENSIONS[contentType]}`
}

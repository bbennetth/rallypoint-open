import { createKeysetCursorCodec } from '@rallypoint/api-kit'

// Opaque cursor codec for the admin audit log (keyed on (createdAt, id) DESC).
// No legacy hook: the endpoint never had a cursor before this change, so every
// cursor it sees is a v1 token it minted itself.
export const auditCursorCodec = createKeysetCursorCodec()

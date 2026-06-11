import type { EventDto, PatchEventInput, PrivacyMode } from './api.js'

// The editable subset of an event surfaced by the owner Settings details
// form. Kept flat (strings + the privacy enum) so the form binds directly.
export interface EventDetailsDraft {
  name: string
  description: string
  startDate: string
  endDate: string
  locationLabel: string
  privacyMode: PrivacyMode
}

// Seed a draft from the persisted event (snake_case → form strings).
export function eventDetailsDraft(event: EventDto): EventDetailsDraft {
  return {
    name: event.name,
    description: event.description ?? '',
    startDate: event.start_date ?? '',
    endDate: event.end_date ?? '',
    locationLabel: event.location_label ?? '',
    privacyMode: event.privacy_mode,
  }
}

// Diff a draft against the event, emitting only the changed fields as a
// PatchEventInput. Mirrors the legacy EventDetailPage edit form: text
// fields that go empty are cleared with ''; dates have no null in the API,
// so an emptied date is treated as "no change" rather than a clear.
export function buildEventPatch(event: EventDto, draft: EventDetailsDraft): PatchEventInput {
  const fields: PatchEventInput = {}

  const name = draft.name.trim()
  if (name !== event.name) fields.name = name

  const description = draft.description.trim()
  if (description !== (event.description ?? '')) fields.description = description

  if (draft.startDate !== (event.start_date ?? '') && draft.startDate) {
    fields.startDate = draft.startDate
  }
  if (draft.endDate !== (event.end_date ?? '') && draft.endDate) {
    fields.endDate = draft.endDate
  }

  const locationLabel = draft.locationLabel.trim()
  if (locationLabel !== (event.location_label ?? '')) fields.locationLabel = locationLabel

  if (draft.privacyMode !== event.privacy_mode) fields.privacyMode = draft.privacyMode

  return fields
}

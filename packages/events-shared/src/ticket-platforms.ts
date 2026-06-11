import { z } from 'zod'

// Curated ticketing platforms for personal events (Planner). A personal
// event can be tagged with the platform its tickets live on + the account
// email used, so the UI can deep-link to that platform's login page —
// "where my tickets are." NO credentials are ever stored; the email is the
// user's own account identifier (a plaintext label), never a secret.
//
// The list is deliberately short and well-known. `loginUrl` is a curated
// static map so Events-web and Planner-web render identical links; `other`
// (loginUrl null) is the escape hatch for any platform not listed (incl.
// regional/niche ones) — it stores the email but renders no deep link.
// URL rot is acceptable per the issue; keep entries to confidently-known
// sign-in/account pages that redirect to login when signed out.

export interface TicketPlatformMeta {
  /** Stable enum id stored on the event row. */
  id: string
  /** Human label for the selector + link text. */
  label: string
  /** Sign-in/account URL, or null for `other` (no deep link). */
  loginUrl: string | null
}

export const TICKET_PLATFORMS = [
  { id: 'ticketmaster', label: 'Ticketmaster', loginUrl: 'https://www.ticketmaster.com/member' },
  { id: 'axs', label: 'AXS', loginUrl: 'https://www.axs.com/account' },
  { id: 'stubhub', label: 'StubHub', loginUrl: 'https://www.stubhub.com/login' },
  { id: 'seatgeek', label: 'SeatGeek', loginUrl: 'https://seatgeek.com/login' },
  { id: 'eventbrite', label: 'Eventbrite', loginUrl: 'https://www.eventbrite.com/signin/' },
  { id: 'dice', label: 'DICE', loginUrl: 'https://dice.fm/account' },
  { id: 'other', label: 'Other', loginUrl: null },
] as const

export type TicketPlatform = (typeof TICKET_PLATFORMS)[number]['id']

// z.enum needs a non-empty string tuple; derive it from the curated list so
// the validator can never drift from TICKET_PLATFORMS.
const TICKET_PLATFORM_IDS = TICKET_PLATFORMS.map((p) => p.id) as [
  TicketPlatform,
  ...TicketPlatform[],
]

/** Validates a ticket-platform id; nullable+optional (null clears it). */
export const ticketPlatformField = z
  .enum(TICKET_PLATFORM_IDS, { errorMap: () => ({ message: 'Unknown ticket platform.' }) })
  .nullable()
  .optional()

/** Look up a platform's metadata by id (null for unknown/empty). */
export function ticketPlatformMeta(id: string | null | undefined): TicketPlatformMeta | null {
  if (!id) return null
  return TICKET_PLATFORMS.find((p) => p.id === id) ?? null
}

/** Human label for a platform id, or null when unknown/empty. */
export function ticketPlatformLabel(id: string | null | undefined): string | null {
  return ticketPlatformMeta(id)?.label ?? null
}

/** Curated login URL for a platform id, or null for `other`/unknown/empty
 * (caller should render no deep link). */
export function ticketPlatformLoginUrl(id: string | null | undefined): string | null {
  return ticketPlatformMeta(id)?.loginUrl ?? null
}

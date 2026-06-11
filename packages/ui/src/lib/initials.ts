// Pure helpers for the <Avatar> fallback (no image set). Extracted so
// the initials + deterministic-colour rules can be unit-tested without
// rendering. Shared across every app's user chrome.

export interface InitialsInput {
  firstName?: string | null
  lastName?: string | null
  // The (non-unique) display name — RPID's `username` column.
  name?: string | null
  email?: string | null
}

// Up to two uppercase letters, picked in priority order:
//   1. first + last initial   (J + D → "JD")
//   2. the display name        (two words → word initials; one word →
//                               its first two letters)
//   3. the email local-part    (first letter before "@")
//   4. "?"                      (nothing usable)
export function initials(input: InitialsInput): string {
  const first = (input.firstName ?? '').trim()
  const last = (input.lastName ?? '').trim()
  if (first && last) return (first[0]! + last[0]!).toUpperCase()
  if (first) return takeFrom(first)
  if (last) return takeFrom(last)

  const name = (input.name ?? '').trim()
  if (name) {
    const words = name.split(/\s+/).filter(Boolean)
    if (words.length >= 2) {
      // Strip punctuation per word so "@jane #doe" → "JD", not "@#".
      const combo = firstLetter(words[0]!) + firstLetter(words[1]!)
      if (combo) return combo
    }
    return takeFrom(words[0]!)
  }

  const email = (input.email ?? '').trim()
  if (email) {
    const local = email.split('@')[0]!
    if (local) return takeFrom(local)
  }
  return '?'
}

// First one or two alphanumeric characters of a single token.
function takeFrom(token: string): string {
  const cleaned = token.replace(/[^\p{L}\p{N}]/gu, '')
  if (!cleaned) return '?'
  return cleaned.slice(0, 2).toUpperCase()
}

// First alphanumeric character of a token, uppercased ('' if none).
function firstLetter(token: string): string {
  const cleaned = token.replace(/[^\p{L}\p{N}]/gu, '')
  return cleaned ? cleaned[0]!.toUpperCase() : ''
}

// Deterministic background colour for the initials fallback so the
// same user always gets the same swatch. Hash the seed into a fixed
// palette (cyber-brutalist accents that read against white initials).
export const AVATAR_BG_PALETTE = [
  '#1F6FEB', // blue
  '#D2691E', // orange
  '#8957E5', // purple
  '#DB61A2', // pink
  '#CF222E', // red
  '#2DA44E', // green
] as const

export function avatarBackground(seed: string): string {
  let hash = 0
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0
  }
  const idx = Math.abs(hash) % AVATAR_BG_PALETTE.length
  return AVATAR_BG_PALETTE[idx]!
}

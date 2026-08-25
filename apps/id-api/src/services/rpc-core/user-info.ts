import type { UserInfo } from '@rallypoint/shared'
import { avatarPictureUrl } from '../../avatar-url.js'

// `toUserInfo` was previously co-located with the session HTTP handler
// (apps/id-api/src/routes/auth/session.ts). It is now imported by both
// the HTTP handler and the IdRPC core fns, so it lives here.

export function toUserInfo(
  u: {
    id: string
    email: string
    emailVerified: boolean
    username: string
    firstName: string | null
    lastName: string | null
    pictureUrl: string | null
    avatarKey: string | null
    updatedAt: Date
  },
  publicBaseUrl: string,
): UserInfo {
  return {
    sub: u.id as `user_${string}`,
    email: u.email,
    email_verified: u.emailVerified,
    preferred_username: u.username,
    name: u.username,
    first_name: u.firstName,
    last_name: u.lastName,
    picture: avatarPictureUrl(u, publicBaseUrl),
    updated_at: u.updatedAt.toISOString(),
  }
}

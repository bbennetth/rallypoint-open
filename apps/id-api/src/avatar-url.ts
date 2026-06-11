// Compute the publicly exposed avatar picture URL for a user. When an
// avatar has been uploaded (avatarKey set), the URL is a stable id-api
// route that 302-redirects to a short-lived presigned GET — so the
// object key itself never leaks and the URL survives re-uploads. When
// no avatar is uploaded, fall back to any externally-set pictureUrl.
export function avatarPictureUrl(
  user: { id: string; avatarKey: string | null; pictureUrl: string | null },
  publicBaseUrl: string,
): string | null {
  if (user.avatarKey) return `${publicBaseUrl}/api/v1/avatars/${user.id}`
  return user.pictureUrl
}

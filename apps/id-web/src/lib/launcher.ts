// Shape of one launcher tile from GET /api/v1/ui/apps.
export interface LauncherApp {
  client: string
  name: string
  url: string
}

// Single-character badge for an app tile. Uses the first character of
// the display name (falling back to the client id, then '?') so a
// blank name never renders an empty badge.
export function appInitial(app: Pick<LauncherApp, 'name' | 'client'>): string {
  const source = app.name.trim() || app.client.trim()
  return (source.charAt(0) || '?').toUpperCase()
}

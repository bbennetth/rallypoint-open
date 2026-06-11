// Outbound link targets. The app-subdomain + RPID URLs are baked at build
// time from VITE_* vars (injected by the deploy-www job, derived from the
// target env); each falls back to its local-dev port so `vite dev` works
// with no env. The open-source repo URL is a fixed public constant.

const env = import.meta.env

export const RPID_UI_URL =
  (env.VITE_RPID_UI_URL as string | undefined) ?? 'http://localhost:5173'
export const EVENTS_WEB_URL =
  (env.VITE_EVENTS_WEB_URL as string | undefined) ?? 'http://localhost:5174'
export const PLANNER_WEB_URL =
  (env.VITE_PLANNER_WEB_URL as string | undefined) ?? 'http://localhost:5177'

export const OPEN_REPO_URL = 'https://github.com/bbennetth/rallypoint-open'

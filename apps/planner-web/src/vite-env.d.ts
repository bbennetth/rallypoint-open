/// <reference types="vite/client" />

interface ImportMetaEnv {
  // Origins of the sibling Rallypoint web apps, used by the app-switcher
  // fly-out to navigate cross-app. Unset → the row shows a toast instead.
  readonly VITE_EVENTS_WEB_URL?: string
  readonly VITE_LISTS_WEB_URL?: string
  readonly VITE_ID_WEB_URL?: string
  // Workspace version, injected at build time (see vite.config.ts `define`);
  // rendered in the app-switcher version eyebrow.
  readonly VITE_APP_VERSION?: string
  // VAPID public key (base64url) for Web Push — the browser's
  // applicationServerKey. Safe to ship to clients; set as a repo Variable in
  // CI (cf-deploy.yml). Unset → the notifications toggle reports unsupported.
  readonly VITE_VAPID_PUBLIC_KEY?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

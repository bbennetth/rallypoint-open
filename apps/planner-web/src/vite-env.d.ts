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
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

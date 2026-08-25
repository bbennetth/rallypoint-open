# Rallypoint Planner — web SPA

Vite + React app for `planner.rallypt.{app,dev}`. Bundled as static
assets and served from the **planner-api** Cloudflare Worker (the
SPA + the BFF live at the same origin so cookies / service worker
scope behave like a single app).

## Build → serve flow

The deploy pipeline (`.github/workflows/cf-deploy.yml`, `deploy`
matrix → `planner-api` row) does:

```sh
npm run build -w @rallypoint/planner-web   # vite + vite-plugin-pwa
rm -rf apps/planner-api/public
cp -r apps/planner-web/dist apps/planner-api/public
wrangler deploy --env <qa|prod>            # apps/planner-api/wrangler.toml
```

`apps/planner-api/public/` is the Worker's `[assets]` dir. After the
copy it contains the SPA shell (`index.html` + hashed `assets/*`) and
the PWA artifacts (`sw.js`, `sw.js.map`, `registerSW.js`,
`manifest.webmanifest`, `icons/`). All of those are build output —
gitignored via the `apps/*-api/public/*` rule in `.gitignore`. The
only tracked file in that dir is the placeholder `index.html`, which
keeps `wrangler dev` happy pre-build and is overwritten at deploy.

## Service worker (vite-plugin-pwa, `injectManifest`)

- **Source**: `apps/planner-web/src/sw.ts` — hand-written Workbox SW
  (see `vite.config.ts` `VitePWA({ strategy: 'injectManifest' })`).
- **Built artifact**: `apps/planner-web/dist/sw.js` → copied to
  `apps/planner-api/public/sw.js`.
- **Served from**: `https://planner.rallypt.{app,dev}/sw.js`.
- **Scope**: `/` (single-origin app, so the SW controls every route).
- **Registration**: auto via `registerType: 'autoUpdate'` +
  `injectRegister: 'auto'` (vite-plugin-pwa injects the registration
  script into the SPA shell at build time).

Because the SPA and the BFF share an origin, the SW can also see the
`/api/v1/*` traffic — useful for the offline-first work being
planned (Slice O5 of the planner-offline epic). Cross-origin SDK
calls (id-api, lists-api, events-api) go through the Worker via
service bindings, NOT via the SW.

## Local dev

```sh
npm run dev:stack    # boots all 5 APIs + 5 web UIs (planner-web at :5177)
```

Or planner-web alone (proxies `/api/*` → `localhost:8084`):

```sh
npm run dev -w @rallypoint/planner-web
```

The vite dev server emits `dist/`, NOT into planner-api's public
dir — `wrangler dev` for planner-api reads the placeholder
`apps/planner-api/public/index.html`. The two run on separate ports
in dev (`:5177` for vite, `:8084` for the Worker).

# Rallypoint

Rallypoint is an open-source events, lists, money-splitting, and planning
platform built on the Cloudflare developer stack. This repository is the
source for the **self-hostable** edition — there are no pay-gated features;
what runs the hosted product is what's here.

> **Prefer not to self-host?** Use the hosted version at
> **[rallypt.app](https://rallypt.app)** — identity
> ([id.rallypt.app](https://id.rallypt.app)), events
> ([events.rallypt.app](https://events.rallypt.app)), lists
> ([lists.rallypt.app](https://lists.rallypt.app)), money
> ([money.rallypt.app](https://money.rallypt.app)), and planner
> ([planner.rallypt.app](https://planner.rallypt.app)).

Released from `rallypoint` `v1.0.3`. Licensed **Apache-2.0**.

## Stack

- **Runtime:** [Cloudflare Workers](https://developers.cloudflare.com/workers/)
  with [Hono](https://hono.dev/) for each API.
- **Database:** [Cloudflare D1](https://developers.cloudflare.com/d1/)
  (serverless SQLite) via [Drizzle ORM](https://orm.drizzle.team/)
  (`sqlite-core`).
- **Realtime:** [Durable Objects](https://developers.cloudflare.com/durable-objects/)
  back the WebSocket hub (presence + live updates).
- **Object storage:** [Cloudflare R2](https://developers.cloudflare.com/r2/)
  (avatars, event maps, receipts).
- **Front-ends:** [Vite](https://vitejs.dev/) + React 19 + Tailwind SPAs,
  one per product, served same-origin from their Worker.
- **Tests:** [Vitest](https://vitest.dev/), with
  [`@cloudflare/vitest-pool-workers`](https://github.com/cloudflare/workers-sdk/tree/main/packages/vitest-pool-workers)
  (workerd + Miniflare) for the D1/Workers-runtime suites.

## Repository layout

This is an npm-workspaces monorepo with five product domains —
**id, events, lists, money, planner** — each split into an API Worker and
a web SPA.

```
apps/
  <domain>-api/   Cloudflare Worker (Hono) + its wrangler.toml
  <domain>-web/   Vite + React SPA
packages/
  shared, crypto, db, object-store, realtime, logger   shared libraries
  ui, web-kit                                           shared front-end kit
  <domain>-db, <domain>-shared, <domain>-client         per-domain libs + SDKs
e2e/              end-to-end specs
scripts/          local dev + tooling
```

## Local development

You need Node.js 22, Docker (Compose v2), and the `wrangler` CLI.

```sh
npm install
npm run dev:stack   # runs scripts/dev.sh: boots local sidecars (Docker) + starts the Workers via `wrangler dev`
```

Useful commands:

```sh
npm run check          # lint + typecheck + unit tests
npm run test           # unit tests (node pool)
npm run test:d1        # D1 contract tests (workerd + Miniflare)
npm run test:d1:events # per-domain D1 integration tests (lists/events/money/planner too)
npm run test:workers   # Durable Object (realtime) tests
```

## Contributing

Contributions are welcome. Please:

- Open an issue or PR describing the change.
- Add tests alongside any new behavior — extract the decision into a pure
  function or cover the handler with a D1 integration test; don't mock the
  database.
- Make `npm run check` pass before opening a PR.

By contributing you agree your work is licensed under Apache-2.0.

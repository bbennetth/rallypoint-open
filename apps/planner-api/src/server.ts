// Rallypoint Planner API — Node.js server entrypoint.
// This file is a retired stub. The production entrypoint is the Cloudflare
// Worker (apps/planner-api/src/worker.ts). Invoking this file directly
// throws so the mis-use is immediately visible rather than silently
// starting a broken server.
throw new Error(
  'apps/planner-api/src/server.ts is a retired stub. ' +
    'Run the planner-api via `wrangler dev` (the Worker entrypoint) ' +
    'or use buildApp() directly in tests.',
)

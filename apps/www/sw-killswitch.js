// Kill-switch service worker for the apex (rallypt.app / rallypt.dev).
//
// The pre-migration festival-planner app registered a vite-plugin-pwa
// workbox SW at `/sw.js` (scope `/`) that precaches the app shell and
// serves it for every navigation BEFORE the network is reached. Installed
// clients therefore never fetch the new `apps/www` landing page.
//
// This file is emitted (by apps/www/vite.config.ts) at the asset root as
// both `sw.js` and `service-worker.js` — the URLs an old SW polls for
// updates. When the browser's periodic update check fetches one of those
// URLs, it gets THIS script instead. It then nukes every cache, clears the
// orphaned Dexie/IndexedDB data, unregisters itself, and reloads any open
// tab straight into the network-served new landing page.
//
// It must stay a plain classic worker (no imports / no precache) so it is
// served verbatim with a real application/javascript MIME. The companion
// sw-killswitch.test.ts guards that invariant.

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // 1. Drop every Cache Storage entry (the old workbox precache lives here).
      try {
        const keys = await caches.keys()
        await Promise.all(keys.map((k) => caches.delete(k)))
      } catch {
        /* best effort */
      }

      // 2. Best-effort wipe of orphaned IndexedDB (the festival-planner Dexie
      //    DBs). `indexedDB.databases()` is unsupported in Firefox/Safari —
      //    there we can't enumerate, so this is a no-op there and the stale
      //    DBs are simply left harmless (the new app doesn't read them).
      try {
        if (typeof indexedDB !== 'undefined' && indexedDB.databases) {
          const dbs = await indexedDB.databases()
          await Promise.all(
            dbs.map(
              (db) =>
                new Promise((resolve) => {
                  if (!db.name) return resolve()
                  const req = indexedDB.deleteDatabase(db.name)
                  req.onsuccess = req.onerror = req.onblocked = () => resolve()
                }),
            ),
          )
        }
      } catch {
        /* best effort */
      }

      // 3. Remove this registration so future navigations hit the network.
      try {
        await self.registration.unregister()
      } catch {
        /* best effort */
      }

      // 4. Reload open tabs into the now-uncontrolled (network) navigation so
      //    the new landing page appears in the same session, not the next one.
      try {
        const clients = await self.clients.matchAll({ type: 'window' })
        for (const client of clients) {
          client.navigate(client.url)
        }
      } catch {
        /* best effort */
      }
    })(),
  )
})

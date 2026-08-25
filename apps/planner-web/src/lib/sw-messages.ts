// Message types the planner SW posts to its window clients. Shared between
// the SW bundle (src/sw.ts) and the app-shell listeners so the two can't
// drift. ('planner-outbox-replay' predates this module and stays inline in
// createOfflineHooks' config.)

// Posted on push receipt: another device (or the notifications cron) just
// changed something — mounted cached queries should revalidate.
export const SW_DATA_REFRESH_MESSAGE = 'planner-data-refresh'

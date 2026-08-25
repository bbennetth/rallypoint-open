// The pure subscription registry moved to @rallypoint/offline-kit; this
// module re-exports it so planner-internal imports stay stable. Channels
// are keyed `${table}/${key}` — planner's table names are typed by
// PlannerOfflineTable at the call sites, the registry itself is stringly.

export {
  subscribeCache,
  notifyCacheWrite,
  _resetCacheSubscribers,
  _subscriberCount,
  type CacheListener,
} from '@rallypoint/offline-kit'

// Pure rate-limit types and algorithm now live in @rallypoint/rate-limit.
// This module is a thin re-export so existing id-api imports keep working
// without change. New code should import from @rallypoint/rate-limit directly.
export {
  computeBlend,
  windowStartMs,
  type RateLimitDecision,
  type RateLimitRepo,
  type TakeTokenInput,
} from '@rallypoint/rate-limit'

// Moved to @rallypoint/ai (packages/ai/src/retry.ts) so every AI-consuming
// app shares one copy of the capacity-retry logic. This re-export keeps
// existing fitness-api imports stable.
export {
  DEFAULT_AI_RETRY,
  aiErrorCode,
  isCapacityError,
  withCapacityRetry,
  type AiRetryConfig,
  type RetryHooks,
} from '@rallypoint/ai'

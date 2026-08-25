import type { Service } from '@cloudflare/workers-types'
import type { FitnessRPC } from '@rallypoint/fitness-api'
import type {
  ExerciseCatalogAdminService,
  FitnessAdminService,
  FoodSubmissionAdminService,
} from './types.js'

// Thin adapter over fitness-api's FitnessRPC admin methods. A service
// binding is inherently trusted (only another Worker can reach it), so
// there is no per-call auth token — admin-api's requireSession +
// requireAdmin gate is the access control in front of these calls.

export function createFitnessAdminService(binding: Service<FitnessRPC>): FitnessAdminService {
  return {
    async listSubmissions(status) {
      return binding.adminListSubmissions(status ? { status } : undefined)
    },
    async getSubmission(id) {
      return binding.adminGetSubmission(id)
    },
    async approveSubmission(id, opts) {
      return binding.adminApproveSubmission(id, opts)
    },
    async rejectSubmission(id, opts) {
      return binding.adminRejectSubmission(id, opts)
    },
    async rescanSubmission(id, opts) {
      return binding.adminRescanSubmission('exercise', id, opts)
    },
  }
}

export function createExerciseCatalogAdminService(
  binding: Service<FitnessRPC>,
): ExerciseCatalogAdminService {
  return {
    async listExercises(filter) {
      return binding.adminListExercises(filter)
    },
    async getExercise(id) {
      return binding.adminGetExercise(id)
    },
    async updateExercise(id, input) {
      return binding.adminUpdateExercise(id, input)
    },
    async aiReviewExercise(id, opts) {
      return binding.adminAiReviewExercise(id, opts)
    },
    async aiReviewBatch(input) {
      return binding.adminAiReviewBatch(input)
    },
    async listAiReviews(status) {
      return binding.adminListAiReviews(status ? { status } : undefined)
    },
    async applyAiReview(id) {
      return binding.adminApplyAiReview(id)
    },
    async dismissAiReview(id) {
      return binding.adminDismissAiReview(id)
    },
    async bulkDecideAiReviews(ids, action) {
      return binding.adminBulkDecideAiReviews(ids, action)
    },
  }
}

export function createFoodSubmissionAdminService(
  binding: Service<FitnessRPC>,
): FoodSubmissionAdminService {
  return {
    async listFoodSubmissions(status) {
      return binding.adminListFoodSubmissions(status ? { status } : undefined)
    },
    async getFoodSubmission(id) {
      return binding.adminGetFoodSubmission(id)
    },
    async approveFoodSubmission(id, opts) {
      return binding.adminApproveFoodSubmission(id, opts)
    },
    async rejectFoodSubmission(id, opts) {
      return binding.adminRejectFoodSubmission(id, opts)
    },
    async rescanFoodSubmission(id, opts) {
      return binding.adminRescanSubmission('food', id, opts)
    },
  }
}

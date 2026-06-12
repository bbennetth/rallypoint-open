import { z } from 'zod'
import { eventDateField, userIdField } from './validators.js'
import { normalizeShortCode } from './join-codes.js'

// Cross-target validators for the group layer (design §5.5). Same
// field-builder style as validators.ts; apps/events-api validates
// request bodies with these and apps/events-web reuses them so
// users see field errors before a network round trip. Evolve the
// rules HERE, never in two places.

// --- Field-level building blocks -----------------------------------

// Group display name. Matches groups.name (notNull), unique per event —
// 1–100 chars after trimming.
export const groupNameField = z
  .string()
  .trim()
  .min(1, 'Group name is required.')
  .max(100, 'Group name must be at most 100 characters.')

// Free-text description. Matches groups.description (nullable). Empty
// string normalises to null (clear-the-column on PATCH); absent stays
// undefined (leave-alone on PATCH).
export const groupDescriptionField = z
  .string()
  .trim()
  .max(5000, 'Description must be at most 5000 characters.')
  .transform((s) => (s.length === 0 ? null : s))
  .nullable()
  .optional()

// Group roles. 'owner' is never granted by invite/patch — it changes
// only through transfer-ownership — so the assignable set excludes it.
export const GROUP_ROLES = ['owner', 'sidekick', 'member'] as const
export const ASSIGNABLE_GROUP_ROLES = ['sidekick', 'member'] as const
export const assignableGroupRoleField = z.enum(ASSIGNABLE_GROUP_ROLES, {
  errorMap: () => ({ message: 'Role must be sidekick or member.' }),
})

// Raw join/invite code as handed to the joiner: 'rpj_' + base64url.
// One code grammar covers a group's standing rpj_ join code, a
// single-use invite code (the resolver disambiguates by lookup), and
// — since #440 — the human 6-char short code (any casing/spacing;
// normalizeShortCode in join-codes.ts is the authority on that
// shape). Long codes are `rpj_` + base64url(256 bits) = 47 chars.
export const joinCodeField = z
  .string()
  .trim()
  .min(1, 'Join code is required.')
  .max(256, 'Join code is too long.')
  .refine(
    (s) => /^rpj_[A-Za-z0-9_-]{16,}$/.test(s) || normalizeShortCode(s) !== null,
    'That is not a valid join code.',
  )

// Optional invited email — RFC-ish bounds + lowercasing.
function emailFieldOptional() {
  return z
    .string()
    .trim()
    .min(3, 'Email is too short.')
    .max(254, 'Email is too long.')
    .email('That does not look like an email address.')
    .transform((s) => s.toLowerCase())
    .optional()
}

// --- Request schemas -----------------------------------------------

// Create a group. name required; description/dates optional. endDate
// must not precede startDate when both are given.
export const CreateGroupSchema = z
  .object({
    name: groupNameField,
    description: groupDescriptionField,
    startDate: eventDateField.optional(),
    endDate: eventDateField.optional(),
  })
  .superRefine((v, ctx) => {
    if (v.startDate && v.endDate && v.endDate < v.startDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endDate'],
        message: 'End date must not be before start date.',
      })
    }
  })
export type CreateGroupBody = z.infer<typeof CreateGroupSchema>

// Patch a group. Every field optional; at least one must be present.
// nulls clear the nullable columns.
export const PatchGroupSchema = z
  .object({
    name: groupNameField.optional(),
    description: groupDescriptionField,
    startDate: eventDateField.nullable().optional(),
    endDate: eventDateField.nullable().optional(),
  })
  .superRefine((v, ctx) => {
    if (Object.values(v).every((x) => x === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [],
        message: 'At least one field must be supplied.',
      })
    }
    if (v.startDate && v.endDate && v.endDate < v.startDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endDate'],
        message: 'End date must not be before start date.',
      })
    }
  })
export type PatchGroupBody = z.infer<typeof PatchGroupSchema>

// Join a group by code. The resolver checks groups.join_code_hash first,
// then group_invites.code_hash (design §5.5).
export const JoinGroupSchema = z.object({
  code: joinCodeField,
})
export type JoinGroupBody = z.infer<typeof JoinGroupSchema>

// Create a group invite. invited_email optional (absent = open-code
// invite). Accept always lands the joiner as 'member', so no role here.
export const CreateGroupInviteSchema = z.object({
  invitedEmail: emailFieldOptional(),
})
export type CreateGroupInviteBody = z.infer<typeof CreateGroupInviteSchema>

// Promote/demote a group member among the assignable roles.
export const SetGroupRoleSchema = z.object({
  role: assignableGroupRoleField,
})
export type SetGroupRoleBody = z.infer<typeof SetGroupRoleSchema>

// Transfer group ownership. No re-auth gate (group transfer is lower
// stakes than event transfer and reversible by the new owner).
export const TransferGroupSchema = z.object({
  newOwnerUserId: userIdField,
})
export type TransferGroupBody = z.infer<typeof TransferGroupSchema>

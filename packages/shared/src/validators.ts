import { z } from 'zod'

// Cross-target validators. The API uses these to validate request
// bodies; the hosted UI uses the same schemas client-side so
// users see field errors before a network round trip. Anywhere
// these rules need to evolve, change them HERE — not in two
// places.

// --- Field-level building blocks -------------------------------------

// RFC-5321ish + practical limits. Lowercased before storage.
export const emailField = z
  .string()
  .trim()
  .min(3, 'Email is too short.')
  .max(254, 'Email is too long.')
  .email('That does not look like an email address.')
  .transform((s) => s.toLowerCase())

// Display name (stored in the `username` column). Non-unique and
// freely editable — it is the human-facing label, NOT a login
// identifier. Free text, trimmed, 1-80 chars.
export const usernameField = z
  .string()
  .trim()
  .min(1, 'Name is required.')
  .max(80, 'Name must be at most 80 characters.')

// First / last name. Nullable on the row; an empty string after
// trimming is treated by callers as "clear this field".
export const personNameField = z.string().trim().max(80, 'Name must be at most 80 characters.')

// Password length policy (#41) — extracted so signin/me/etc. all
// reference the same numbers and so a future bump (e.g. 256 -> 1024)
// is a single-line change.
export const MIN_PASSWORD_LENGTH = 12
export const MAX_PASSWORD_LENGTH = 256

// Passwords:
//   - >= MIN_PASSWORD_LENGTH, <= MAX_PASSWORD_LENGTH
//   - must NOT equal the email (caller passes context)
//   - HIBP check is enforced server-side, not in this validator
export const passwordField = z
  .string()
  .min(MIN_PASSWORD_LENGTH, `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`)
  .max(MAX_PASSWORD_LENGTH, `Password must be at most ${MAX_PASSWORD_LENGTH} characters.`)

// --- Request schemas -----------------------------------------------

// Sign-up: email + password + a display name (stored as `username`).
// There is no separate username/handle — email is the only login id.
export const SignupRequestSchema = z
  .object({
    email: emailField,
    password: passwordField,
    name: usernameField,
    captchaToken: z.string().min(1, 'Captcha token is required.'),
  })
  .superRefine((val, ctx) => {
    if (val.password.toLowerCase() === val.email.toLowerCase()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['password'],
        message: 'Password must not equal the email address.',
      })
    }
  })

export type SignupRequest = z.infer<typeof SignupRequestSchema>

export const VerifyEmailRequestSchema = z.object({
  token: z.string().min(10).max(200),
})
export type VerifyEmailRequest = z.infer<typeof VerifyEmailRequestSchema>

// --- Signin ---------------------------------------------------------

// /signin/start is email-only. Username is non-unique and can no
// longer identify an account, so email is the sole login identifier.
export const SigninStartRequestSchema = z.object({
  email: emailField,
  password: z.string().min(1).max(MAX_PASSWORD_LENGTH),
})
export type SigninStartRequest = z.infer<typeof SigninStartRequestSchema>

export const SigninCompleteRequestSchema = z.object({
  challengeId: z.string().min(20).max(200),
  code: z.string().regex(/^[0-9]{6}$/, 'Code must be 6 digits.'),
})
export type SigninCompleteRequest = z.infer<typeof SigninCompleteRequestSchema>

export const SigninResendRequestSchema = z.object({
  challengeId: z.string().min(20).max(200),
})
export type SigninResendRequest = z.infer<typeof SigninResendRequestSchema>

// --- Password reset ------------------------------------------------

export const PasswordResetRequestSchema = z.object({
  email: emailField,
  captchaToken: z.string().min(1, 'Captcha token is required.'),
})
export type PasswordResetRequestBody = z.infer<typeof PasswordResetRequestSchema>

export const PasswordResetConfirmSchema = z.object({
  token: z.string().min(10).max(200),
  newPassword: passwordField,
})
export type PasswordResetConfirmBody = z.infer<typeof PasswordResetConfirmSchema>

// --- Account management (/me) ---------------------------------------

export const ChangePasswordSchema = z
  .object({
    currentPassword: z.string().min(1).max(MAX_PASSWORD_LENGTH),
    newPassword: passwordField,
  })
  .refine((v) => v.newPassword !== v.currentPassword, {
    path: ['newPassword'],
    message: 'New password must differ from current password.',
  })
export type ChangePasswordBody = z.infer<typeof ChangePasswordSchema>

export const EmailChangeRequestSchema = z.object({
  newEmail: emailField,
  currentPassword: z.string().min(1).max(MAX_PASSWORD_LENGTH),
})
export type EmailChangeRequestBody = z.infer<typeof EmailChangeRequestSchema>

export const EmailChangeConfirmSchema = z.object({
  token: z.string().min(10).max(200),
})
export type EmailChangeConfirmBody = z.infer<typeof EmailChangeConfirmSchema>

export const EmailChangeCancelSchema = z.object({
  cancelToken: z.string().min(10).max(200),
})
export type EmailChangeCancelBody = z.infer<typeof EmailChangeCancelSchema>

export const UpdateMeSchema = z
  .object({
    username: usernameField.optional(),
    firstName: personNameField.optional(),
    lastName: personNameField.optional(),
    currentPassword: z.string().min(1).max(MAX_PASSWORD_LENGTH),
  })
  .refine(
    (v) => v.username !== undefined || v.firstName !== undefined || v.lastName !== undefined,
    {
      message: 'At least one of {username, firstName, lastName} must be supplied.',
    },
  )
export type UpdateMeBody = z.infer<typeof UpdateMeSchema>

export const DeleteMeSchema = z.object({
  currentPassword: z.string().min(1).max(MAX_PASSWORD_LENGTH),
  // Required string literal to make accidental DELETE clicks
  // (curl typos, replayed requests) much harder.
  confirm: z.literal('DELETE MY ACCOUNT'),
})
export type DeleteMeBody = z.infer<typeof DeleteMeSchema>

// --- Avatar upload ---------------------------------------------------
// The avatar upload is a single same-origin POST of the raw image bytes
// to id-api, which validates type/size inline via validateAvatarUpload
// (below) and stores through its R2 binding (#409). No presign/bind JSON
// request bodies, so no schemas here.

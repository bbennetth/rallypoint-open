import type { Repos, UserAuthRepo } from '../types.js'
import { type Db, createDb } from './db.js'
import { D1UserRepo } from './users.js'
import { D1AuthMethodRepo } from './auth-methods.js'
import { D1EmailVerificationRepo } from './email-verifications.js'
import { D1AuditRepo } from './audit.js'
import { D1RateLimitRepo } from './rate-limit.js'
import { D1SessionRepo } from './sessions.js'
import { D1SigninChallengeRepo } from './signin-challenges.js'
import { D1PasswordResetRepo } from './password-resets.js'
import { D1EmailChangeRepo } from './email-changes.js'
import { D1SsoCodeRepo } from './sso-codes.js'
import { D1SettingsRepo } from './settings.js'
import {
  createUserWithAuthMethod,
  confirmEmailChange,
  confirmPasswordReset,
} from './user-auth.js'

// Thin wrapper that adapts the free functions to the UserAuthRepo interface.
class D1UserAuthRepo implements UserAuthRepo {
  constructor(private readonly db: Db) {}

  createUserWithAuthMethod(
    user: Parameters<UserAuthRepo['createUserWithAuthMethod']>[0],
    authMethod: Parameters<UserAuthRepo['createUserWithAuthMethod']>[1],
  ): ReturnType<UserAuthRepo['createUserWithAuthMethod']> {
    return createUserWithAuthMethod(this.db, user, authMethod)
  }

  confirmEmailChange(
    input: Parameters<UserAuthRepo['confirmEmailChange']>[0],
  ): ReturnType<UserAuthRepo['confirmEmailChange']> {
    return confirmEmailChange(this.db, input)
  }

  confirmPasswordReset(
    input: Parameters<UserAuthRepo['confirmPasswordReset']>[0],
  ): ReturnType<UserAuthRepo['confirmPasswordReset']> {
    return confirmPasswordReset(this.db, input)
  }
}

export function buildD1Repos(db: Db): Repos {
  return {
    users: new D1UserRepo(db),
    authMethods: new D1AuthMethodRepo(db),
    emailVerifications: new D1EmailVerificationRepo(db),
    audit: new D1AuditRepo(db),
    rateLimit: new D1RateLimitRepo(db),
    sessions: new D1SessionRepo(db),
    signinChallenges: new D1SigninChallengeRepo(db),
    passwordResets: new D1PasswordResetRepo(db),
    emailChanges: new D1EmailChangeRepo(db),
    ssoCodes: new D1SsoCodeRepo(db),
    settings: new D1SettingsRepo(db),
    userAuth: new D1UserAuthRepo(db),
  }
}

export { createDb }
export type { Db }

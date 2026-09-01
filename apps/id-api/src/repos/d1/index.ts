import type { RateLimitCounterNamespace } from '@rallypoint/rate-limit'
import type { Repos, UserAuthRepo } from '../types.js'
import { type Db, createDb } from './db.js'
import { D1UserRepo } from './users.js'
import { D1AuthMethodRepo } from './auth-methods.js'
import { D1EmailVerificationRepo } from './email-verifications.js'
import { D1AuditRepo } from './audit.js'
import { createRateLimitRepo } from './rate-limit.js'
import { D1SessionRepo } from './sessions.js'
import { D1SigninChallengeRepo } from './signin-challenges.js'
import { D1PasswordResetRepo } from './password-resets.js'
import { D1EmailChangeRepo } from './email-changes.js'
import { D1SsoCodeRepo } from './sso-codes.js'
import { D1SettingsRepo } from './settings.js'
import { D1OAuthIdentityRepo } from './oauth-identities.js'
import { D1WebAuthnCredentialRepo } from './webauthn-credentials.js'
import { D1WebAuthnChallengeRepo } from './webauthn-challenges.js'
import { D1OAuthStateRepo } from './oauth-states.js'
import {
  createUserWithAuthMethod,
  confirmEmailChange,
  confirmEmailVerification,
  confirmPasswordReset,
  createUserWithOAuthIdentity,
  deleteWebauthnCredentialGuarded,
  deleteOAuthIdentityGuarded,
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

  confirmEmailVerification(
    input: Parameters<UserAuthRepo['confirmEmailVerification']>[0],
  ): ReturnType<UserAuthRepo['confirmEmailVerification']> {
    return confirmEmailVerification(this.db, input)
  }

  confirmPasswordReset(
    input: Parameters<UserAuthRepo['confirmPasswordReset']>[0],
  ): ReturnType<UserAuthRepo['confirmPasswordReset']> {
    return confirmPasswordReset(this.db, input)
  }

  createUserWithOAuthIdentity(
    user: Parameters<UserAuthRepo['createUserWithOAuthIdentity']>[0],
    identity: Parameters<UserAuthRepo['createUserWithOAuthIdentity']>[1],
  ): ReturnType<UserAuthRepo['createUserWithOAuthIdentity']> {
    return createUserWithOAuthIdentity(this.db, user, identity)
  }

  deleteWebauthnCredentialGuarded(
    input: Parameters<UserAuthRepo['deleteWebauthnCredentialGuarded']>[0],
  ): ReturnType<UserAuthRepo['deleteWebauthnCredentialGuarded']> {
    return deleteWebauthnCredentialGuarded(this.db, input)
  }

  deleteOAuthIdentityGuarded(
    input: Parameters<UserAuthRepo['deleteOAuthIdentityGuarded']>[0],
  ): ReturnType<UserAuthRepo['deleteOAuthIdentityGuarded']> {
    return deleteOAuthIdentityGuarded(this.db, input)
  }
}

// `rateLimitNamespace` is optional so the existing buildD1Repos(db) call
// sites (every *.d1.test.ts) keep exercising the D1 rate-limit path
// unchanged; only production ensureDeps passes the RATE_LIMITS DO namespace
// (#881).
export function buildD1Repos(db: Db, rateLimitNamespace?: RateLimitCounterNamespace): Repos {
  return {
    users: new D1UserRepo(db),
    authMethods: new D1AuthMethodRepo(db),
    emailVerifications: new D1EmailVerificationRepo(db),
    audit: new D1AuditRepo(db),
    rateLimit: createRateLimitRepo(db, rateLimitNamespace),
    sessions: new D1SessionRepo(db),
    signinChallenges: new D1SigninChallengeRepo(db),
    passwordResets: new D1PasswordResetRepo(db),
    emailChanges: new D1EmailChangeRepo(db),
    ssoCodes: new D1SsoCodeRepo(db),
    settings: new D1SettingsRepo(db),
    userAuth: new D1UserAuthRepo(db),
    oauthIdentities: new D1OAuthIdentityRepo(db),
    webauthnCredentials: new D1WebAuthnCredentialRepo(db),
    webauthnChallenges: new D1WebAuthnChallengeRepo(db),
    oauthStates: new D1OAuthStateRepo(db),
  }
}

export { createDb }
export type { Db }

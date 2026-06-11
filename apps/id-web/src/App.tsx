import { Routes, Route, Navigate } from 'react-router-dom'
import { SignupPage } from './pages/SignupPage.js'
import { SigninPage } from './pages/SigninPage.js'
import { VerifyEmailPage } from './pages/VerifyEmailPage.js'
import { PasswordResetRequestPage } from './pages/PasswordResetRequestPage.js'
import { PasswordResetConfirmPage } from './pages/PasswordResetConfirmPage.js'
import { AccountSettingsPage } from './pages/AccountSettingsPage.js'
import { AccountDeletePage } from './pages/AccountDeletePage.js'
import { EmailChangeConfirmPage } from './pages/EmailChangeConfirmPage.js'
import { EmailChangeCancelPage } from './pages/EmailChangeCancelPage.js'
import { SsoAuthorizePage } from './pages/SsoAuthorizePage.js'
import { HomePage } from './pages/HomePage.js'

// Slice 6a + 6b routes — auth pages and account pages.

export function App() {
  return (
    <Routes>
      {/* Auth (slice 6a) */}
      <Route path="/signup" element={<SignupPage />} />
      <Route path="/signin" element={<SigninPage />} />
      <Route path="/verify-email" element={<VerifyEmailPage />} />
      <Route path="/password-reset" element={<PasswordResetRequestPage />} />
      <Route path="/password-reset/confirm" element={<PasswordResetConfirmPage />} />

      {/* SSO (slice 2a) */}
      <Route path="/sso/authorize" element={<SsoAuthorizePage />} />

      {/* Account (slice 6b) */}
      <Route path="/account" element={<Navigate to="/account/settings" replace />} />
      <Route path="/account/settings" element={<AccountSettingsPage />} />
      <Route path="/account/delete" element={<AccountDeletePage />} />
      <Route path="/account/email-change/confirm" element={<EmailChangeConfirmPage />} />
      <Route path="/account/email-change/cancel" element={<EmailChangeCancelPage />} />

      {/* Landing — session-aware app launcher (#189) */}
      <Route path="/" element={<HomePage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

import type { AccountProfile } from '../shared/types'

/** Marks that a secret exists without shipping it (the UI only checks `acc.fbCookie || acc.password`). */
const PRESENT = '1'

/**
 * Accounts as the UI sees them: session cookies, FB cookie, token, password and 2FA secret stripped.
 * cookieHeader alone was ~300 KB of every state push, and the UI never reads any of these values.
 */
export function toRendererAccounts(accounts: readonly AccountProfile[]): AccountProfile[] {
  return accounts.map((a) => ({
    ...a,
    cookieHeader: undefined,
    fbToken: undefined,
    twoFactorSecret: undefined,
    fbCookie: a.fbCookie ? PRESENT : undefined,
    password: a.password ? PRESENT : undefined
  }))
}

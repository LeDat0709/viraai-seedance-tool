const EMAIL_RE = /^[^\s@=|]+@[^\s@=|]+\.[a-z]{2,}$/i
const TRAILING_EMAIL_RE = /=([^\s@=|]+@[^\s@=|]+\.[a-z]{2,})$/i

/**
 * Returns just the email address from an account field. Hotmail via lines pack the address at the end of a
 * token blob ("…RefreshToken=M.C5…MailKP=name@boxnt.com"); only the address is kept so tokens never get
 * stored as the email or shown in the UI.
 */
export function extractEmail(raw: string | undefined): string | undefined {
  const value = raw?.trim()
  if (!value) return undefined
  if (EMAIL_RE.test(value)) return value
  return TRAILING_EMAIL_RE.exec(value)?.[1]
}

// Pure helpers for spotting a logged-out Dola account (no electron imports → unit-testable).

export type SelfBriefVerdict = 'logged_in' | 'logged_out' | 'unknown'

export interface AccountEvent {
  accountId: string
  at: number
}

export const BURST_WINDOW_MS = 10 * 60_000
export const BURST_ACCOUNTS = 2

/** Reads Dola's `/alice/profile/self_brief` answer: the server's own word on whether the session lives. */
export function readSelfBrief(json: unknown): SelfBriefVerdict {
  if (!json || typeof json !== 'object') return 'unknown'
  const { code, data } = json as { code?: unknown; data?: Record<string, unknown> }
  if (typeof code === 'number' && code !== 0) return 'logged_out'
  if (!data || typeof data !== 'object') return 'unknown'
  const brief = (data.profile_brief as Record<string, unknown> | undefined) ?? data
  const uid = String(brief.user_id_str ?? brief.user_id ?? brief.uid ?? '').trim()
  return uid && uid !== '0' ? 'logged_in' : 'logged_out'
}

/**
 * Stale cookies can outlive a session Dola already revoked, so the server verdict wins; only when it
 * can't be read do we fall back to the page/cookie check.
 */
export function isSessionDead(verdict: SelfBriefVerdict, fallbackDead: boolean): boolean {
  if (verdict === 'logged_out') return true
  if (verdict === 'logged_in') return false
  return fallbackDead
}

/** Queue message for when every enabled account is logged out — otherwise tasks wait with no hint why. */
export function describeAllLoggedOut(statuses: readonly string[]): string | null {
  if (statuses.length === 0 || statuses.some((s) => s !== 'expired')) return null
  return `⚠️ Hàng đợi dừng: cả ${statuses.length} tài khoản đang bật đều đã bị đăng xuất (đăng nhập lại tự động không được — xem lý do ở Quản lý tài khoản). Đăng nhập lại ít nhất 1 tài khoản để chạy tiếp.`
}

/** Returns a new list with this event added and events older than the window dropped. */
export function recordAccountEvent(
  events: readonly AccountEvent[],
  accountId: string,
  now: number
): AccountEvent[] {
  return [...events.filter((e) => now - e.at <= BURST_WINDOW_MS), { accountId, at: now }]
}

/** The same failure on several different accounts at once = a shared cause, not one bad account. */
export function isMultiAccountBurst(
  events: readonly AccountEvent[],
  now: number,
  windowMs = BURST_WINDOW_MS,
  minAccounts = BURST_ACCOUNTS
): boolean {
  const recent = new Set(events.filter((e) => now - e.at <= windowMs).map((e) => e.accountId))
  return recent.size >= minAccounts
}

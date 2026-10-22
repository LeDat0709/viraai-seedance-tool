import type { AccountProfile, TaskStatus, VideoTask } from '../../../shared/types'

export const TASK_STEPS = ['Chuẩn bị', 'Gửi lệnh', 'Đang dựng', 'Tải về'] as const

/** Index into TASK_STEPS for a running task; -1 while it is still waiting in the queue. */
export function stepIndexOf(status: TaskStatus): number {
  switch (status) {
    case 'preparing':
    case 'uploading':
      return 0
    case 'submitting':
      return 1
    case 'polling':
      return 2
    case 'downloading':
      return 3
    default:
      return -1
  }
}

const ERROR_LABELS: Record<string, string> = {
  QUOTA_EXHAUSTED: 'Nick hết lượt',
  PROXY_ERROR: 'Lỗi kết nối Proxy',
  AUTH_EXPIRED: 'Phiên đăng nhập hết hạn',
  PRO_BUSY: 'Dola đang quá tải',
  DUPLICATE_VIDEO: 'Dola trả video trùng',
  CONTENT_REFUSED: 'Dola từ chối nội dung',
  RECOVER_EMPTY: 'Hội thoại chưa có video'
}

type FailureFields = Pick<VideoTask, 'status' | 'errorCode'> &
  Partial<Pick<VideoTask, 'errorMessage' | 'conversationId'>>

/** Short, human error title for a failed task card; the full message stays in the tooltip. */
export function errorLabelOf(task: FailureFields): string {
  if (task.status === 'cancelled') return 'Đã dừng'
  if (failureKindOf(task) === 'recover') return 'Hết thời gian chờ'
  return (task.errorCode && ERROR_LABELS[task.errorCode]) || 'Tạo video thất bại'
}

/**
 * What fixes a failed task: 'recover' = already sent to Dola and timed out, the video may be in the
 * conversation (collect it, no new send); 'edit' = Dola refused the content (change the prompt);
 * 'retry' = everything else (busy, proxy, dead/spent account) — just run it again.
 */
export type FailureKind = 'recover' | 'edit' | 'retry'

export const POLICY_VIOLATION_MSG_RE =
  /vi phạm|chính sách|bản quyền|từ chối|bảo vệ chân dung|không hiểu prompt|nhạy cảm|không phù hợp|không thể tạo|policy|copyright|portrait|refused|cannot be generated|violates|safety|sensitive|inappropriate/i

export function failureKindOf(task: FailureFields): FailureKind {
  if (task.errorCode === 'CONTENT_REFUSED' || POLICY_VIOLATION_MSG_RE.test(task.errorMessage || '')) {
    return 'edit'
  }
  if (task.conversationId && /Quá thời gian chờ/i.test(task.errorMessage || '')) return 'recover'
  return 'retry'
}

/** Failed tasks bucketed by fix, for the "3 task quá tải → Chạy lại" bar. */
export function groupFailures<T extends FailureFields & { id: string }>(
  tasks: T[]
): Record<FailureKind, T[]> {
  const groups: Record<FailureKind, T[]> = { recover: [], edit: [], retry: [] }
  for (const t of tasks) {
    if (t.status === 'failed') groups[failureKindOf(t)].push(t)
  }
  return groups
}

/**
 * Observed Dola daily cap for 10s videos on one free nick: accounts hit "daily limit" after 6–7 (2026-10-20).
 * Conservative low end so the estimate never promises videos that aren't there. Update if Dola changes it.
 */
export const DAILY_VIDEO_LIMIT_ESTIMATE = 6

/**
 * Videos still makeable today. knownCredits = what Dola reported; Dola rarely reports, so estimatedCredits also
 * guesses each unreported ready nick as DAILY_VIDEO_LIMIT_ESTIMATE minus what it already made today.
 */
export function estimateCapacity(
  accounts: Pick<AccountProfile, 'enabled' | 'status' | 'creditsLeft' | 'creditsLeftDate' | 'videosToday'>[],
  today: string
): { knownCredits: number; unknownAccounts: number; estimatedCredits: number } {
  let knownCredits = 0
  let unknownAccounts = 0
  let guessedCredits = 0
  for (const a of accounts) {
    if (!a.enabled || a.status !== 'ready') continue
    if (a.creditsLeftDate === today && typeof a.creditsLeft === 'number') {
      knownCredits += a.creditsLeft
    } else {
      unknownAccounts++
      guessedCredits += Math.max(0, DAILY_VIDEO_LIMIT_ESTIMATE - (a.videosToday || 0))
    }
  }
  return { knownCredits, unknownAccounts, estimatedCredits: knownCredits + guessedCredits }
}

/** Local YYYY-MM-DD, same key the main process uses for daily counters. */
export function localDayKeyOf(date: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

const MINOR_RE =
  /\b(child|children|kid|kids|toddler|baby|infant|boy|girl|minor|orphan)\b|\b([1-9]|1[0-7])[\s-]*(years?[\s-]*old|yo|tuổi)\b|trẻ em|đứa trẻ|em bé|bé gái|bé trai|cậu bé|cô bé|mồ côi|儿童|孩子|小孩|女孩|男孩/i
const DISTRESS_RE =
  /abandon|freez|frozen|shiver|crying|cries|\bcry\b|tears|scared|terrified|beg(ging)?\b|homeless|starv|hungry|abuse|beaten|bleed|blood|injur|dying|\bdead\b|bỏ rơi|lạnh cóng|run rẩy|khóc|nước mắt|sợ hãi|ăn xin|vô gia cư|lang thang|đói|bạo hành|đánh đập|chảy máu|bị thương|chết|遗弃|受冻|流泪|哭/i

/**
 * Flags prompts Dola's safety filter tends to refuse: a child together with distress (abandoned, freezing,
 * crying…). Returns a short reason, or undefined when the prompt looks fine. Heuristic: warns, never blocks.
 */
export function findPromptRisk(prompt: string): string | undefined {
  const minor = MINOR_RE.exec(prompt)
  const distress = DISTRESS_RE.exec(prompt)
  if (!minor || !distress) return undefined
  return `Có trẻ em ("${minor[0].trim()}") kèm cảnh đau khổ ("${distress[0].trim()}") — Dola thường từ chối. Thử đổi nhân vật thành người lớn hoặc bỏ cảnh đau khổ.`
}

/** Strips engine jargon from progress text: the "[Native Engine]" tag and trailing "— #496209…" ids. */
export function cleanProgressText(text: string | undefined): string {
  if (!text) return ''
  return text
    .replace(/^\s*\[[^\]]*engine[^\]]*\]\s*/i, '')
    .replace(/\s*[—-]\s*#[\w-]+…?\s*$/, '')
    .trim()
}

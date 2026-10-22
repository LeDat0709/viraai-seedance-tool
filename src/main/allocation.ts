// Pure job-allocation rules (no electron/store imports → unit-testable, like daily.ts / duration.ts).
import type { BatchAllocationMode } from '../shared/types'

/** Per-account daily video cap implied by the batch mode. 0 = no cap ("chia đều xoay vòng"). */
export function perAccountCap(mode: BatchAllocationMode): number {
  if (mode === '20_per_acc') return 20
  if (mode === '10_per_acc') return 10
  return 0
}

/** cap <= 0 means unlimited. */
export function isUnderCap(videosToday: number, cap: number): boolean {
  return cap <= 0 || videosToday < cap
}

/** Minimal shape the chooser needs — the id and today's completed count. */
export interface AllocAccount {
  id: string
  videosToday: number
}

export interface ChooseAccountArgs {
  /** The lô's assigned account id, if the task was allocated one. */
  assignedId?: string
  /** Accounts runnable right now: enabled, not busy, not recycling, not expired, not quota_exhausted. */
  available: AllocAccount[]
  /** The assigned account exists and is otherwise fine but is momentarily busy/recycling (so not in `available`). */
  homeBusy: boolean
  /** Per-account cap from perAccountCap(). */
  cap: number
}

/**
 * Decides which account a queued task runs on, honouring the lô binding:
 *  - assigned account usable and under cap → stay on it,
 *  - assigned account only busy, cap in force → wait (a capped lô must stick to its account),
 *  - assigned account only busy, no cap (even_split) → fail over (spread across free accounts),
 *  - assigned account dead/over-cap → fail over to the under-cap account with the fewest videos today,
 *  - no account under cap → none (caller may recycle, else the queue reports the cap was hit).
 */
export function chooseAccount(args: ChooseAccountArgs): { use?: string; wait?: boolean } {
  const { assignedId, available, homeBusy, cap } = args

  if (assignedId) {
    const home = available.find((a) => a.id === assignedId)
    if (home && isUnderCap(home.videosToday, cap)) return { use: home.id }
    // A busy home only makes a task WAIT when a per-account cap is in force (the lô must stick to its
    // account to honour the cap). With no cap ("chia đều xoay vòng") the assignment is just a
    // round-robin hint, so a busy home falls through to run on any other free account instead of
    // idling the queue while other ready accounts sit unused.
    if (homeBusy && cap > 0) return { wait: true }
    // home is dead/missing, over its cap, or uncapped-and-busy → fall through to failover
  }

  const failover = available
    .filter((a) => isUnderCap(a.videosToday, cap))
    .sort((p, q) => p.videosToday - q.videosToday)[0]

  return failover ? { use: failover.id } : {}
}

// Statuses where the prompt already reached Dola — that render is paid for.
const SENT_TO_DOLA_STATUSES = ['polling', 'downloading']
// Mirrors `needMultiClip` in dola-engine: above this a task is two parts in two conversations.
const SINGLE_CLIP_MAX_SEC = 15

/**
 * After a restart, an interrupted task Dola is already rendering keeps its conversation + account, so the
 * engine collects that video instead of paying for a new one. Only that account's session can fetch the
 * conversation, so it must still be alive. 30s (two-part) tasks restart as before.
 */
export function canResumeAfterRestart(
  task: { status: string; conversationId?: string; duration: number },
  accountAlive: boolean
): boolean {
  return (
    SENT_TO_DOLA_STATUSES.includes(task.status) &&
    Boolean(task.conversationId) &&
    task.duration <= SINGLE_CLIP_MAX_SEC &&
    accountAlive
  )
}

/** Floor for the adaptive thread count while Dola is overloaded (still probes whether it recovered). */
export const MIN_ADAPTIVE_CONCURRENCY = 2

/**
 * Additive-increase / multiplicative-decrease thread count: a Dola-wide overload halves the live threads
 * (8 threads hammering an overloaded Dola only multiplied 710022002s), each delivered video adds one back,
 * never above the user's setting `max`.
 */
export function nextConcurrency(current: number, max: number, event: 'success' | 'overload'): number {
  const floor = Math.min(MIN_ADAPTIVE_CONCURRENCY, max)
  const next = event === 'overload' ? Math.floor(current / 2) : current + 1
  return Math.max(floor, Math.min(max, next))
}

export const BASE_FAILURE_COOLDOWN_MS = 10 * 60_000
export const MAX_FAILURE_COOLDOWN_MS = 2 * 60 * 60_000

/**
 * Rest for a nick after its Nth failure in a row (timeouts / Dola errors on that nick). A flat 10 min let a
 * broken nick with 0 videos today win "freshest" again and again, eating 12-min timeouts each round.
 */
export function failureCooldownMs(consecutiveFailures: number): number {
  const n = Math.max(1, consecutiveFailures)
  return Math.min(MAX_FAILURE_COOLDOWN_MS, BASE_FAILURE_COOLDOWN_MS * 2 ** (n - 1))
}

/** Extra poll rounds a timed-out render gets on its own conversation before the prompt is re-sent elsewhere. */
export const TIMEOUT_EXTRA_WAITS = 1
const POLL_TIMEOUT_RE = /Quá thời gian chờ/i

/**
 * A prompt Dola accepted but didn't finish within pollTimeout is usually still rendering — and already paid for.
 * Re-sending it on another nick (the old behaviour) spent a second credit and abandoned the first render;
 * watching the same conversation once more collects it for free.
 */
export function shouldWaitLongerAfterTimeout(r: {
  errorCode?: string
  errorMessage?: string
  sentToDola?: boolean
  conversationId?: string
  retryCount: number
}): boolean {
  return (
    r.errorCode === 'GENERAL_ERROR' &&
    Boolean(r.sentToDola) &&
    Boolean(r.conversationId) &&
    POLL_TIMEOUT_RE.test(r.errorMessage || '') &&
    r.retryCount < TIMEOUT_EXTRA_WAITS
  )
}

/** A resumed task runs only on its own account: wait while it's busy, start over if it died. */
export function resumeAccountDecision(homeRunnable: boolean, homeAlive: boolean): 'run' | 'wait' | 'restart' {
  if (homeRunnable) return 'run'
  return homeAlive ? 'wait' : 'restart'
}

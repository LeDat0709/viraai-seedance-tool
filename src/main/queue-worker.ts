import { BrowserWindow, session } from 'electron'
import { toRendererAccounts } from './renderer-state'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import {
  AccountProfile,
  QueueSubmitPayload,
  VideoLibraryItem,
  VideoTask
} from '../shared/types'
import { store, DEFAULT_ACCOUNT_POOL_ID } from './store'
import { localDayKey } from './daily'
import {
  isShorterThanRequested,
  sanitizePromptForDolaSafety,
  unwrapPromptWrapper
} from './duration'
import {
  canResumeAfterRestart,
  chooseAccount,
  perAccountCap,
  resumeAccountDecision,
  shouldWaitLongerAfterTimeout,
  failureCooldownMs,
  nextConcurrency
} from './allocation'
import { type AccountEvent, describeAllLoggedOut, isMultiAccountBurst, recordAccountEvent } from './auth-guard'
import {
  generateVideoWithAccount,
  parseMp4DurationFromBuffer,
  recycleAccountQuota
} from './dola-engine'
import {
  ensureAccountHasLiveProxy,
  formatAccountProxyLabel,
  resolveRotatingProxy
} from './proxy-manager'

// accountId -> taskId currently running on it. A Map (not a Set) so a late release can check it
// still owns the account before freeing — a task cancelled mid-run frees its account early.
const busyAccountOwner = new Map<string, string>()
const runningTaskIds = new Set<string>()
let queuePaused = false
let postSendLogouts: AccountEvent[] = []
let proBusyEvents: AccountEvent[] = []
/** Several accounts hit Dola's overload together = Dola itself is overloaded: start nothing new until then. */
let platformBusyUntil = 0
let schedulerTimer: NodeJS.Timeout | null = null
let watchdogTimer: NodeJS.Timeout | null = null

/** Dola says "try later" when Pro is overloaded; the single auto-retry waits this long. */
/** Short wait when every ready account in the pool is on cooldown. */
const PRO_BUSY_RETRY_DELAY_MS = 8_000

/**
 * A running task whose progress hasn't advanced in this long is treated as hung and reaped.
 * Healthy tasks refresh updatedAt every ~5s (the engine's poll loop emits progress each cycle), so
 * this only catches a real stall — e.g. the engine's Dola page load never finishing — not a slow job.
 */
const STALL_TIMEOUT_MS = 150_000

/**
 * When every account in the pool is on cooldown at once, pause new starts briefly.
 */
const PLATFORM_BUSY_PAUSE_MS = 5_000
/** A Dola-wide overload = this many different nicks answering 710022002 within this window. */
const PRO_BUSY_BURST_WINDOW_MS = 2 * 60_000
const PRO_BUSY_BURST_ACCOUNTS = 6

/**
 * When several accounts get logged out right after sending (a shared cause — bad proxy/IP), the queue
 * backs off this long then RESUMES itself. The old code hard-paused the whole queue until the user
 * manually pressed Resume, which turned a few bad nicks into the whole queue hanging indefinitely.
 */
const LOGOUT_BURST_PAUSE_MS = 90_000

const RUNNING_STATUSES: ReadonlyArray<VideoTask['status']> = [
  'preparing',
  'uploading',
  'submitting',
  'polling',
  'downloading'
]

const accountPoolOf = (acc: AccountProfile): string => acc.poolId || DEFAULT_ACCOUNT_POOL_ID

/** Coalesce bursts of state pushes (8 luồng × progress every few seconds) into one send per window. */
const BROADCAST_COALESCE_MS = 900
let broadcastTimer: NodeJS.Timeout | null = null

export function broadcastStateUpdate(): void {
  if (broadcastTimer) return
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null
    sendStateToAppWindows()
  }, BROADCAST_COALESCE_MS)
}

function sendStateToAppWindows(): void {
  store.rolloverDailyVideoCounts()
  const payload = {
    settings: store.getSettings(),
    projects: store.getProjects(),
    accountPools: store.getAccountPools(),
    accounts: toRendererAccounts(store.getAccounts()),
    proxies: store.getProxies(),
    rotatingProxies: store.getRotatingProxies(),
    characters: store.getCharacters(),
    tasks: store.getTasks(),
    videos: store.getVideos(),
    queueRunning: runningTaskIds.size > 0,
    queuePaused
  }

  // Only the app UI runs on the default session; Dola/login windows live on per-account partitions and
  // never read this ~1 MB payload (all accounts + cookies), so sending it to them just burned CPU.
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && win.webContents.session === session.defaultSession) {
      win.webContents.send('state:updated', payload)
    }
  }
}

export function recoverStalledTasksOnStartup(): void {
  let changed = store.rolloverDailyVideoCounts()
  const todayKey = localDayKey()

  // Restore any account that was marked quota_exhausted on a previous day, or falsely marked on error_code=1,
  // or stuck in 'checking' / transient ERR_CONNECTION_REFUSED / ERR_CONNECTION_RESET across restart
  for (const acc of store.getAccounts()) {
    const is7DayLimit = /近\s*7\s*天|7[- ]day/i.test(acc.statusMessage || '')
    const isGenuineDailyLimit =
      /daily limit|hết lượt tạo video|hết credit|0 video credits|免费额度用完了|额度已用完|今日额度/i.test(
        acc.statusMessage || ''
      )
    const exhaustedToday = acc.creditsLeftDate === todayKey || is7DayLimit
    if (acc.status === 'ready' && isGenuineDailyLimit && exhaustedToday) {
      store.updateAccount(acc.id, {
        status: 'quota_exhausted'
      })
      changed = true
    } else if (
      acc.status === 'quota_exhausted' &&
      !is7DayLimit &&
      (!exhaustedToday ||
        (!isGenuineDailyLimit &&
          ((acc.videosToday || 0) === 0 || /error_code=1|something went wrong/i.test(acc.statusMessage || ''))))
    ) {
      store.updateAccount(acc.id, {
        status: 'ready',
        videosToday: 0,
        videosTodayDate: todayKey,
        creditsLeft: undefined,
        creditsLeftDate: undefined,
        statusMessage: 'Sẵn sàng (Native Engine)'
      })
      changed = true
    } else if (acc.status === 'checking') {
      const hasSession = Boolean(
        acc.cookieHeader && /(^|;\s*)(sessionid|sid_guard)=/.test(acc.cookieHeader)
      )
      store.updateAccount(acc.id, {
        status: hasSession ? 'ready' : 'expired',
        statusMessage: hasSession
          ? 'Sẵn sàng (Native Engine)'
          : 'Chưa hoàn tất kiểm tra phiên — bấm "Đăng nhập FB" để lấy phiên Dola'
      })
      changed = true
    } else if (
      acc.status === 'error' &&
      /ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ERR_TIMED_OUT|ERR_PROXY|ERR_TUNNEL|Object has been destroyed/i.test(
        acc.statusMessage || ''
      )
    ) {
      store.updateAccount(acc.id, {
        status: 'expired',
        statusMessage: 'Mạng/Proxy gián đoạn lúc đăng nhập — bấm "Đăng nhập FB" để lấy phiên ngay'
      })
      changed = true
    }
  }

  const allAccounts = new Map(store.getAccounts().map((a) => [a.id, a]))
  const tasks = store.getTasks()

  // Detect tasks that accidentally shared a conversationId or videoId with an earlier task
  const seenCompletedConvIds = new Set<string>()
  const seenCompletedVideoIds = new Set<string>()
  const duplicateCompletedTaskIds = new Set<string>()
  const convIdCounts = new Map<string, number>()

  for (const t of [...tasks].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))) {
    if (t.conversationId) {
      convIdCounts.set(t.conversationId, (convIdCounts.get(t.conversationId) || 0) + 1)
    }
    if (t.status === 'completed') {
      const hasDupConv = Boolean(t.conversationId && seenCompletedConvIds.has(t.conversationId))
      const hasDupVid = Boolean(t.videoId && seenCompletedVideoIds.has(t.videoId))
      if (hasDupConv || hasDupVid) {
        duplicateCompletedTaskIds.add(t.id)
      } else {
        if (t.conversationId) seenCompletedConvIds.add(t.conversationId)
        if (t.videoId) seenCompletedVideoIds.add(t.videoId)
      }
    }
  }

  for (const t of tasks) {
    const patch: Partial<VideoTask> = {}

    const unwrappedPrompt = unwrapPromptWrapper(t.prompt || '')
    const hadWrappedPrompt = Boolean(unwrappedPrompt && unwrappedPrompt !== t.prompt)
    if (hadWrappedPrompt) {
      patch.prompt = unwrappedPrompt
    }

    const sanitizedPrompt = sanitizePromptForDolaSafety(unwrappedPrompt)
    const hadRefusedKeywords =
      t.status === 'failed' &&
      t.errorCode === 'CONTENT_REFUSED' &&
      sanitizedPrompt !== unwrappedPrompt
    if (hadRefusedKeywords) {
      patch.prompt = sanitizedPrompt
    }

    const hadFast30Mismatch = t.duration > 15 && t.model === 'seedance_v2.0_fast'
    // Normalize 30s tasks that were accidentally set to seedance_v2.0_fast (which caps at 15s)
    if (hadFast30Mismatch) {
      patch.model = 'seedance_v2.5'
    }

    // Clear orphaned, expired, or error account assignments so active ready accounts can take over
    const assigned = t.assignedAccountId ? allAccounts.get(t.assignedAccountId) : undefined
    const hadOrphanedAccount = Boolean(
      t.assignedAccountId &&
        (!assigned || !assigned.enabled || assigned.status === 'expired' || assigned.status === 'error')
    )
    if (hadOrphanedAccount && t.status !== 'completed') {
      patch.assignedAccountId = undefined
      patch.assignedAccountName = undefined
      patch.assignedProxyId = undefined
      patch.assignedProxyLabel = undefined
      patch.conversationId = undefined
    } else if (assigned) {
      const pxInfo = ensureAccountHasLiveProxy(assigned.id)
      if (t.assignedProxyId !== pxInfo.proxyId || t.assignedProxyLabel !== pxInfo.proxyLabel) {
        patch.assignedProxyId = pxInfo.proxyId
        patch.assignedProxyLabel = pxInfo.proxyLabel
      }
    }

    // Ensure every task has a valid live proxy badge even before an account is locked in
    if (!patch.assignedProxyId && (!t.assignedProxyId || hadOrphanedAccount)) {
      const liveRots = store.getRotatingProxies().filter((r) => r.status !== 'expired')
      if (liveRots.length > 0) {
        const chosenRot = liveRots[(t.sequenceNumber - 1) % liveRots.length]
        const rotProxyId = `rot:${chosenRot.id}`
        patch.assignedProxyId = rotProxyId
        patch.assignedProxyLabel = formatAccountProxyLabel(rotProxyId)
      }
    }

    const isDuplicateCompleted = duplicateCompletedTaskIds.has(t.id)
    if (isDuplicateCompleted) {
      if (t.localFile && fs.existsSync(t.localFile)) {
        try {
          fs.unlinkSync(t.localFile)
        } catch {}
      }
      patch.localFile = undefined
      patch.videoUrl = undefined
      patch.videoId = undefined
      patch.fileSizeBytes = undefined
      patch.completedAt = undefined
    }

    // Check if a completed 30s task previously only produced a ~15s clip so we can extend Part 2 & merge to 30s
    let needs30sExtension = false
    if (
      !isDuplicateCompleted &&
      t.status === 'completed' &&
      t.duration > 15 &&
      t.localFile &&
      fs.existsSync(t.localFile)
    ) {
      try {
        const dur = parseMp4DurationFromBuffer(fs.readFileSync(t.localFile))
        if (dur && dur > 5 && dur < t.duration - 4) {
          needs30sExtension = true
        }
      } catch {}
    }

    // Also recover tasks that failed earlier before proxies were attached (!t.assignedProxyId) or due to PROXY_ERROR / AUTH_EXPIRED / 710020202 / 710022002 / error_code=1 / watchdog hang
    const failedWithoutProxy =
      t.status === 'failed' &&
      (!t.assignedProxyId ||
        t.errorCode === 'PROXY_ERROR' ||
        t.errorCode === 'AUTH_EXPIRED' ||
        /Treo \d+s ở bước|710020202|710022002|error_code=1|something went wrong|experiencing high demand|không trả về conversation_id|common invalid param|resolveRotatingProxy|applyAccountProxyToPartition|onStatus is not defined/i.test(
          `${t.errorMessage || ''} ${t.progressText || ''}`
        ))

    const hadSharedFailedConvId = Boolean(
      t.status === 'failed' && t.conversationId && (convIdCounts.get(t.conversationId) || 0) > 1
    )

    // Interrupted while Dola was rendering: keep the conversation + account so the rerun collects that
    // (already paid-for) video instead of sending the prompt again.
    const resumeInConversation = canResumeAfterRestart(t, !hadOrphanedAccount && isAccountAlive(assigned))

    // Recover tasks that were interrupted in the middle of execution OR failed due to deleted account / 30s-Fast mismatch / double-wrapped prompt / content refusal with sanitizable keywords / duplicate conversationId
    if (resumeInConversation) {
      patch.status = 'queued'
      patch.resumeAfterRestart = true
      patch.retryCount = 0
      patch.errorCode = undefined
      patch.errorMessage = undefined
      patch.progressText = `Khôi phục sau khi khởi động lại — chờ lấy video Dola đang dựng ở hội thoại #${(t.conversationId || '').slice(-6)}, không gửi lại lệnh…`
    } else if (
      t.status === 'preparing' ||
      t.status === 'uploading' ||
      t.status === 'submitting' ||
      t.status === 'polling' ||
      t.status === 'downloading' ||
      (t.status === 'failed' &&
        (hadOrphanedAccount ||
          hadFast30Mismatch ||
          hadWrappedPrompt ||
          hadRefusedKeywords ||
          failedWithoutProxy ||
          hadSharedFailedConvId ||
          t.conversationId === '38418093403998737')) ||
      needs30sExtension ||
      isDuplicateCompleted
    ) {
      patch.status = 'queued'
      patch.retryCount = 0
      patch.errorCode = undefined
      patch.errorMessage = undefined
      patch.conversationId = undefined
      patch.resumeAfterRestart = undefined
      patch.assignedAccountId = undefined
      patch.assignedAccountName = undefined
      patch.progressText = isDuplicateCompleted
        ? 'Đã phát hiện video bị trùng hội thoại cũ (#8) — đang tự động tạo lại đúng video riêng…'
        : needs30sExtension
          ? 'Đã giữ Phần 1 (15s) — đang tự động tạo tiếp Phần 2 (15s–30s) & ghép đủ 30s…'
          : 'Đã gắn Proxy xoay & xếp hàng chạy lại với Native Engine…'
    } else if (t.status === 'queued') {
      if (t.busyRetryAt !== undefined) {
        patch.busyRetryAt = undefined
      }
      if (
        (t.retryCount || 0) > 0 &&
        /Nhiều tài khoản cùng gặp sự cố|Dola quá tải tạm thời|710022002/i.test(t.progressText || '')
      ) {
        patch.retryCount = 0
        patch.assignedAccountId = undefined
        patch.assignedAccountName = undefined
        patch.progressText = 'Đang chờ trong hàng đợi…'
      } else if (/Nhiều tài khoản cùng gặp sự cố/i.test(t.progressText || '')) {
        patch.progressText = 'Đang chờ trong hàng đợi…'
      }
    }

    if (Object.keys(patch).length > 0) {
      store.updateTask(t.id, patch)
      changed = true
    }
  }

  // Ensure queued tasks do not pile up on the exact same assignedAccountId on startup
  const claimedStartupAccounts = new Set<string>()
  for (const t of store.getTasks()) {
    if (t.status === 'queued' && !t.resumeAfterRestart && t.assignedAccountId) {
      if (claimedStartupAccounts.has(t.assignedAccountId)) {
        store.updateTask(t.id, {
          assignedAccountId: undefined,
          assignedAccountName: undefined
        })
        changed = true
      } else {
        claimedStartupAccounts.add(t.assignedAccountId)
      }
    }
  }

  if (changed) {
    broadcastStateUpdate()
  }

  void syncWarmGatewayAccountsOnStartup()

  if (!watchdogTimer) {
    watchdogTimer = setInterval(() => {
      reapStalledRunningTasks()
      if (!queuePaused && store.getTasks().some((t) => t.status === 'queued')) {
        triggerQueueScheduler()
      }
    }, 12_000)
  }
}

async function syncWarmGatewayAccountsOnStartup(): Promise<void> {
  try {
    const gwDir = '/Users/dat/Downloads/dola-render-gateway/accounts'
    if (!fs.existsSync(gwDir)) return
    const existingAccounts = store.getAccounts()
    const existingSids = new Set<string>()
    const existingUids = new Set<string>()
    for (const a of existingAccounts) {
      if (a.fbUid) existingUids.add(a.fbUid)
      const m = (a.cookieHeader || '').match(/(?:^|;\s*)sessionid=([^;\s]+)/)
      if (m && m[1]) existingSids.add(m[1])
    }

    const dirs = fs.readdirSync(gwDir)
    let added = 0
    for (const dirName of dirs) {
      const cjPath = `${gwDir}/${dirName}/cookies.json`
      if (!fs.existsSync(cjPath)) continue
      try {
        const arr = JSON.parse(fs.readFileSync(cjPath, 'utf8'))
        if (!Array.isArray(arr)) continue
        const dolaPairs: string[] = []
        const fbPairs: string[] = []
        let sid = ''
        for (const c of arr) {
          const dom = String(c?.domain || '').toLowerCase()
          const k = String(c?.name || '').trim()
          const v = String(c?.value || '').trim()
          if (!k || !v) continue
          if (dom.includes('dola.com')) {
            dolaPairs.push(`${k}=${v}`)
            if (k === 'sessionid' && v.length > 6) sid = v
          } else if (dom.includes('facebook.com')) {
            fbPairs.push(`${k}=${v}`)
          }
        }
        if (!sid || existingSids.has(sid)) continue
        const uid = dirName.replace(/^fb/i, '')
        if (uid && existingUids.has(uid)) continue
        const cookieStr = dolaPairs.join('; ')
        const resp = await session.defaultSession
          .fetch(
            'https://www.dola.com/alice/profile/self_brief?aid=495671&device_platform=web&samantha_web=1&use-olympus-account=1',
            {
              method: 'POST',
              headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json',
                Cookie: cookieStr,
                Origin: 'https://www.dola.com',
                Referer: 'https://www.dola.com/chat/',
                'agw-js-conv': 'str'
              },
              body: '{}'
            }
          )
          .then((r) => r.json() as Promise<any>)
          .catch(() => null)
        const brief = resp?.data?.profile_brief
        if (resp?.code === 0 && brief?.id && !brief?.is_guest) {
          const accId = crypto.randomUUID()
          const newAcc: AccountProfile = {
            id: accId,
            name: /^615\d+$/.test(uid) ? `FB ${uid}` : dirName,
            partition: `persist:dola-${accId}`,
            sourceType: 'facebook',
            fbUid: /^615\d+$/.test(uid) ? uid : undefined,
            fbCookie: fbPairs.length > 0 ? fbPairs.join('; ') : undefined,
            cookieHeader: cookieStr,
            userId: String(brief.id),
            screenName: String(brief.nickname || brief.user_name || uid),
            poolId: 'goc',
            status: 'ready',
            statusMessage: `Sẵn sàng (${brief.nickname || uid})`,
            enabled: true,
            videosToday: 0,
            videosTodayDate: localDayKey(),
            totalVideos: 0,
            createdAt: Date.now()
          }
          store.upsertAccount(newAcc)
          ensureAccountHasLiveProxy(accId)
          existingSids.add(sid)
          if (uid) existingUids.add(uid)
          added++
        }
      } catch {}
    }
    if (added > 0) {
      broadcastStateUpdate()
      triggerQueueScheduler()
    }
  } catch {}
}

const MAX_BATCH = 500
const MAX_PROMPT_CHARS = 8000
const MAX_REF_IMAGES = 10
const DONE_REST_MS = 60_000
const RECYCLE_COOLDOWN_MS = 3 * 60_000
const MAX_RECYCLES = 3
const MAX_REFUSED_RETRIES = 2
const accountRecycleCounts = new Map<string, number>()

export function submitBatchTasks(payload: QueueSubmitPayload): {
  ok: boolean
  addedCount: number
  message: string
} {
  const settings = store.getSettings()
  const activePoolId = payload.poolId || settings.activePoolId || 'all'
  const allEnabledAccounts = store
    .getAccounts()
    .filter((a) => a.enabled && a.status !== 'expired' && a.status !== 'quota_exhausted')
    .sort((a, b) => {
      const aReady = a.status === 'ready' ? 0 : 1
      const bReady = b.status === 'ready' ? 0 : 1
      if (aReady !== bReady) return aReady - bReady
      return (a.videosToday || 0) - (b.videosToday || 0)
    })

  const poolFilteredAccounts =
    activePoolId !== 'all'
      ? allEnabledAccounts.filter((a) => accountPoolOf(a) === activePoolId)
      : allEnabledAccounts

  const targetAccounts =
    payload.selectedAccountIds && payload.selectedAccountIds.length > 0
      ? poolFilteredAccounts.filter((a) => payload.selectedAccountIds!.includes(a.id))
      : poolFilteredAccounts.length > 0
        ? poolFilteredAccounts
        : allEnabledAccounts

  const cleanPrompts = payload.prompts
    .map((p) => unwrapPromptWrapper(p.trim()).slice(0, MAX_PROMPT_CHARS))
    .filter(Boolean)
    .slice(0, MAX_BATCH)
  if (cleanPrompts.length === 0) {
    return { ok: false, addedCount: 0, message: 'Vui lòng nhập ít nhất 1 câu lệnh (prompt).' }
  }

  const projectId = payload.projectId || settings.activeProjectId
  const existingTasks = store.getTasks()
  let maxSeq = existingTasks.reduce((m, t) => Math.max(m, t.sequenceNumber || 0), 0)
  const duration = payload.duration || 10
  // Seedance 2.0 Fast only supports 5s-15s; 30s requires Seedance 2.5 Pro
  const normalizedModel =
    duration > 15 ? 'seedance_v2.5' : payload.model || 'seedance_v2.5'
  const cappedRefImages = (payload.referenceImages || []).slice(0, MAX_REF_IMAGES)

  const newTasks: VideoTask[] = cleanPrompts.map((promptText, idx) => {
    maxSeq++
    let assignedAcc: AccountProfile | undefined

    if (targetAccounts.length > 0) {
      if (settings.batchAllocationMode === '20_per_acc') {
        const accIdx = Math.floor(idx / 20) % targetAccounts.length
        assignedAcc = targetAccounts[accIdx]
      } else if (settings.batchAllocationMode === '10_per_acc') {
        const accIdx = Math.floor(idx / 10) % targetAccounts.length
        assignedAcc = targetAccounts[accIdx]
      } else {
        // even_split
        const accIdx = idx % targetAccounts.length
        assignedAcc = targetAccounts[accIdx]
      }
    }

    const pxInfo = assignedAcc ? ensureAccountHasLiveProxy(assignedAcc.id) : undefined

    return {
      id: `task-${crypto.randomUUID().slice(0, 8)}`,
      projectId,
      poolId: activePoolId !== 'all' ? activePoolId : undefined,
      sequenceNumber: maxSeq,
      prompt: promptText,
      model: normalizedModel,
      mode:
        cappedRefImages.length > 0
          ? 'image_to_video'
          : payload.mode || 'text_to_video',
      ratio: payload.ratio || '9:16',
      duration,
      referenceImages: cappedRefImages,
      assignedAccountId: assignedAcc?.id,
      assignedAccountName: assignedAcc?.name,
      assignedProxyId: pxInfo?.proxyId,
      assignedProxyLabel: pxInfo?.proxyLabel,
      status: 'queued',
      progressText: 'Đang chờ trong hàng đợi…',
      retryCount: 0,
      createdAt: Date.now() + idx,
      updatedAt: Date.now() + idx
    }
  })

  store.addTasks(newTasks)
  queuePaused = false
  broadcastStateUpdate()
  triggerQueueScheduler()

  return {
    ok: true,
    addedCount: newTasks.length,
    message: `Đã thêm ${newTasks.length} video vào hàng đợi!`
  }
}

// accountId -> timestamp until which this account is temporarily cooled down after a 710022002 / error_code=1 / GENERAL_ERROR
const accountTempCooldownUntil = new Map<string, number>()
const accountLastUsedAt = new Map<string, number>()
const ACCOUNT_TEMP_COOLDOWN_MS = 60_000
/** Max account/proxy failovers for one task before it is marked failed. */
const FAILOVER_RETRY_LIMIT = 60
/** accountId -> failures in a row on that nick (reset when it delivers a video). In-memory: a restart forgives. */
const consecutiveFailures = new Map<string, number>()

/** Rest a nick that failed on its own (not a Dola-wide overload), longer each time it fails again in a row. */
function penalizeAccount(accountId: string): void {
  const n = (consecutiveFailures.get(accountId) || 0) + 1
  consecutiveFailures.set(accountId, n)
  accountTempCooldownUntil.set(accountId, Date.now() + failureCooldownMs(n))
}

function isAccountCooledDown(accountId: string): boolean {
  const until = accountTempCooldownUntil.get(accountId) || 0
  if (until <= Date.now()) {
    if (until > 0) accountTempCooldownUntil.delete(accountId)
    return false
  }
  return true
}

function sortAccountsByFreshness(list: AccountProfile[]): AccountProfile[] {
  return [...list].sort((a, b) => {
    const aCool = isAccountCooledDown(a.id) ? 1 : 0
    const bCool = isAccountCooledDown(b.id) ? 1 : 0
    if (aCool !== bCool) return aCool - bCool
    const aVids = a.videosToday || 0
    const bVids = b.videosToday || 0
    if (aVids !== bVids) return aVids - bVids
    const aUsed = accountLastUsedAt.get(a.id) || 0
    const bUsed = accountLastUsedAt.get(b.id) || 0
    if (aUsed !== bUsed) return aUsed - bUsed
    const aCoolUntil = accountTempCooldownUntil.get(a.id) || 0
    const bCoolUntil = accountTempCooldownUntil.get(b.id) || 0
    if (aCoolUntil !== bCoolUntil) return aCoolUntil - bCoolUntil
    return (b.createdAt || 0) - (a.createdAt || 0)
  })
}

/** Account that can still run work, even if it's busy right now. */
function isAccountAlive(a: AccountProfile | undefined): boolean {
  return Boolean(a && a.enabled && (a.status === 'ready' || a.status === 'recycling'))
}

/** Accounts that can run a job right now (the lô binding and cap are applied on top of this set). */
function runnableAccounts(poolId?: string): AccountProfile[] {
  const allReady = store
    .getAccounts()
    .filter(
      (a) =>
        a.enabled &&
        !busyAccountOwner.has(a.id) &&
        a.status === 'ready'
    )
  const nonCooldown = allReady.filter((a) => !isAccountCooledDown(a.id))
  const baseList = sortAccountsByFreshness(nonCooldown.length > 0 ? nonCooldown : allReady)
  if (poolId && poolId !== 'all') {
    const inPool = baseList.filter((a) => accountPoolOf(a) === poolId)
    if (inPool.length > 0) return inPool
  }
  return baseList
}

function getBusyProxyIds(excludeAccountId?: string): Set<string> {
  const busyProxies = new Set<string>()
  for (const [accId] of busyAccountOwner) {
    if (accId === excludeAccountId) continue
    const acc = store.getAccountById(accId)
    if (acc?.proxyId) busyProxies.add(acc.proxyId)
  }
  return busyProxies
}

function pickAvailableAccountForTask(task: VideoTask): AccountProfile | undefined {
  const runnable = runnableAccounts(task.poolId)

  // Resumed after a restart: its render is paid for and lives in this account's session, so only this
  // account can collect it. Cap, cooldown and pool don't apply (nothing new is generated); wait while busy.
  if (task.resumeAfterRestart && task.conversationId && task.assignedAccountId) {
    const home = store.getAccountById(task.assignedAccountId)
    const homeRunnable = Boolean(home && home.enabled && home.status === 'ready' && !busyAccountOwner.has(home.id))
    const verdict = resumeAccountDecision(homeRunnable, isAccountAlive(home))
    if (verdict === 'run') return home
    if (verdict === 'restart' && task.recoverOnly) {
      const msg = `Nick ${task.assignedAccountName || ''} không còn dùng được — không lấy lại được video ở hội thoại cũ.`
      store.updateTask(task.id, { status: 'failed', errorCode: 'RECOVER_EMPTY', errorMessage: msg, progressText: msg })
    } else if (verdict === 'restart') {
      // account died → that render is unreachable: drop the resume, normal picking on the next pass
      store.updateTask(task.id, { resumeAfterRestart: undefined, conversationId: undefined })
    }
    return undefined
  }

  // If the assigned account is currently busy, on temporary cooldown, or already used while fresh accounts exist, clear assignment so another ready account runs immediately
  const effectiveAssignedId =
    task.assignedAccountId &&
    !busyAccountOwner.has(task.assignedAccountId) &&
    !isAccountCooledDown(task.assignedAccountId)
      ? task.assignedAccountId
      : undefined

  // Prefer runnable accounts whose proxy is NOT currently in use by another running thread
  // so concurrent threads never share the same IP at the same second.
  const busyProxyIds = getBusyProxyIds()
  const nonCollidingRunnable = runnable.filter(
    (a) => a.id === effectiveAssignedId || !a.proxyId || !busyProxyIds.has(a.proxyId)
  )
  const effectiveRunnable = nonCollidingRunnable.length > 0 ? nonCollidingRunnable : runnable

  const cap = perAccountCap(store.getSettings().batchAllocationMode)
  const decision = chooseAccount({
    assignedId: effectiveAssignedId,
    available: effectiveRunnable.map((a) => ({ id: a.id, videosToday: a.videosToday || 0 })),
    homeBusy: false,
    cap
  })

  if (decision.use) return effectiveRunnable.find((a) => a.id === decision.use)
  if (decision.wait) return undefined // the lô's account is busy — hold this task, run other lôs

  // No under-cap account is free. Last resort: recycle an exhausted account (if enabled).
  if (store.getSettings().autoRecycleOnQuota) {
    const recyclable = store
      .getAccounts()
      .find(
        (a) =>
          a.enabled &&
          // FB accounts can't be recycled (see canAutoRecycle): handing one out would re-send to a spent account
          a.sourceType !== 'facebook' &&
          !busyAccountOwner.has(a.id) &&
          a.status === 'quota_exhausted' &&
          (!task.poolId || task.poolId === 'all' || accountPoolOf(a) === task.poolId)
      )
    if (recyclable) return recyclable
  }

  return undefined
}

export function triggerQueueScheduler(): void {
  if (schedulerTimer) clearTimeout(schedulerTimer)
  schedulerTimer = setTimeout(() => {
    schedulerTimer = null
    void runQueueLoop()
  }, 150)
}

/** Live thread cap below the user's setting while Dola is overloaded; null = running at the full setting. */
let adaptiveConcurrency: number | null = null

function settingConcurrency(): number {
  const raw = Number(store.getSettings().concurrency ?? 0)
  const readyCount = store
    .getAccounts()
    .filter((a) => a.enabled && (a.status === 'ready' || a.status === 'recycling')).length
  const effectiveReady = Math.max(1, readyCount)
  if (raw <= 0) {
    // Auto mode (`workers = 0` in `src/thread-cap.js`): min(6, floor((freeRamGB - 3) / 0.6))
    const freeGb = os.freemem() / 1024 ** 3
    const autoCap = Math.min(6, Math.max(1, Math.floor((freeGb - 3) / 0.6)))
    return Math.min(autoCap, effectiveReady)
  }
  return Math.min(Math.max(1, Math.min(100, raw)), effectiveReady)
}

function adaptConcurrency(event: 'success' | 'overload'): void {
  const max = settingConcurrency()
  const next = nextConcurrency(adaptiveConcurrency ?? max, max, event)
  adaptiveConcurrency = next >= max ? null : next
}

async function runQueueLoop(): Promise<void> {
  if (queuePaused) return

  store.rolloverDailyVideoCounts()

  const hasReadyPool = runnableAccounts().length > 0
  if (hasReadyPool && adaptiveConcurrency !== null) {
    adaptiveConcurrency = null
  }
  const maxConcurrency = hasReadyPool
    ? settingConcurrency()
    : Math.min(settingConcurrency(), adaptiveConcurrency ?? Infinity)

  if (runningTaskIds.size >= maxConcurrency) return

  // Pro-overload retries sit out until their time; the 12s watchdog picks them up once due.
  const now = Date.now()
  const queuedTasks = store
    .getTasks()
    .filter((t) => t.status === 'queued' && !runningTaskIds.has(t.id) && (t.busyRetryAt ?? 0) <= now)
    .sort((a, b) => {
      // Prioritize fresh tasks (retryCount === 0) before retried tasks so a few problematic tasks never starve the queue
      const ra = a.retryCount || 0
      const rb = b.retryCount || 0
      if (ra !== rb) return ra - rb
      return a.sequenceNumber - b.sequenceNumber
    })

  if (queuedTasks.length === 0) return

  if (now < platformBusyUntil && !hasReadyPool) {
    warnStalledQueue(queuedTasks)
    return
  }

  let startedThisPass = 0
  for (const task of queuedTasks) {
    if (runningTaskIds.size >= maxConcurrency) break

    const account = pickAvailableAccountForTask(task)
    if (!account) continue

    busyAccountOwner.set(account.id, task.id)
    accountLastUsedAt.set(account.id, Date.now())
    runningTaskIds.add(task.id)
    const staggerMs = startedThisPass * 600
    startedThisPass++

    void (async () => {
      if (staggerMs > 0) {
        await new Promise((r) => setTimeout(r, staggerMs))
      }
      await executeSingleTask(task, account)
    })().finally(() => {
      // Only release the account if this task still owns it. A task cancelled mid-run frees the
      // account early (see cancelTask); by the time this late .finally() fires another task may
      // already own it, and an unconditional delete would double-book that account.
      if (busyAccountOwner.get(account.id) === task.id) busyAccountOwner.delete(account.id)
      runningTaskIds.delete(task.id)
      broadcastStateUpdate()
      triggerQueueScheduler()
    })
  }

  // Nothing advanced this pass but tasks are still queued → tell the user why instead of leaving
  // them stuck on the silent "Đang chờ trong hàng đợi…".
  if (startedThisPass === 0) {
    warnStalledQueue(queuedTasks)
  }
}

function warnStalledQueue(queuedTasks: VideoTask[]): void {
  const stillQueued = queuedTasks.filter(
    (t) => !runningTaskIds.has(t.id) && store.getTasks().find((x) => x.id === t.id)?.status === 'queued'
  )
  if (stillQueued.length === 0) return

  const reason = describeQueueBlock()
  let changed = false
  for (const t of stillQueued) {
    if (t.progressText !== reason) {
      store.updateTask(t.id, { progressText: reason })
      changed = true
    }
  }
  if (changed) broadcastStateUpdate()
}

/**
 * Fail any running task whose progress froze past STALL_TIMEOUT_MS and release its account, so a hang
 * deep in the engine (e.g. a Dola page load that never finishes) can't hold a lô's account forever.
 * ponytail: we can't reach the engine's hidden window to kill it, so its zombie lingers until Dola
 * errors out (Chromium caps a stuck navigation at ~5 min); this just frees the QUEUE immediately.
 * The engine ignores its own late result because the task is no longer in a running state.
 */
function reapStalledRunningTasks(): void {
  const now = Date.now()
  const tasksById = new Map(store.getTasks().map((t) => [t.id, t]))
  let changed = false

  // 1. Reap running tasks whose progress froze past the stall timeout (engine hang deep inside).
  for (const t of tasksById.values()) {
    if (!RUNNING_STATUSES.includes(t.status)) continue
    if (now - (t.updatedAt || 0) < STALL_TIMEOUT_MS) continue

    const frozenSec = Math.round((now - (t.updatedAt || 0)) / 1000)
    const msg = `⚠️ Treo ${frozenSec}s ở bước "${t.progressText || t.status}" — đã tự dừng & nhả tài khoản. Bấm Thử lại để chạy lại.`
    store.updateTask(t.id, {
      status: 'failed',
      errorCode: 'STALLED',
      errorMessage: msg,
      progressText: msg
    })
    runningTaskIds.delete(t.id)
    if (t.assignedAccountId && busyAccountOwner.get(t.assignedAccountId) === t.id) {
      busyAccountOwner.delete(t.assignedAccountId)
    }
    changed = true
  }

  // 2. Self-heal LEAKED concurrency slots: a runningTaskIds / busyAccountOwner entry whose task is
  // gone or no longer in a running state (its .finally never fired — e.g. a crash, or a late release)
  // silently eats a luồng forever, so the queue can slide down to 0 running while tasks pile up.
  // Free every such stale slot so the scheduler can refill all luồng next tick.
  for (const id of [...runningTaskIds]) {
    const t = tasksById.get(id)
    if (!t || !RUNNING_STATUSES.includes(t.status)) {
      runningTaskIds.delete(id)
      changed = true
    }
  }
  for (const [accId, taskId] of [...busyAccountOwner]) {
    const t = tasksById.get(taskId)
    if (!t || !RUNNING_STATUSES.includes(t.status)) {
      busyAccountOwner.delete(accId)
      changed = true
    }
  }

  if (changed) {
    broadcastStateUpdate()
    triggerQueueScheduler()
  }
}

function describeQueueBlock(): string {
  if (Date.now() < platformBusyUntil) {
    const until = new Date(platformBusyUntil).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })
    return `⏳ Nhiều tài khoản cùng gặp sự cố (quá tải hoặc bị đẩy ra login) — hàng đợi tạm nghỉ tới ${until} rồi tự chạy tiếp.`
  }
  const enabled = store.getAccounts().filter((a) => a.enabled)
  if (enabled.length === 0) {
    return '⚠️ Hàng đợi tạm dừng: chưa có tài khoản nào đang bật. Hãy thêm hoặc bật tài khoản.'
  }
  const allLoggedOut = describeAllLoggedOut(enabled.map((a) => a.status))
  if (allLoggedOut) return allLoggedOut
  if (enabled.every((a) => a.status === 'quota_exhausted')) {
    return '⚠️ Hàng đợi tạm dừng: mọi tài khoản đã hết lượt hôm nay. Bật "Tự động làm mới lượt" hoặc thêm tài khoản mới.'
  }
  // Cap reached: every usable account has hit the per-account cap set by the batch mode.
  const cap = perAccountCap(store.getSettings().batchAllocationMode)
  const usable = enabled.filter((a) => a.status !== 'expired')
  if (
    cap > 0 &&
    usable.length > 0 &&
    usable.every((a) => a.status === 'quota_exhausted' || (a.videosToday || 0) >= cap)
  ) {
    return `⚠️ Hàng đợi tạm dừng: mọi tài khoản đã đạt trần ${cap} video/tài khoản hôm nay. Đổi "Cách chia lô" sang "Chia đều xoay vòng" để bỏ trần, hoặc thêm tài khoản.`
  }
  // Some account IS running a video — the queue is just at capacity, not stalled. Say "waiting for a
  // turn" (calm, no ⚠️) so the user doesn't think it broke; the ⚠️ wording is kept only for the real
  // blocks above (no accounts / all logged out / all out of quota / cap reached) and the idle case below.
  const busy = busyAccountOwner.size
  if (busy > 0) {
    const throttled =
      adaptiveConcurrency !== null
        ? ` (tạm chạy ${adaptiveConcurrency}/${settingConcurrency()} luồng vì Dola quá tải — tự tăng lại khi ra video)`
        : ''
    return `⏳ Đang chờ tới lượt — ${busy} tài khoản đang bận tạo video${throttled}, sẽ chạy khi có nick rảnh…`
  }
  return '⚠️ Hàng đợi tạm dừng: đang chờ tài khoản rảnh hoặc đăng nhập xong…'
}

// A task whose video keeps coming back as a duplicate gives up after this many re-makes.
const DUPLICATE_RETRY_LIMIT = 8
// A resumed task that can't reach its conversation retries on the same account this many times before
// giving up the resume and sending normally.
const RESUME_RETRY_LIMIT = 3

/**
 * Library video with the same bytes as a just-downloaded file (same size, then md5), ignoring this task's
 * own earlier entry. Only same-size files get hashed, so this stays cheap on a large library.
 */
function findLibraryDuplicate(
  localFile: string,
  sizeBytes: number,
  task: VideoTask
): VideoLibraryItem | undefined {
  try {
    const size = sizeBytes || fs.statSync(localFile).size
    const ownIds = new Set([task.videoId, `vid-${task.id}`].filter(Boolean))
    const sameSize = store
      .getVideos()
      .filter(
        (v) =>
          v.sizeBytes === size &&
          !ownIds.has(v.id) &&
          v.localFile &&
          v.localFile !== localFile &&
          fs.existsSync(v.localFile)
      )
    if (sameSize.length === 0) return undefined
    const md5 = (p: string): string => crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex')
    const hash = md5(localFile)
    return sameSize.find((v) => md5(v.localFile) === hash)
  } catch {
    return undefined
  }
}

async function executeSingleTask(task: VideoTask, account: AccountProfile): Promise<void> {
  const settings = store.getSettings()
  const canAutoRecycle = settings.autoRecycleOnQuota && account.sourceType !== 'facebook'

  // Ensure the account has a live non-colliding rotating/static proxy bound before running in the queue
  const pxInfo = ensureAccountHasLiveProxy(account.id, getBusyProxyIds(account.id))
  account = store.getAccountById(account.id) || account

  // Auto-upgrade model to seedance_v2.5 if duration > 15s (Seedance 2.0 Fast only supports up to 15s)
  if (task.duration > 15 && task.model === 'seedance_v2.0_fast') {
    task = { ...task, model: 'seedance_v2.5' }
    store.updateTask(task.id, { model: 'seedance_v2.5' })
  }

  // If the chosen account is already marked quota_exhausted and autoRecycleOnQuota is enabled, recycle it first
  if (account.status === 'quota_exhausted' && canAutoRecycle) {
    store.updateTask(task.id, {
      status: 'preparing',
      assignedAccountId: account.id,
      assignedAccountName: account.name,
      assignedProxyId: pxInfo.proxyId,
      assignedProxyLabel: pxInfo.proxyLabel,
      progressText: `Tài khoản ${account.name} hết lượt — đang tự động làm mới lượt…`
    })
    broadcastStateUpdate()

    const rec = await recycleAccountQuota(account.id)
    broadcastStateUpdate()
    if (!rec.ok) {
      store.updateAccount(account.id, {
        status: 'quota_exhausted',
        statusMessage: rec.message
      })
      store.updateTask(task.id, {
        status: 'failed',
        errorCode: 'QUOTA_EXHAUSTED',
        errorMessage: rec.message,
        progressText: rec.message
      })
      return
    }
  }

  store.updateTask(task.id, {
    status: 'preparing',
    busyRetryAt: undefined,
    assignedAccountId: account.id,
    assignedAccountName: account.name,
    assignedProxyId: pxInfo.proxyId,
    assignedProxyLabel: pxInfo.proxyLabel,
    // a resumed task keeps its conversation, so another restart mid-wait resumes it again
    conversationId: task.resumeAfterRestart ? task.conversationId : undefined,
    resumeAfterRestart: undefined,
    progressText: `Bắt đầu xử lý trên ${account.name} [Proxy: ${pxInfo.proxyLabel}]…`,
    errorMessage: undefined,
    errorCode: undefined
  })
  broadcastStateUpdate()

  const result = await generateVideoWithAccount(task, account, (status, progressText) => {
    const latest = store.getTasks().find((x) => x.id === task.id)
    if (latest && latest.status === 'cancelled') return
    const latestAcc = store.getAccountById(account.id) || account
    const latestPxLabel = formatAccountProxyLabel(latestAcc.proxyId)
    store.updateTask(task.id, {
      status,
      progressText,
      assignedProxyId: latestAcc.proxyId,
      assignedProxyLabel: latestPxLabel
    })
    broadcastStateUpdate()
  })

  // If cancelled while running, do not overwrite status
  const currentTask = store.getTasks().find((x) => x.id === task.id)
  if (!currentTask || currentTask.status === 'cancelled') {
    return
  }

  if (result.ok && result.localFile) {
    // Safety net for every engine path (HTTP, browser, fast-path): Dola sometimes hands back an older
    // conversation, so the "new" video is one already in the library. Drop the copy, re-make in a fresh chat.
    const dupOf = findLibraryDuplicate(result.localFile, result.sizeBytes || 0, task)
    if (dupOf) {
      try {
        fs.unlinkSync(result.localFile)
      } catch {}
      const canRetry = task.retryCount < DUPLICATE_RETRY_LIMIT
      const dupAt = new Date(dupOf.createdAt).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })
      const msg = `Dola trả lại video cũ đã có trong Kho (${dupOf.profileName} lúc ${dupAt}) — đã xoá bản trùng.`
      store.updateTask(task.id, {
        status: canRetry ? 'queued' : 'failed',
        errorCode: canRetry ? undefined : 'DUPLICATE_VIDEO',
        conversationId: undefined,
        retryCount: task.retryCount + 1,
        errorMessage: msg,
        progressText: canRetry ? `${msg} Đang tạo lại trong hội thoại mới…` : msg
      })
      return
    }

    const updatedAcc = store.getAccountById(account.id)
    const today = localDayKey()
    const priorToday = updatedAcc?.videosTodayDate === today ? updatedAcc.videosToday || 0 : 0
    store.updateAccount(account.id, {
      status: 'ready',
      videosToday: priorToday + 1,
      videosTodayDate: today,
      totalVideos: (updatedAcc?.totalVideos || 0) + 1,
      statusMessage: `Vừa tạo xong Video #${task.sequenceNumber}`
    })

    // Dola can hand back a 15s clip for a 30s task (account out of Pro) — keep it, but say so.
    const actualSec = result.durationSec
    const shortWarning =
      actualSec !== undefined && isShorterThanRequested(actualSec, task.duration)
        ? `⚠️ Video chỉ dài ${Math.round(actualSec)} giây (yêu cầu ${task.duration} giây) — tài khoản ${account.name} có thể đã hết lượt Pro.`
        : undefined

    consecutiveFailures.delete(account.id)
    // DONE_REST_MS (`src/scheduler-notes.js`): rest 1 minute after completing a video so fresh accounts rotate in first
    accountTempCooldownUntil.set(account.id, Date.now() + DONE_REST_MS)
    adaptConcurrency('success')
    store.updateTask(task.id, {
      status: 'completed',
      localFile: result.localFile,
      videoUrl: result.videoUrl,
      videoId: result.videoId,
      conversationId: result.conversationId,
      progressText: 'Đã tải video bản gốc không logo thành công!',
      errorMessage: shortWarning,
      finishedAt: Date.now()
    })

    const libItem: VideoLibraryItem = {
      id: result.videoId || `vid-${task.id}`,
      projectId: task.projectId,
      prompt: task.prompt,
      ratio: task.ratio,
      duration: actualSec ? Math.round(actualSec) : task.duration,
      profileName: account.name,
      localFile: result.localFile,
      videoUrl: result.videoUrl,
      sizeBytes: result.sizeBytes || 0,
      model: task.model,
      createdAt: Date.now()
    }
    store.addVideo(libItem)
    return
  }

  // Resumed task couldn't reach its conversation (network/proxy): retry on the same account with the same
  // conversation — never the general failover, which would re-send (and pay for) the prompt elsewhere.
  if (result.errorCode === 'RESUME_RETRY') {
    const keepResuming = task.retryCount + 1 < RESUME_RETRY_LIMIT
    const msg = result.errorMessage || 'Chưa lấy được video ở hội thoại cũ.'
    if (!keepResuming && task.recoverOnly) {
      store.updateTask(task.id, { status: 'failed', errorCode: 'RECOVER_EMPTY', errorMessage: msg, progressText: msg })
      return
    }
    store.updateTask(task.id, {
      status: 'queued',
      resumeAfterRestart: keepResuming || undefined,
      conversationId: keepResuming ? task.conversationId : undefined,
      assignedAccountId: account.id,
      assignedAccountName: account.name,
      retryCount: task.retryCount + 1,
      errorMessage: msg,
      progressText: keepResuming
        ? `${msg} (lần ${task.retryCount + 1}/${RESUME_RETRY_LIMIT})`
        : `${msg} Đã thử ${RESUME_RETRY_LIMIT} lần — bỏ resume, sẽ gửi lại bình thường.`
    })
    return
  }

  // Dola overloaded (710022002 / PRO_BUSY): put this account on temporary cooldown, rotate its proxy,
  // and immediately failover the task to another ready account in the pool (matching HaLi AI behavior).
  if (result.errorCode === 'PRO_BUSY') {
    accountTempCooldownUntil.set(account.id, Date.now() + ACCOUNT_TEMP_COOLDOWN_MS)
    // Several nicks overloaded together = Dola itself is overloaded: pause new starts briefly instead of
    // hopping every queued task across all ready nicks back-to-back (tasks were reaching 30+ hops).
    const busyAt = Date.now()
    proBusyEvents = recordAccountEvent(proBusyEvents, account.id, busyAt)
    // 2 nicks in 10 min was true almost all the time under sustained load, so the queue sat paused with
    // 30+ ready nicks idle; only a tight cluster (3 nicks in 2 min) means Dola itself is down right now.
    const isSharedOverload = isMultiAccountBurst(
      proBusyEvents,
      busyAt,
      PRO_BUSY_BURST_WINDOW_MS,
      PRO_BUSY_BURST_ACCOUNTS
    )
    if (account.proxyId?.startsWith('rot:') && !getBusyProxyIds(account.id).has(account.proxyId)) {
      const rotId = account.proxyId.slice(4)
      await resolveRotatingProxy(rotId, true).catch(() => {})
    }
    const busyProxiesNow = getBusyProxyIds(account.id)
    const allOtherReady = store
      .getAccounts()
      .filter(
        (a) =>
          a.enabled &&
          a.id !== account.id &&
          a.status === 'ready' &&
          !busyAccountOwner.has(a.id) &&
          (!task.poolId || task.poolId === 'all' || accountPoolOf(a) === task.poolId)
      )
    const nonCooled = allOtherReady.filter((a) => !isAccountCooledDown(a.id))
    const candidateAccounts = sortAccountsByFreshness(
      nonCooled.length > 0 ? nonCooled : allOtherReady
    )
    const otherAcc =
      candidateAccounts.find(
        (a) => a.proxyId !== account.proxyId && (!a.proxyId || !busyProxiesNow.has(a.proxyId))
      ) || candidateAccounts[0]

    if (isSharedOverload && nonCooled.length === 0) {
      // Only pause the whole platform when EVERY ready account in the pool is currently cooled down
      if (busyAt >= platformBusyUntil) adaptConcurrency('overload')
      platformBusyUntil = Math.max(platformBusyUntil, busyAt + PLATFORM_BUSY_PAUSE_MS)
    }

    // Whenever there is an uncooled ready account in the pool, immediately failover to it so all threads stay active
    if (
      (!isSharedOverload || nonCooled.length > 0) &&
      otherAcc &&
      task.retryCount < Math.max(FAILOVER_RETRY_LIMIT, allOtherReady.length + 5)
    ) {
      const otherPx = ensureAccountHasLiveProxy(otherAcc.id, getBusyProxyIds(otherAcc.id))
      const hasSavedPart1 = Boolean(
        currentTask.duration > 15 && currentTask.localFile && fs.existsSync(currentTask.localFile)
      )
      store.updateTask(task.id, {
        status: 'queued',
        busyRetryAt: undefined,
        assignedAccountId: otherAcc.id,
        assignedAccountName: otherAcc.name,
        assignedProxyId: otherPx.proxyId,
        assignedProxyLabel: otherPx.proxyLabel,
        conversationId: undefined,
        retryCount: task.retryCount + 1,
        progressText: hasSavedPart1
          ? `Đã giữ Phần 1 (15s) — chuyển sang ${otherAcc.name} [${otherPx.proxyLabel}] để dựng tiếp Phần 2 (15s–30s)…`
          : `Tài khoản ${account.name} báo bận (710022002) — đang chuyển sang ${otherAcc.name} [${otherPx.proxyLabel}]…`
      })
      return
    }

    const poolHasAliveAccount = store
      .getAccounts()
      .some(
        (a) =>
          isAccountAlive(a) && (!task.poolId || task.poolId === 'all' || accountPoolOf(a) === task.poolId)
      )
    if (poolHasAliveAccount && task.retryCount < FAILOVER_RETRY_LIMIT) {
      store.updateTask(task.id, {
        status: 'queued',
        busyRetryAt: Date.now() + PRO_BUSY_RETRY_DELAY_MS,
        assignedAccountId: undefined,
        assignedAccountName: undefined,
        assignedProxyId: undefined,
        assignedProxyLabel: undefined,
        conversationId: undefined,
        retryCount: task.retryCount + 1,
        progressText: `⏳ [${account.name}] Dola quá tải tạm thời — đang chờ tài khoản rảnh trong kho để chạy lại…`
      })
      return
    }
  }

  // Handle Quota Exhausted, Auth Expired, or Proxy Error -> Switch Account/Proxy or Auto Recycle (non-FB)
  if (
    result.errorCode === 'QUOTA_EXHAUSTED' ||
    result.errorCode === 'AUTH_EXPIRED' ||
    result.errorCode === 'PROXY_ERROR'
  ) {
    if (result.errorCode === 'AUTH_EXPIRED') {
      store.updateAccount(account.id, {
        status: 'expired',
        statusMessage: result.errorMessage || 'Phiên Dola đã hết hạn — cần đăng nhập lại'
      })
    } else if (result.errorCode === 'QUOTA_EXHAUSTED') {
      store.updateAccount(account.id, {
        status: 'quota_exhausted',
        creditsLeft: 0,
        creditsLeftDate: localDayKey(),
        videosTodayDate: localDayKey(),
        statusMessage: result.errorMessage || 'Hết lượt tạo video hôm nay'
      })

      const recyclesSoFar = accountRecycleCounts.get(account.id) || 0
      if (canAutoRecycle && recyclesSoFar < MAX_RECYCLES && task.retryCount < 2) {
        accountRecycleCounts.set(account.id, recyclesSoFar + 1)
        store.updateTask(task.id, {
          status: 'preparing',
          retryCount: task.retryCount + 1,
          progressText: `Tài khoản ${account.name} chạm giới hạn ngày — đang tự động làm mới lượt (Recycle ${recyclesSoFar + 1}/${MAX_RECYCLES})…`
        })
        broadcastStateUpdate()

        const rec = await recycleAccountQuota(account.id)
        if (rec.ok) {
          // RECYCLE_COOLDOWN_MS (3 minutes) + rotate proxy
          accountTempCooldownUntil.set(account.id, Date.now() + RECYCLE_COOLDOWN_MS)
          if (account.proxyId?.startsWith('rot:') && !getBusyProxyIds(account.id).has(account.proxyId)) {
            const rotId = account.proxyId.slice(4)
            await resolveRotatingProxy(rotId, true).catch(() => {})
          }
          store.updateTask(task.id, {
            status: 'queued',
            progressText: `Đã làm mới lượt ${account.name} — đang chạy lại…`
          })
          return
        }
      }
    }

    if (result.errorCode === 'PROXY_ERROR') {
      accountTempCooldownUntil.set(account.id, Date.now() + ACCOUNT_TEMP_COOLDOWN_MS)
      if (account.proxyId?.startsWith('rot:') && !getBusyProxyIds(account.id).has(account.proxyId)) {
        const rotId = account.proxyId.slice(4)
        await resolveRotatingProxy(rotId, true).catch(() => {})
      }
      // `link_lost` / `poll_lost` protection (`src/scheduler-outcomes.js`):
      // If network/proxy dropped AFTER the prompt was already sent to Dola (`sentToDola && conversationId`),
      // DO NOT re-send on another account (which would burn another credit); resume polling on the same account!
      if (result.sentToDola && result.conversationId && task.retryCount < RESUME_RETRY_LIMIT) {
        const convTag = String(result.conversationId).slice(-6)
        store.updateTask(task.id, {
          status: 'queued',
          resumeAfterRestart: true,
          conversationId: result.conversationId,
          assignedAccountId: account.id,
          assignedAccountName: account.name,
          retryCount: task.retryCount + 1,
          errorMessage: result.errorMessage,
          progressText: `⏳ Gián đoạn mạng sau khi gửi (#${convTag}) — giữ nguyên trên ${account.name} để lấy video, không gửi lại sang nick khác (tránh tốn thêm lượt)…`
        })
        return
      }
    }

    // Only proxy errors count toward the retry limit: a dead/spent account is taken out of rotation on each hop,
    // so those hops are bounded by the pool size and must not burn the budget before a live account is reached.
    const nextRetryCount = result.errorCode === 'PROXY_ERROR' ? task.retryCount + 1 : task.retryCount

    // Check if another ready account in the pool is available (prioritizing non-cooled-down, videosToday=0, newest accounts)
    const busyProxiesNow = getBusyProxyIds(account.id)
    const allOtherReady = store
      .getAccounts()
      .filter(
        (a) =>
          a.enabled &&
          a.id !== account.id &&
          a.status === 'ready' &&
          !busyAccountOwner.has(a.id) &&
          (!task.poolId || task.poolId === 'all' || accountPoolOf(a) === task.poolId)
      )
    const nonCooled = allOtherReady.filter((a) => !isAccountCooledDown(a.id))
    const candidateAccounts = sortAccountsByFreshness(
      nonCooled.length > 0 ? nonCooled : allOtherReady
    )
    const otherAcc =
      candidateAccounts.find(
        (a) => a.proxyId !== account.proxyId && (!a.proxyId || !busyProxiesNow.has(a.proxyId))
      ) || candidateAccounts[0]

    if (otherAcc && task.retryCount < Math.max(FAILOVER_RETRY_LIMIT, allOtherReady.length + 5)) {
      const otherPx = ensureAccountHasLiveProxy(otherAcc.id, getBusyProxyIds(otherAcc.id))
      const hasSavedPart1 = Boolean(
        currentTask.duration > 15 && currentTask.localFile && fs.existsSync(currentTask.localFile)
      )
      store.updateTask(task.id, {
        status: 'queued',
        assignedAccountId: otherAcc.id,
        assignedAccountName: otherAcc.name,
        assignedProxyId: otherPx.proxyId,
        assignedProxyLabel: otherPx.proxyLabel,
        conversationId: undefined,
        retryCount: nextRetryCount,
        progressText: hasSavedPart1
          ? `Đã giữ Phần 1 (15s) — chuyển sang ${otherAcc.name} [${otherPx.proxyLabel}] để dựng tiếp Phần 2 (15s–30s)…`
          : `Chuyển từ ${account.name} sang tài khoản ${otherAcc.name} [${otherPx.proxyLabel}]…`
      })
      return
    }

    // Every other account is busy right now: wait in the queue for one to free up instead of failing,
    // as long as some account in the pool (this one after cooldown included) can still run it.
    const poolHasAliveAccount = store
      .getAccounts()
      .some(
        (a) =>
          isAccountAlive(a) && (!task.poolId || task.poolId === 'all' || accountPoolOf(a) === task.poolId)
      )
    if (poolHasAliveAccount && task.retryCount < FAILOVER_RETRY_LIMIT) {
      const msg = result.errorMessage || 'Lỗi tài khoản/Proxy'
      store.updateTask(task.id, {
        status: 'queued',
        assignedAccountId: undefined,
        assignedAccountName: undefined,
        assignedProxyId: undefined,
        assignedProxyLabel: undefined,
        conversationId: undefined,
        retryCount: nextRetryCount,
        errorMessage: msg,
        progressText: `⚠️ [${account.name}] ${msg} — đang chờ tài khoản khác rảnh để chạy lại…`
      })
      return
    }
  }

  // `CONTENT_REFUSED` (`safety_terminated:completion` / content filter in `src/dola-failures.js`):
  // Rest current account for 1 minute (`ACCOUNT_TEMP_COOLDOWN_MS`) and push the task to another account
  // up to `MAX_REFUSED_RETRIES = 2` times before marking it `failed`.
  if (result.errorCode === 'CONTENT_REFUSED') {
    accountTempCooldownUntil.set(account.id, Date.now() + ACCOUNT_TEMP_COOLDOWN_MS)
    if (task.retryCount < MAX_REFUSED_RETRIES) {
      const busyProxiesNow = getBusyProxyIds(account.id)
      const allOtherReady = store
        .getAccounts()
        .filter(
          (a) =>
            a.enabled &&
            a.id !== account.id &&
            a.status === 'ready' &&
            !busyAccountOwner.has(a.id) &&
            (!task.poolId || task.poolId === 'all' || accountPoolOf(a) === task.poolId)
        )
      const nonCooled = allOtherReady.filter((a) => !isAccountCooledDown(a.id))
      const freshCandidates = sortAccountsByFreshness(
        nonCooled.length > 0 ? nonCooled : allOtherReady
      )
      const otherReadyAcc =
        freshCandidates.find(
          (a) => a.proxyId !== account.proxyId && (!a.proxyId || !busyProxiesNow.has(a.proxyId))
        ) || freshCandidates[0]

      if (otherReadyAcc) {
        const otherPx = ensureAccountHasLiveProxy(otherReadyAcc.id, getBusyProxyIds(otherReadyAcc.id))
        store.updateTask(task.id, {
          status: 'queued',
          assignedAccountId: otherReadyAcc.id,
          assignedAccountName: otherReadyAcc.name,
          assignedProxyId: otherPx.proxyId,
          assignedProxyLabel: otherPx.proxyLabel,
          conversationId: undefined,
          retryCount: task.retryCount + 1,
          errorMessage: result.errorMessage,
          progressText: `⚠️ [${account.name}] Bị bộ lọc từ chối — đang thử sang tài khoản ${otherReadyAcc.name} (lần ${task.retryCount + 1}/${MAX_REFUSED_RETRIES})…`
        })
        return
      }
    }
  }

  // Poll timeout on a render Dola already accepted (and charged): keep watching the same conversation on the
  // same nick via the resume path instead of re-sending the prompt elsewhere and paying a second credit.
  if (shouldWaitLongerAfterTimeout({ ...result, retryCount: task.retryCount })) {
    // the resume itself ignores cooldown (only this nick can collect it); the penalty keeps NEW work off it
    penalizeAccount(account.id)
    const convTag = String(result.conversationId).slice(-6)
    store.updateTask(task.id, {
      status: 'queued',
      resumeAfterRestart: true,
      conversationId: result.conversationId,
      assignedAccountId: account.id,
      assignedAccountName: account.name,
      busyRetryAt: undefined,
      retryCount: task.retryCount + 1,
      errorMessage: result.errorMessage,
      progressText: `⏳ Dola dựng lâu hơn dự kiến — tiếp tục chờ video ở hội thoại #${convTag} trên ${account.name}, không gửi lại lệnh (không tốn thêm lượt)…`
    })
    return
  }

  // Auto-failover to ANOTHER ready account on GENERAL_ERROR (up to 10 accounts when !result.sentToDola)
  if (result.errorCode === 'GENERAL_ERROR') {
    penalizeAccount(account.id)
    store.updateAccount(account.id, {
      statusMessage: `⚠️ ${result.errorMessage || 'Dola báo lỗi khi tạo video.'}`
    })

    const maxGeneralFailovers = result.sentToDola ? 1 : 10
    if (task.retryCount < maxGeneralFailovers) {
      const busyProxiesNow = getBusyProxyIds(account.id)
      const allOtherReady = store
        .getAccounts()
        .filter(
          (a) =>
            a.enabled &&
            a.id !== account.id &&
            a.status === 'ready' &&
            !busyAccountOwner.has(a.id) &&
            (!task.poolId || task.poolId === 'all' || accountPoolOf(a) === task.poolId)
        )
      const nonCooled = allOtherReady.filter((a) => !isAccountCooledDown(a.id))
      const freshCandidates = sortAccountsByFreshness(
        nonCooled.length > 0 ? nonCooled : allOtherReady
      )
      const otherReadyAcc =
        freshCandidates.find(
          (a) => a.proxyId !== account.proxyId && (!a.proxyId || !busyProxiesNow.has(a.proxyId))
        ) || freshCandidates[0]

      if (otherReadyAcc) {
        const otherPx = ensureAccountHasLiveProxy(otherReadyAcc.id, getBusyProxyIds(otherReadyAcc.id))
        const msg = `⚠️ [${account.name}] ${result.errorMessage || 'Dola báo lỗi'} — Đang tự chuyển sang tài khoản ${otherReadyAcc.name} [${otherPx.proxyLabel}]…`
        store.updateTask(task.id, {
          status: 'queued',
          assignedAccountId: otherReadyAcc.id,
          assignedAccountName: otherReadyAcc.name,
          assignedProxyId: otherPx.proxyId,
          assignedProxyLabel: otherPx.proxyLabel,
          conversationId: undefined,
          retryCount: task.retryCount + 1,
          errorMessage: result.errorMessage,
          progressText: msg
        })
        return
      }
    }
  }

  const failMessage =
    result.errorCode === 'PRO_BUSY'
      ? `${result.errorMessage} Đã tự chạy lại 1 lần mà Dola vẫn quá tải — thử lại sau.`
      : result.errorMessage || 'Tạo video thất bại.'
  store.updateTask(task.id, {
    status: 'failed',
    errorCode: result.errorCode || 'GENERAL_ERROR',
    errorMessage: failMessage,
    progressText: failMessage
  })
}

export function retryTask(taskId: string): void {
  const t = store.getTasks().find((x) => x.id === taskId)
  if (!t) return
  requeueTaskForRetry(t)
  queuePaused = false
  broadcastStateUpdate()
  triggerQueueScheduler()
}

/** Re-queue one failed/cancelled task: reset it to 'queued', clearing account assignment so a fresh account is picked. */
function requeueTaskForRetry(t: VideoTask): void {
  accountTempCooldownUntil.clear()
  store.updateTask(t.id, {
    status: 'queued',
    model: t.duration > 15 ? 'seedance_v2.5' : t.model,
    assignedAccountId: undefined,
    assignedAccountName: undefined,
    assignedProxyId: undefined,
    assignedProxyLabel: undefined,
    retryCount: 0,
    busyRetryAt: undefined,
    resumeAfterRestart: undefined,
    recoverOnly: undefined,
    errorCode: undefined,
    errorMessage: undefined,
    progressText: 'Đã gắn Proxy xoay & xếp hàng chạy lại…'
  })
}

export function retryAllFailedTasks(): number {
  const failed = store.getTasks().filter((t) => t.status === 'failed' || t.status === 'cancelled')
  failed.forEach(requeueTaskForRetry)
  queuePaused = false
  broadcastStateUpdate()
  triggerQueueScheduler()
  return failed.length
}

/** Re-queue a chosen set of failed/cancelled tasks (bulk "retry selected"). */
export function retryTasks(ids: string[]): number {
  const idSet = new Set(ids)
  const toRetry = store
    .getTasks()
    .filter((t) => idSet.has(t.id) && (t.status === 'failed' || t.status === 'cancelled'))
  toRetry.forEach(requeueTaskForRetry)
  if (toRetry.length > 0) {
    queuePaused = false
    broadcastStateUpdate()
    triggerQueueScheduler()
  }
  return toRetry.length
}

/**
 * "Lấy lại video": collect a render already in this task's Dola conversation, on the same account, without
 * ever sending a new (paid) prompt. Fails fast when there is nothing to collect from.
 */
export function recoverTaskVideo(taskId: string): { ok: boolean; message: string } {
  const t = store.getTasks().find((x) => x.id === taskId)
  if (!t || (t.status !== 'failed' && t.status !== 'cancelled')) {
    return { ok: false, message: 'Chỉ lấy lại được video cho task đã lỗi.' }
  }
  if (!t.conversationId || !t.assignedAccountId) {
    return { ok: false, message: 'Task này chưa gửi tới Dola nên không có video để lấy lại.' }
  }
  if (!isAccountAlive(store.getAccountById(t.assignedAccountId))) {
    return { ok: false, message: `Nick ${t.assignedAccountName || ''} không còn dùng được — không lấy lại được.` }
  }
  store.updateTask(t.id, {
    status: 'queued',
    resumeAfterRestart: true,
    recoverOnly: true,
    retryCount: 0,
    busyRetryAt: undefined,
    errorCode: undefined,
    errorMessage: undefined,
    progressText: `Đang lấy lại video ở hội thoại #${t.conversationId.slice(-6)} — không gửi lại lệnh…`
  })
  queuePaused = false
  broadcastStateUpdate()
  triggerQueueScheduler()
  return { ok: true, message: 'Đã xếp hàng lấy lại video.' }
}

/** "Sửa prompt rồi chạy lại": replace the prompt of a failed task and send it fresh (new conversation). */
export function editPromptAndRetry(taskId: string, prompt: string): { ok: boolean; message: string } {
  const t = store.getTasks().find((x) => x.id === taskId)
  const clean = unwrapPromptWrapper(prompt.trim())
  if (!t) return { ok: false, message: 'Không tìm thấy task.' }
  if (!clean) return { ok: false, message: 'Prompt không được để trống.' }
  store.updateTask(t.id, { prompt: clean, expandedPrompt: undefined, conversationId: undefined })
  retryTask(t.id)
  return { ok: true, message: 'Đã lưu prompt mới và xếp hàng chạy lại.' }
}

/** Delete a chosen set of tasks (bulk "delete selected"), freeing the slot+account of any that run. */
export function deleteTasks(ids: string[]): number {
  for (const id of ids) {
    if (!runningTaskIds.has(id)) continue
    // Same release as cancelTask: free the slot/account now; the engine zombie self-terminates and
    // its result is discarded because the task no longer exists.
    const t = store.getTasks().find((x) => x.id === id)
    runningTaskIds.delete(id)
    if (t?.assignedAccountId && busyAccountOwner.get(t.assignedAccountId) === id) {
      busyAccountOwner.delete(t.assignedAccountId)
    }
  }
  const before = store.getTasks().length
  store.deleteTasks(ids)
  const removed = before - store.getTasks().length
  if (removed > 0) {
    broadcastStateUpdate()
    triggerQueueScheduler()
  }
  return removed
}

export function cancelTask(taskId: string): void {
  const t = store.getTasks().find((x) => x.id === taskId)
  const wasRunning = runningTaskIds.has(taskId)

  store.updateTask(taskId, {
    status: 'cancelled',
    progressText: 'Đã huỷ theo yêu cầu.'
  })

  // Cancelling a running task doesn't stop its engine work (the hidden window keeps polling Dola up
  // to the poll timeout), but its result is discarded. Free its slot + account NOW so lô-bound tasks
  // aren't held hostage by the zombie. ponytail: the zombie and the next job briefly share the
  // account's Dola session; it self-heals when the zombie hits its deadline. The owner-check in the
  // scheduler's .finally() stops the late release from double-booking the account.
  if (wasRunning) {
    runningTaskIds.delete(taskId)
    if (t?.assignedAccountId && busyAccountOwner.get(t.assignedAccountId) === taskId) {
      busyAccountOwner.delete(t.assignedAccountId)
    }
  }

  broadcastStateUpdate()
  triggerQueueScheduler()
}

export function setQueuePaused(paused: boolean): void {
  queuePaused = paused
  broadcastStateUpdate()
  if (!paused) {
    triggerQueueScheduler()
  }
}

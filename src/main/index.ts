import { app, BrowserWindow, dialog, ipcMain, protocol, shell } from 'electron'
import * as path from 'path'
import * as fs from 'fs'
import * as crypto from 'crypto'
import { store } from './store'
import {
  KNOWN_EXPIRED_ROTATING_KEYS,
  autoPairProxiesToAccounts,
  checkSingleProxy,
  createRotatingProxiesBatch,
  createStaticProxiesFromText,
  normalizeRotatingKeyInput,
  parseProxyString,
  registerProxyAuthHandler,
  resolveRotatingProxy,
  seedUserDefaultRotatingProxies,
  syncTopProxyAccount
} from './proxy-manager'
import {
  checkAccountHealth,
  extractLastFrame,
  injectCookiesToPartition,
  injectFacebookCookiesToPartition,
  loginWithFacebookAccount,
  loginWithGoogleCredentials,
  openAccountBrowser,
  parseAndValidateCookies,
  parseFacebookBatchInput,
  pullVideosFromAccount,
  recycleAccountQuota,
  upgradeWatermarkedVideosFromDola
} from './dola-engine'
import {
  broadcastStateUpdate,
  cancelTask,
  deleteTasks,
  recoverStalledTasksOnStartup,
  retryAllFailedTasks,
  retryTask,
  retryTasks,
  recoverTaskVideo,
  editPromptAndRetry,
  setQueuePaused,
  submitBatchTasks,
  triggerQueueScheduler
} from './queue-worker'
import {
  AccountPoolEntry,
  AccountProfile,
  AppSettings,
  CharacterEntry,
  ProjectEntry,
  QueueSubmitPayload,
  RotatingProxyEntry
} from '../shared/types'
import {
  DEFAULT_SEEDANCE_ACCOUNTS_DATA,
  SeedanceAccountsExportPayload,
  SeedanceExportAccount
} from './seed-accounts-data'
import { toRendererAccounts } from './renderer-state'

// Optimize Chromium background worker windows and prevent automation throttling
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch(
  'disable-features',
  'CalculateNativeWinOcclusion,Translate,MediaRouter'
)

// Register custom protocol privileges before app ready
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'viraai-media',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: true
    }
  }
])

let mainWindow: BrowserWindow | null = null

const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.exit(0)
} else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    } else if (app.isReady()) {
      createMainWindow()
    }
  })
}

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1120,
    minHeight: 720,
    title: 'ViraAI Seedance 2.5 Studio — Tạo Video AI Hàng Loạt (Cross-Platform)',
    backgroundColor: '#08120c',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
    store.flushSync()
    app.exit(0)
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

function registerCustomMediaProtocol(): void {
  protocol.registerFileProtocol('viraai-media', (request, callback) => {
    try {
      const rawUrl = request.url.replace(/^viraai-media:\/\/(local\/)?/i, '').replace(/[?#].*$/, '')
      const decodedPath = decodeURIComponent(rawUrl)
      const normalizedPath =
        process.platform === 'win32' && decodedPath.startsWith('/')
          ? decodedPath.slice(1)
          : decodedPath
      callback({ path: normalizedPath })
    } catch (err) {
      console.error('[viraai-media] Failed to serve local file:', err)
      callback({ error: -6 }) // net::ERR_FILE_NOT_FOUND
    }
  })
}

function normalizeExportAccountItem(rawItem: any, fallbackName?: string): SeedanceExportAccount | null {
  if (!rawItem || typeof rawItem !== 'object') return null
  const rawCookies = rawItem.cookies ?? rawItem.cookie ?? rawItem
  const parsed = parseAndValidateCookies(
    typeof rawCookies === 'string' ? rawCookies : JSON.stringify(rawCookies)
  )
  if (parsed.cookies.length === 0 && !rawItem.fb_uid && !rawItem.fbCookie) {
    return null
  }
  const cookieMap: Record<string, string> = {}
  for (const c of parsed.cookies) {
    if (c.name && c.value) cookieMap[c.name] = c.value
  }
  return {
    id: rawItem.id ? String(rawItem.id).trim() : undefined,
    name: String(rawItem.name || rawItem.ten || fallbackName || '').trim() || undefined,
    nguon: rawItem.nguon || (rawItem.fb_uid ? 'facebook' : 'dola'),
    fb_uid: rawItem.fb_uid || rawItem.fbUid,
    dola_uid: rawItem.dola_uid || rawItem.dolaUid || rawItem.userId,
    kho: rawItem.kho || rawItem.poolId || (rawItem.group && rawItem.group !== 'default' ? rawItem.group : undefined),
    proxy: rawItem.proxy || rawItem.proxy_id || rawItem.proxyId || '',
    enabled: rawItem.enabled !== undefined ? Boolean(rawItem.enabled) : rawItem.scheduling !== false,
    created_at: Number(rawItem.created_at) || Date.now(),
    dung_xong: Boolean(rawItem.dung_xong || rawItem.status === 'locked' || rawItem.status === 'quota_exhausted'),
    cookies: cookieMap
  }
}

function tryParseSeedanceAccountsBundle(raw: string, fallbackName?: string): SeedanceAccountsExportPayload | null {
  const trimmed = (raw || '')
    .replace(/^\uFEFF/, '')
    .replace(/^```(?:json|text|txt)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null

  const extractPayload = (parsed: any): SeedanceAccountsExportPayload | null => {
    if (Array.isArray(parsed)) {
      if (parsed.length === 0) return null
      // Case A: Array of Cookie-Editor cookie objects [{ name: "sessionid", value: "..." }, ...]
      const isCookieObjectArray = parsed.some(
        (x) => x && typeof x === 'object' && typeof (x.name ?? x.key) === 'string' && (x.value ?? x.val) !== undefined && !x.cookies
      )
      if (isCookieObjectArray) {
        const single = normalizeExportAccountItem({ name: fallbackName, cookies: parsed }, fallbackName)
        return single ? { loai: 'seedance-accounts', tai_khoan: [single] } : null
      }
      // Case B: Array of Profile / Account objects [{ id, name, cookies: [...] }, ...]
      const accounts: SeedanceExportAccount[] = []
      for (let i = 0; i < parsed.length; i++) {
        const norm = normalizeExportAccountItem(parsed[i], fallbackName ? `${fallbackName} #${i + 1}` : undefined)
        if (norm) accounts.push(norm)
      }
      return accounts.length > 0 ? { loai: 'seedance-accounts', tai_khoan: accounts } : null
    }

    if (parsed && typeof parsed === 'object') {
      if (parsed.loai === 'seedance-accounts' || Array.isArray(parsed.tai_khoan)) {
        const rawList = Array.isArray(parsed.tai_khoan) ? parsed.tai_khoan : []
        const normalizedList: SeedanceExportAccount[] = []
        for (const item of rawList) {
          const norm = normalizeExportAccountItem(item)
          if (norm) normalizedList.push(norm)
        }
        return {
          ...parsed,
          loai: 'seedance-accounts',
          tai_khoan: normalizedList.length > 0 ? normalizedList : rawList
        }
      }
      const listCandidate = parsed.accounts || parsed.profiles || parsed.data
      if (Array.isArray(listCandidate)) {
        const accounts: SeedanceExportAccount[] = []
        for (let i = 0; i < listCandidate.length; i++) {
          const norm = normalizeExportAccountItem(listCandidate[i], fallbackName ? `${fallbackName} #${i + 1}` : undefined)
          if (norm) accounts.push(norm)
        }
        if (accounts.length > 0) {
          return { loai: 'seedance-accounts', tai_khoan: accounts }
        }
      }
      // Case C: Single Seedance Unlimited Profile object { id, name, cookies: [...] } or { cookies: {...} }
      if (parsed.cookies !== undefined || parsed.cookie !== undefined) {
        const single = normalizeExportAccountItem(
          { ...parsed, name: fallbackName || parsed.name },
          fallbackName
        )
        if (single) {
          return { loai: 'seedance-accounts', tai_khoan: [single] }
        }
      }
    }
    return null
  }

  for (const cand of [trimmed, trimmed.replace(/,\s*([}\]])/g, '$1')]) {
    try {
      const res = extractPayload(JSON.parse(cand))
      if (res) return res
    } catch {}
  }

  // Fallback recovery for large JSON cut off mid-stream when pasted
  if (trimmed.includes('"tai_khoan"') || trimmed.includes('"seedance-accounts"')) {
    const lastCompleteAccountEnd = trimmed.lastIndexOf('"dung_xong_ip"')
    if (lastCompleteAccountEnd !== -1) {
      const closingBrace = trimmed.indexOf('}', lastCompleteAccountEnd)
      if (closingBrace !== -1) {
        try {
          const repaired = `${trimmed.slice(0, closingBrace + 1)}\n  ]\n}`
          return extractPayload(JSON.parse(repaired))
        } catch {}
      }
    }
  }
  return null
}

async function importSeedanceAccountsBundle(
  bundle: SeedanceAccountsExportPayload,
  options?: {
    fallbackPoolId?: string
    fallbackProxyId?: string
    verifyInBackground?: boolean
    preserveRuntimeStatus?: boolean
  }
): Promise<{ addedCount: number; updatedCount: number; accounts: AccountProfile[] }> {
  // 1. Import Kho (Account Pools)
  if (Array.isArray(bundle.kho)) {
    for (const k of bundle.kho) {
      if (!k || !k.id) continue
      store.saveAccountPool({
        id: String(k.id).trim(),
        name: String(k.ten || 'Kho nhập').trim(),
        createdAt: Number(k.tao_luc) || Date.now(),
        updatedAt: Date.now()
      })
    }
  }

  const rawItems = Array.isArray(bundle.tai_khoan) ? bundle.tai_khoan : []
  // Deduplicate by dola_uid / fb_uid / id keeping the newest created_at
  const byUniqueKey = new Map<string, SeedanceExportAccount>()
  for (let i = 0; i < rawItems.length; i++) {
    const t = rawItems[i]
    if (!t || typeof t !== 'object') continue
    const key = String(t.dola_uid || t.fb_uid || t.id || `idx-${i}`).trim()
    const prev = byUniqueKey.get(key)
    if (!prev || (Number(t.created_at) || 0) >= (Number(prev.created_at) || 0)) {
      byUniqueKey.set(key, t)
    }
  }
  const items = Array.from(byUniqueKey.values())

  const importedAccounts: AccountProfile[] = []
  const newRotProxyIds: string[] = []
  let addedCount = 0
  let updatedCount = 0
  let rotRoundRobinIdx = 0

  for (const item of items) {
    if (!item) continue
    let cookieHeaderStr = ''
    if (typeof item.cookies === 'string') {
      const parsed = parseAndValidateCookies(item.cookies)
      cookieHeaderStr =
        parsed.cookies.length > 0
          ? parsed.cookies.map((c) => `${c.name}=${c.value}`).join('; ')
          : item.cookies.trim()
    } else if (Array.isArray(item.cookies)) {
      const parsed = parseAndValidateCookies(JSON.stringify(item.cookies))
      cookieHeaderStr = parsed.cookies.map((c) => `${c.name}=${c.value}`).join('; ')
    } else if (item.cookies && typeof item.cookies === 'object') {
      cookieHeaderStr = Object.entries(item.cookies)
        .filter(
          ([k, v]) =>
            k &&
            v !== undefined &&
            v !== null &&
            typeof v !== 'object' &&
            String(v).trim() !== '' &&
            String(v).trim() !== '[object Object]'
        )
        .map(([k, v]) => `${k.trim()}=${String(v).trim()}`)
        .join('; ')
    }
    if (!cookieHeaderStr) continue

    // Resolve proxy ("proxyvn:KEY" or static host:port:user:pass)
    let resolvedProxyId = options?.fallbackProxyId
    const rawPx = (item.proxy || '').trim()
    if (rawPx) {
      const norm = normalizeRotatingKeyInput(rawPx, 'topproxy', 'Random', '0')
      if (norm.isRotatingKeyFormat && norm.apiKey) {
        if (!KNOWN_EXPIRED_ROTATING_KEYS.has(norm.apiKey)) {
          const existingRot = store
            .getRotatingProxies()
            .find((r) => r.apiKey === norm.apiKey)
          if (existingRot) {
            if (existingRot.status !== 'expired') {
              resolvedProxyId = `rot:${existingRot.id}`
            }
          } else {
            const rotId = `rot-${crypto.randomUUID().slice(0, 8)}`
            const rotEntry: RotatingProxyEntry = {
              id: rotId,
              name: `TopProxy #${store.getRotatingProxies().length + 1}`,
              provider: norm.provider,
              apiKey: norm.apiKey,
              nhamang: norm.provider === 'topproxy' ? norm.nhamang : undefined,
              tinhthanh: norm.provider === 'topproxy' ? norm.tinhthanh : undefined,
              protocol: 'http',
              status: 'unknown'
            }
            store.upsertRotatingProxy(rotEntry)
            newRotProxyIds.push(rotId)
            resolvedProxyId = `rot:${rotId}`
          }
        }
      } else {
        const parsedPx = parseProxyString(rawPx, 'http')
        if (parsedPx) {
          const existingPx = store
            .getProxies()
            .find(
              (p) =>
                p.host === parsedPx.host &&
                p.port === parsedPx.port &&
                p.username === parsedPx.username
            )
          if (existingPx) {
            resolvedProxyId = existingPx.id
          } else {
            const pxId = `px-${crypto.randomUUID().slice(0, 8)}`
            store.upsertProxy({
              id: pxId,
              ...parsedPx,
              status: 'unknown'
            })
            resolvedProxyId = pxId
          }
        }
      }
    }

    // Auto-assign a live rotating proxy round-robin if the account had "proxy": "" or an expired key
    if (!resolvedProxyId) {
      const allRot = store.getRotatingProxies()
      const liveRot = allRot.filter((r) => r.status !== 'expired')
      const availableRot = liveRot.length > 0 ? liveRot : allRot
      if (availableRot.length > 0) {
        const chosenRot = availableRot[rotRoundRobinIdx % availableRot.length]
        rotRoundRobinIdx++
        resolvedProxyId = `rot:${chosenRot.id}`
      }
    }

    const fbUid = item.fb_uid ? String(item.fb_uid).trim() : undefined
    const targetPoolId =
      (item.kho ? String(item.kho).trim() : '') || options?.fallbackPoolId || undefined

    const existing = store
      .getAccounts()
      .find(
        (a) =>
          (item.id && a.id === item.id) ||
          (fbUid && a.fbUid === fbUid)
      )

    if (existing) {
      if (options?.preserveRuntimeStatus) {
        if (!existing.proxyId && resolvedProxyId) {
          store.updateAccount(existing.id, { proxyId: resolvedProxyId })
        }
        const latestExisting = store.getAccountById(existing.id) || existing
        if (latestExisting.cookieHeader) {
          await injectCookiesToPartition(latestExisting.partition, latestExisting.cookieHeader, false)
        }
        importedAccounts.push(latestExisting)
        continue
      }
      const updated = store.updateAccount(existing.id, {
        name: item.name ? String(item.name).trim() : existing.name,
        poolId: targetPoolId || existing.poolId,
        fbUid: fbUid || existing.fbUid,
        cookieHeader: cookieHeaderStr || existing.cookieHeader,
        proxyId: resolvedProxyId || existing.proxyId,
        enabled: item.enabled !== undefined ? Boolean(item.enabled) : existing.enabled,
        status: item.dung_xong ? 'quota_exhausted' : 'ready',
        statusMessage: 'Đã nạp phiên Dola & gắn Proxy xoay — sẵn sàng tạo video'
      })
      const targetAcc = updated || existing
      if (cookieHeaderStr) {
        await injectCookiesToPartition(targetAcc.partition, cookieHeaderStr, true)
      }
      importedAccounts.push(targetAcc)
      updatedCount++
    } else {
      const id = item.id ? String(item.id).trim() : `acc-${crypto.randomUUID().slice(0, 8)}`
      const partition = `persist:dola-${id}`
      const acc: AccountProfile = {
        id,
        name: item.name ? String(item.name).trim() : `Clone ${fbUid || id.slice(0, 6)}`,
        poolId: targetPoolId,
        fbUid,
        sourceType: item.nguon === 'facebook' ? 'facebook' : 'cookie',
        cookieHeader: cookieHeaderStr,
        partition,
        enabled: item.enabled !== false,
        proxyId: resolvedProxyId,
        status: item.dung_xong ? 'quota_exhausted' : 'ready',
        statusMessage: 'Đã nạp phiên Dola & gắn Proxy xoay — sẵn sàng tạo video',
        videosToday: 0,
        totalVideos: 0,
        createdAt: Number(item.created_at) || Date.now()
      }
      store.upsertAccount(acc)
      await injectCookiesToPartition(partition, cookieHeaderStr, true)
      importedAccounts.push(acc)
      addedCount++
    }
  }

  store.flushSync()
  broadcastStateUpdate()

  if (newRotProxyIds.length > 0) {
    void (async () => {
      for (const rotId of newRotProxyIds) {
        await resolveRotatingProxy(rotId, false)
        broadcastStateUpdate()
      }
    })()
  }

  if (options?.verifyInBackground && importedAccounts.length > 0) {
    // Verify every imported account, not just a few: imported sessions are often already revoked, and an
    // unverified "ready" account only fails once a task is sent to it. Not runnable until checked.
    const toVerify = importedAccounts.filter((a) => store.getAccountById(a.id)?.status === 'ready')
    for (const acc of toVerify) {
      store.updateAccount(acc.id, { status: 'checking', statusMessage: 'Chờ kiểm tra phiên Dola sau khi nạp…' })
    }
    broadcastStateUpdate()
    void runPoolWithConcurrency(toVerify, resolveLoginConcurrency(), async (acc) => {
      await checkAccountHealth(acc.id).catch(() => {})
      broadcastStateUpdate()
      triggerQueueScheduler()
    })
  }

  return { addedCount, updatedCount, accounts: importedAccounts }
}

function resolveLoginConcurrency(requested?: number): number {
  const raw = Number(requested || store.getSettings().loginConcurrency || 3)
  return Math.min(5, Math.max(1, Number.isFinite(raw) ? Math.round(raw) : 3))
}

async function runPoolWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>
): Promise<void> {
  let cursor = 0
  const threadCount = Math.min(items.length, Math.max(1, concurrency))
  const runners = Array.from({ length: threadCount }, async () => {
    while (cursor < items.length) {
      const idx = cursor++
      const item = items[idx]
      try {
        await worker(item, idx)
      } catch {}
    }
  })
  await Promise.all(runners)
}

function registerIpcHandlers(): void {
  // 1. Full State Snapshot
  ipcMain.handle('state:get', () => {
    return {
      settings: store.getSettings(),
      projects: store.getProjects(),
      accountPools: store.getAccountPools(),
      accounts: toRendererAccounts(store.getAccounts()),
      proxies: store.getProxies(),
      rotatingProxies: store.getRotatingProxies(),
      characters: store.getCharacters(),
      tasks: store.getTasks(),
      videos: store.getVideos()
    }
  })

  // 2. Settings & Native Dialogs
  ipcMain.handle('settings:update', (_ev, patch: Partial<AppSettings>) => {
    const updated = store.updateSettings(patch)
    broadcastStateUpdate()
    triggerQueueScheduler()
    return updated
  })

  ipcMain.handle('dialog:select-folder', async () => {
    const res = await dialog.showOpenDialog({
      title: 'Chọn thư mục lưu video đầu ra',
      properties: ['openDirectory', 'createDirectory']
    })
    if (res.canceled || !res.filePaths[0]) return null
    return res.filePaths[0]
  })

  ipcMain.handle('dialog:select-images', async (_ev, multi = true) => {
    const res = await dialog.showOpenDialog({
      title: 'Chọn ảnh tham chiếu (JPG / PNG / WEBP)',
      properties: multi ? ['openFile', 'multiSelections'] : ['openFile'],
      filters: [
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'jfif', 'heic'] }
      ]
    })
    if (res.canceled) return []
    return res.filePaths
  })

  ipcMain.handle('dialog:select-text-file', async () => {
    const res = await dialog.showOpenDialog({
      title: 'Nhập danh sách câu lệnh từ tệp .txt / .csv',
      properties: ['openFile'],
      filters: [{ name: 'Text / CSV', extensions: ['txt', 'csv', 'md'] }]
    })
    if (res.canceled || !res.filePaths[0]) return null
    const content = fs.readFileSync(res.filePaths[0], 'utf-8')
    return {
      filePath: res.filePaths[0],
      content
    }
  })

  ipcMain.handle('shell:open-path', async (_ev, targetPath: string) => {
    if (!targetPath) return
    await shell.openPath(targetPath)
  })

  ipcMain.handle('shell:show-item', (_ev, targetPath: string) => {
    if (!targetPath || !fs.existsSync(targetPath)) return
    shell.showItemInFolder(targetPath)
  })

  // 3. Projects (Kho Video)
  ipcMain.handle('projects:save', (_ev, project: ProjectEntry) => {
    const list = store.saveProject(project)
    broadcastStateUpdate()
    return list
  })

  ipcMain.handle('projects:delete', (_ev, id: string) => {
    const list = store.deleteProject(id)
    broadcastStateUpdate()
    return list
  })

  // 3.5 Account Pools (Kho Tài Khoản)
  ipcMain.handle('account-pools:save', (_ev, pool: AccountPoolEntry) => {
    const list = store.saveAccountPool(pool)
    broadcastStateUpdate()
    return list
  })

  ipcMain.handle('account-pools:delete', (_ev, id: string) => {
    const list = store.deleteAccountPool(id)
    broadcastStateUpdate()
    triggerQueueScheduler()
    return list
  })

  ipcMain.handle(
    'account-pools:assign',
    (_ev, payload: { accountIds: string[]; poolId: string }) => {
      const list = store.assignAccountsToPool(payload.accountIds, payload.poolId)
      broadcastStateUpdate()
      triggerQueueScheduler()
      return list
    }
  )

  ipcMain.handle(
    'account-pools:auto-split',
    (_ev, payload: { poolSize: number; prefix?: string; accountIds?: string[] }) => {
      const res = store.autoSplitAccountsIntoPools(
        payload.poolSize,
        payload.prefix,
        payload.accountIds
      )
      broadcastStateUpdate()
      triggerQueueScheduler()
      return res
    }
  )

  // 4. Accounts Management
  ipcMain.handle(
    'accounts:add-cookie',
    async (_ev, payload: { name: string; cookie: string; proxyId?: string; poolId?: string }) => {
      const rawCookieText = (payload.cookie || '').trim()
      if (!rawCookieText) {
        return {
          ok: false,
          account: undefined,
          warning: 'Chuỗi cookie trống.',
          message: 'Vui lòng dán Cookie hoặc JSON tài khoản.'
        }
      }

      // 1. Check if JSON bundle / Seedance Unlimited profile / Cookie-Editor JSON
      const bundle = tryParseSeedanceAccountsBundle(rawCookieText, payload.name.trim() || undefined)
      if (bundle) {
        const isSingleAcc = (bundle.tai_khoan?.length || 0) === 1
        const res = await importSeedanceAccountsBundle(bundle, {
          fallbackPoolId: payload.poolId,
          fallbackProxyId: payload.proxyId,
          verifyInBackground: !isSingleAcc
        })
        if (isSingleAcc && res.accounts[0]) {
          const checked = await checkAccountHealth(res.accounts[0].id)
          broadcastStateUpdate()
          triggerQueueScheduler()
          return {
            ok: true,
            account: checked || res.accounts[0],
            warning: undefined,
            message: `Đã thêm và kiểm tra tài khoản ${(checked || res.accounts[0]).name} thành công!`
          }
        }
        triggerQueueScheduler()
        return {
          ok: true,
          account: res.accounts[0],
          warning: undefined,
          message: `Đã nhập thành công ${res.addedCount} tài khoản mới (cập nhật ${res.updatedCount} tài khoản) từ JSON!`
        }
      }

      // 2. Auto-detect if user pasted Facebook Cookie(s) / Via (c_user=...; xs=...) into the Cookie tab
      const hasDolaCoreInRaw = /(^|;|\s|"|\b)(sessionid|sid_guard|sid_tt)\s*[:=]/i.test(rawCookieText)
      const hasFbCoreInRaw = /(^|;|\s|"|\b)c_user\s*[:=]/i.test(rawCookieText) && /(^|;|\s|"|\b)xs\s*[:=]/i.test(rawCookieText)
      if (!hasDolaCoreInRaw && hasFbCoreInRaw) {
        const fbList = parseFacebookBatchInput(rawCookieText)
        if (fbList.length > 0) {
          const addedIds: string[] = []
          for (let i = 0; i < fbList.length; i++) {
            const item = fbList[i]
            const existing = store.getAccounts().find((a) => a.fbUid && a.fbUid === item.fbUid)
            if (existing) {
              store.updateAccount(existing.id, {
                name: (fbList.length === 1 && payload.name.trim()) || existing.name,
                fbCookie: item.fbCookie || existing.fbCookie,
                fbToken: item.fbToken || existing.fbToken,
                email: item.email || existing.email,
                proxyId: payload.proxyId || existing.proxyId,
                poolId: payload.poolId || existing.poolId,
                statusMessage: 'Đang tự động đăng nhập Facebook → Dola để lấy Cookie Dola…'
              })
              addedIds.push(existing.id)
            } else {
              const id = `acc-${crypto.randomUUID().slice(0, 8)}`
              const partition = `persist:dola-${id}`
              const acc: AccountProfile = {
                id,
                name:
                  (fbList.length === 1 && payload.name.trim()) ||
                  (payload.name.trim() ? `${payload.name.trim()} #${i + 1}` : `FB ${item.fbUid.slice(-6)}`),
                poolId: payload.poolId || undefined,
                fbUid: item.fbUid,
                fbCookie: item.fbCookie,
                fbToken: item.fbToken,
                email: item.email,
                sourceType: 'facebook',
                partition,
                enabled: true,
                proxyId: payload.proxyId || undefined,
                status: 'checking',
                statusMessage: 'Đang tự động đăng nhập Facebook → Dola để lấy Cookie Dola…',
                videosToday: 0,
                totalVideos: 0,
                createdAt: Date.now()
              }
              store.upsertAccount(acc)
              addedIds.push(id)
            }
          }
          store.flushSync()
          broadcastStateUpdate()

          if (addedIds.length === 1) {
            const targetId = addedIds[0]
            const targetAcc = store.getAccountById(targetId)
            if (targetAcc?.fbCookie) {
              await injectFacebookCookiesToPartition(targetAcc.partition, targetAcc.fbCookie, true)
            }
            const loginRes = await loginWithFacebookAccount(targetId, false, () => {
              broadcastStateUpdate()
            })
            broadcastStateUpdate()
            triggerQueueScheduler()
            return {
              ok: loginRes.ok,
              account: store.getAccountById(targetId),
              warning: loginRes.ok ? undefined : loginRes.message,
              message: loginRes.message
            }
          } else {
            const conc = resolveLoginConcurrency()
            void (async () => {
              await runPoolWithConcurrency(addedIds, conc, async (id) => {
                const acc = store.getAccountById(id)
                if (acc?.fbCookie) {
                  await injectFacebookCookiesToPartition(acc.partition, acc.fbCookie, true)
                }
                await loginWithFacebookAccount(id, false, () => {
                  broadcastStateUpdate()
                })
                broadcastStateUpdate()
                triggerQueueScheduler()
              })
            })()
            return {
              ok: true,
              account: store.getAccountById(addedIds[0]),
              message: `Đã nhận diện ${addedIds.length} Cookie Facebook — đang tự động đăng nhập Dola (${conc} luồng) để lấy phiên…`
            }
          }
        }
      }

      // 3. Support multi-line Dola cookies (e.g. one account cookie per line or name|sessionid=...)
      const nonEmptyLines = rawCookieText
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'))
      const multiDolaLines =
        !rawCookieText.includes('\t') &&
        nonEmptyLines.length > 1 &&
        nonEmptyLines.filter((l) => /(sessionid|sid_guard|sid_tt)=/i.test(l)).length > 1
      if (multiDolaLines) {
        const addedAccounts: AccountProfile[] = []
        for (let i = 0; i < nonEmptyLines.length; i++) {
          const line = nonEmptyLines[i]
          let customLineName = ''
          let cookiePart = line
          if (line.includes('|') || line.includes('----')) {
            const segs = line.split(/\||----/).map((s) => s.trim()).filter(Boolean)
            if (segs.length >= 2 && !segs[0].includes('=')) {
              customLineName = segs[0]
              cookiePart = segs.slice(1).join('; ')
            }
          }
          const parsedLine = parseAndValidateCookies(cookiePart)
          if (parsedLine.cookies.length === 0) continue
          const normalizedHeader = parsedLine.cookies.map((c) => `${c.name}=${c.value}`).join('; ')
          const id = `acc-${crypto.randomUUID().slice(0, 8)}`
          const partition = `persist:dola-${id}`
          const accName =
            customLineName ||
            (payload.name.trim()
              ? `${payload.name.trim()} #${addedAccounts.length + 1}`
              : `Dola #${store.getAccounts().length + 1}`)
          const acc: AccountProfile = {
            id,
            name: accName,
            poolId: payload.poolId || undefined,
            sourceType: 'cookie',
            cookieHeader: normalizedHeader,
            partition,
            enabled: true,
            proxyId: payload.proxyId || undefined,
            status: 'checking',
            statusMessage: parsedLine.warning || 'Vừa thêm cookie — đang kiểm tra…',
            videosToday: 0,
            totalVideos: 0,
            createdAt: Date.now()
          }
          store.upsertAccount(acc)
          await injectCookiesToPartition(partition, normalizedHeader, true)
          addedAccounts.push(acc)
        }
        if (addedAccounts.length > 0) {
          store.flushSync()
          broadcastStateUpdate()
          void runPoolWithConcurrency(addedAccounts, resolveLoginConcurrency(), async (a) => {
            await checkAccountHealth(a.id).catch(() => {})
            broadcastStateUpdate()
            triggerQueueScheduler()
          })
          return {
            ok: true,
            account: addedAccounts[0],
            message: `Đã thêm và đang kiểm tra ${addedAccounts.length} tài khoản Cookie Dola!`
          }
        }
      }

      // 4. Single Dola Cookie account
      const id = `acc-${crypto.randomUUID().slice(0, 8)}`
      const partition = `persist:dola-${id}`
      const { cookies, warning } = parseAndValidateCookies(rawCookieText)
      const normalizedCookieHeader =
        cookies.length > 0
          ? cookies.map((c) => `${c.name}=${c.value}`).join('; ')
          : rawCookieText

      const acc: AccountProfile = {
        id,
        name: payload.name.trim() || `Dola #${store.getAccounts().length + 1}`,
        poolId: payload.poolId || undefined,
        sourceType: 'cookie',
        cookieHeader: normalizedCookieHeader,
        partition,
        enabled: true,
        proxyId: payload.proxyId || undefined,
        status: 'unknown',
        statusMessage: warning || 'Vừa thêm cookie — đang kiểm tra…',
        videosToday: 0,
        totalVideos: 0,
        createdAt: Date.now()
      }

      store.upsertAccount(acc)
      await injectCookiesToPartition(partition, normalizedCookieHeader, true)
      store.flushSync()
      broadcastStateUpdate()

      // Immediately verify health
      const checked = await checkAccountHealth(id)
      broadcastStateUpdate()
      triggerQueueScheduler()
      return { ok: true, account: checked || acc, warning }
    }
  )

  ipcMain.handle(
    'accounts:import-json-file',
    async (_ev, payload?: { poolId?: string; proxyId?: string }) => {
      if (!mainWindow) return { ok: false, addedCount: 0, updatedCount: 0, message: 'Chưa mở cửa sổ chính.' }
      const res = await dialog.showOpenDialog(mainWindow, {
        title: 'Chọn file JSON / TXT Tài khoản (Seedance Ultimate / Dola / Cookie-Editor)',
        properties: ['openFile', 'multiSelections'],
        filters: [
          { name: 'JSON / Cookie Files', extensions: ['json', 'txt'] },
          { name: 'All Files', extensions: ['*'] }
        ]
      })
      if (res.canceled || !res.filePaths.length) {
        return { ok: false, canceled: true, addedCount: 0, updatedCount: 0 }
      }
      let totalAdded = 0
      let totalUpdated = 0
      for (const fp of res.filePaths) {
        try {
          const raw = fs.readFileSync(fp, 'utf-8')
          const baseFileName = path
            .basename(fp)
            .replace(/(_cookie|_cdp_cookie|_identity)?\.(json|txt|pk)$/i, '')
            .trim()
          const bundle = tryParseSeedanceAccountsBundle(raw, baseFileName || undefined)
          if (bundle) {
            const imported = await importSeedanceAccountsBundle(bundle, {
              fallbackPoolId: payload?.poolId,
              fallbackProxyId: payload?.proxyId,
              verifyInBackground: true
            })
            totalAdded += imported.addedCount
            totalUpdated += imported.updatedCount
          } else {
            // Fallback: plain cookie file (Netscape / Header string / single JSON object)
            const parsed = parseAndValidateCookies(raw)
            if (parsed.cookies.length > 0) {
              const fallbackBundle: SeedanceAccountsExportPayload = {
                loai: 'seedance-accounts',
                tai_khoan: [
                  {
                    name: baseFileName || `Dola #${store.getAccounts().length + 1}`,
                    cookies: Object.fromEntries(parsed.cookies.map((c) => [c.name, c.value])),
                    enabled: true
                  }
                ]
              }
              const imported = await importSeedanceAccountsBundle(fallbackBundle, {
                fallbackPoolId: payload?.poolId,
                fallbackProxyId: payload?.proxyId,
                verifyInBackground: true
              })
              totalAdded += imported.addedCount
              totalUpdated += imported.updatedCount
            }
          }
        } catch (err) {
          console.error('[import-json-file] Error reading file:', fp, err)
        }
      }
      triggerQueueScheduler()
      return {
        ok: totalAdded + totalUpdated > 0,
        addedCount: totalAdded,
        updatedCount: totalUpdated,
        message:
          totalAdded + totalUpdated > 0
            ? `Đã nhập thành công ${totalAdded} tài khoản mới (cập nhật ${totalUpdated} tài khoản) từ ${res.filePaths.length} file kèm bơm Cookie vào phiên!`
            : 'Không tìm thấy Cookie / JSON tài khoản hợp lệ trong file đã chọn.'
      }
    }
  )

  ipcMain.handle(
    'accounts:add-google-batch',
    async (_ev, payload: { rawLines: string; autoLoginNow: boolean; poolId?: string }) => {
      const lines = payload.rawLines
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)

      const addedIds: string[] = []
      for (const line of lines) {
        // Support formats: email|password or email:password or email\tpassword
        const parts = line.split(/[|:\t]/)
        if (parts.length < 2) continue
        const email = parts[0].trim()
        const password = parts.slice(1).join(':').trim()
        if (!email || !password) continue

        const id = `acc-${crypto.randomUUID().slice(0, 8)}`
        const partition = `persist:dola-${id}`
        const acc: AccountProfile = {
          id,
          name: email.split('@')[0] || email,
          poolId: payload.poolId || undefined,
          email,
          password,
          sourceType: 'google',
          partition,
          enabled: true,
          status: 'unknown',
          statusMessage: 'Đã lưu thông tin Google — sẵn sàng đăng nhập',
          videosToday: 0,
          totalVideos: 0,
          createdAt: Date.now()
        }
        store.upsertAccount(acc)
        addedIds.push(id)
      }

      broadcastStateUpdate()

      const resolveConcurrency = (requested?: number): number => {
        const raw = Number(requested || store.getSettings().loginConcurrency || 3)
        return Math.min(5, Math.max(1, Number.isFinite(raw) ? Math.round(raw) : 3))
      }

      const runWithConcurrency = async <T>(
        items: T[],
        concurrency: number,
        worker: (item: T, index: number) => Promise<void>
      ): Promise<void> => {
        let cursor = 0
        const threadCount = Math.min(items.length, Math.max(1, concurrency))
        const runners = Array.from({ length: threadCount }, async () => {
          while (cursor < items.length) {
            const idx = cursor++
            const item = items[idx]
            try {
              await worker(item, idx)
            } catch {}
          }
        })
        await Promise.all(runners)
      }

      if (payload.autoLoginNow && addedIds.length > 0) {
        const conc = resolveConcurrency((payload as any).concurrency)
        void (async () => {
          await runWithConcurrency(addedIds, conc, async (id) => {
            await loginWithGoogleCredentials(id, false)
            broadcastStateUpdate()
            triggerQueueScheduler()
          })
        })()
      }

      return { ok: true, addedCount: addedIds.length }
    }
  )

  ipcMain.handle(
    'accounts:add-facebook-batch',
    async (
      _ev,
      payload: {
        rawLines: string
        autoLoginNow: boolean
        showWindow?: boolean
        proxyId?: string
        poolId?: string
        concurrency?: number
      }
    ) => {
      const bundle = tryParseSeedanceAccountsBundle(payload.rawLines)
      if (bundle) {
        const res = await importSeedanceAccountsBundle(bundle, {
          fallbackPoolId: payload.poolId,
          fallbackProxyId: payload.proxyId,
          verifyInBackground: true
        })
        triggerQueueScheduler()
        const totalImported = res.addedCount + res.updatedCount
        return {
          ok: true,
          addedCount: totalImported,
          message: `Đã nhập thành công ${res.addedCount} tài khoản mới (cập nhật ${res.updatedCount} tài khoản) từ JSON kèm Kho & Proxy xoay!`
        }
      }

      const parsedList = parseFacebookBatchInput(payload.rawLines)
      if (parsedList.length === 0) {
        return {
          ok: false,
          addedCount: 0,
          message:
            'Không đọc được cookie/via Facebook hợp lệ nào. Cần dán dòng uid|pass|2fa|c_user=...;xs=... hoặc chuỗi c_user=...;xs=...'
        }
      }

      const addedIds: string[] = []
      for (const item of parsedList) {
        let resolvedProxyId = payload.proxyId
        if (!resolvedProxyId && item.proxyRaw) {
          const parsedPx = parseProxyString(item.proxyRaw, 'http')
          if (parsedPx) {
            const existingPx = store
              .getProxies()
              .find(
                (p) =>
                  p.host === parsedPx.host &&
                  p.port === parsedPx.port &&
                  p.username === parsedPx.username
              )
            if (existingPx) {
              resolvedProxyId = existingPx.id
            } else {
              const pxId = `px-${crypto.randomUUID().slice(0, 8)}`
              store.upsertProxy({
                id: pxId,
                ...parsedPx,
                status: 'unknown'
              })
              resolvedProxyId = pxId
            }
          }
        }

        // Check if fbUid already exists -> update it instead of duplicating
        const existing = store.getAccounts().find((a) => a.fbUid && a.fbUid === item.fbUid)
        if (existing) {
          store.updateAccount(existing.id, {
            fbCookie: item.fbCookie || existing.fbCookie,
            password: item.password || existing.password,
            twoFactorSecret: item.twoFactorSecret || existing.twoFactorSecret,
            fbToken: item.fbToken || existing.fbToken,
            email: item.email || existing.email,
            proxyId: resolvedProxyId || existing.proxyId,
            poolId: payload.poolId || existing.poolId,
            statusMessage: 'Đã cập nhật thông tin/Cookie Facebook mới — sẵn sàng đăng nhập'
          })
          addedIds.push(existing.id)
          continue
        }

        const id = `acc-${crypto.randomUUID().slice(0, 8)}`
        const partition = `persist:dola-${id}`
        const acc: AccountProfile = {
          id,
          name: `FB ${item.fbUid.slice(-6)}`,
          poolId: payload.poolId || undefined,
          fbUid: item.fbUid,
          password: item.password,
          twoFactorSecret: item.twoFactorSecret,
          fbCookie: item.fbCookie,
          fbToken: item.fbToken,
          email: item.email,
          sourceType: 'facebook',
          partition,
          enabled: true,
          proxyId: resolvedProxyId || undefined,
          status: 'unknown',
          statusMessage: 'Đã nạp Via Facebook — sẵn sàng đăng nhập Dola',
          videosToday: 0,
          totalVideos: 0,
          createdAt: Date.now()
        }
        store.upsertAccount(acc)
        addedIds.push(id)
      }

      store.flushSync()
      broadcastStateUpdate()

      const conc = resolveLoginConcurrency(payload.concurrency)

      // Inject cookies & run auto-login in parallel worker pool (3-5 threads) so UI never freezes
      void (async () => {
        await runPoolWithConcurrency(addedIds, conc, async (id) => {
          const acc = store.getAccountById(id)
          if (acc?.fbCookie) {
            await injectFacebookCookiesToPartition(acc.partition, acc.fbCookie)
          }
          if (payload.autoLoginNow) {
            await loginWithFacebookAccount(id, Boolean(payload.showWindow), () => {
              broadcastStateUpdate()
            })
            broadcastStateUpdate()
            triggerQueueScheduler()
          }
        })
      })()

      return {
        ok: true,
        addedCount: addedIds.length,
        message: `Đã nạp ${addedIds.length} tài khoản Facebook${
          payload.autoLoginNow
            ? ` — đang tự động đăng nhập song song (${conc} luồng cùng lúc)…`
            : '.'
        }`
      }
    }
  )

  ipcMain.handle(
    'accounts:login-facebook',
    async (_ev, payload: { accountId: string; showWindow?: boolean }) => {
      const res = await loginWithFacebookAccount(
        payload.accountId,
        Boolean(payload.showWindow),
        () => {
          broadcastStateUpdate()
        }
      )
      broadcastStateUpdate()
      triggerQueueScheduler()
      return res
    }
  )

  ipcMain.handle(
    'accounts:login-batch',
    async (
      _ev,
      payload: { accountIds: string[]; showWindow?: boolean; concurrency?: number }
    ) => {
      const ids = Array.isArray(payload?.accountIds) ? payload.accountIds : []
      if (ids.length === 0) {
        return { ok: false, successCount: 0, total: 0, message: 'Chưa chọn tài khoản nào để đăng nhập.' }
      }
      const conc = resolveLoginConcurrency(payload.concurrency)
      let successCount = 0
      await runPoolWithConcurrency(ids, conc, async (id) => {
        const acc = store.getAccountById(id)
        if (!acc) return
        if (acc.sourceType === 'google') {
          const r = await loginWithGoogleCredentials(id, Boolean(payload.showWindow))
          if (r.ok) successCount++
        } else {
          const r = await loginWithFacebookAccount(id, Boolean(payload.showWindow), () => {
            broadcastStateUpdate()
          })
          if (r.ok) successCount++
        }
        broadcastStateUpdate()
        triggerQueueScheduler()
      })
      return {
        ok: true,
        successCount,
        total: ids.length,
        message: `Đã đăng nhập xong ${successCount}/${ids.length} tài khoản (${conc} luồng song song).`
      }
    }
  )

  ipcMain.handle('accounts:create-manual', async (_ev, payload: string | { name: string; poolId?: string }) => {
    const rawName = typeof payload === 'string' ? payload : payload?.name || ''
    const poolId = typeof payload === 'object' ? payload?.poolId : undefined
    const id = `acc-${crypto.randomUUID().slice(0, 8)}`
    const partition = `persist:dola-${id}`
    const acc: AccountProfile = {
      id,
      name: rawName.trim() || `Tài khoản #${store.getAccounts().length + 1}`,
      poolId: poolId || undefined,
      sourceType: 'manual',
      partition,
      enabled: true,
      status: 'unknown',
      statusMessage: 'Đang mở trình duyệt để đăng nhập tay…',
      videosToday: 0,
      totalVideos: 0,
      createdAt: Date.now()
    }
    store.upsertAccount(acc)
    broadcastStateUpdate()
    await openAccountBrowser(id, () => {
      broadcastStateUpdate()
    })
    broadcastStateUpdate()
    triggerQueueScheduler()
    return { ok: true, account: acc }
  })

  ipcMain.handle('accounts:open-browser', async (_ev, accountId: string) => {
    const res = await openAccountBrowser(accountId, () => {
      broadcastStateUpdate()
    })
    broadcastStateUpdate()
    triggerQueueScheduler()
    return res
  })

  ipcMain.handle('accounts:login-google', async (_ev, accountId: string) => {
    const res = await loginWithGoogleCredentials(accountId, true)
    broadcastStateUpdate()
    triggerQueueScheduler()
    return res
  })

  ipcMain.handle('accounts:check-one', async (_ev, accountId: string) => {
    const res = await checkAccountHealth(accountId)
    broadcastStateUpdate()
    triggerQueueScheduler()
    return res
  })

  ipcMain.handle(
    'accounts:check-all',
    async (_ev, payload?: { accountIds?: string[]; concurrency?: number }) => {
      const allAccs = store.getAccounts()
      const accounts =
        payload?.accountIds && payload.accountIds.length > 0
          ? allAccs.filter((a) => payload.accountIds!.includes(a.id))
          : allAccs
      const conc = resolveLoginConcurrency(payload?.concurrency)

      await runPoolWithConcurrency(accounts, conc, async (acc) => {
        await checkAccountHealth(acc.id)
        broadcastStateUpdate()
        triggerQueueScheduler()
      })
      return { ok: true, count: accounts.length }
    }
  )

  ipcMain.handle('accounts:recycle-one', async (_ev, accountId: string) => {
    const res = await recycleAccountQuota(accountId)
    broadcastStateUpdate()
    triggerQueueScheduler()
    return res
  })

  ipcMain.handle(
    'accounts:recycle-all-exhausted',
    async (_ev, payload?: { accountIds?: string[]; concurrency?: number }) => {
      const allExhausted = store.getAccounts().filter((a) => a.status === 'quota_exhausted')
      const targets =
        payload?.accountIds && payload.accountIds.length > 0
          ? allExhausted.filter((a) => payload.accountIds!.includes(a.id))
          : allExhausted
      const conc = resolveLoginConcurrency(payload?.concurrency)
      let successCount = 0

      await runPoolWithConcurrency(targets, conc, async (acc) => {
        const res = await recycleAccountQuota(acc.id)
        if (res.ok) successCount++
        broadcastStateUpdate()
      })
      triggerQueueScheduler()
      return {
        ok: true,
        total: targets.length,
        successCount,
        message: `Đã làm mới lượt xong ${successCount}/${targets.length} tài khoản (${conc} luồng).`
      }
    }
  )

  ipcMain.handle(
    'accounts:update',
    (_ev, payload: { id: string; patch: Partial<AccountProfile> }) => {
      const res = store.updateAccount(payload.id, payload.patch)
      broadcastStateUpdate()
      triggerQueueScheduler()
      return res
    }
  )

  ipcMain.handle('accounts:delete', (_ev, accountId: string) => {
    const list = store.deleteAccount(accountId)
    broadcastStateUpdate()
    triggerQueueScheduler()
    return list
  })

  // 5. Proxies & Rotating Proxies
  ipcMain.handle(
    'proxies:add-batch',
    (_ev, payload: { rawLines: string; protocol: 'http' | 'socks5' }) => {
      const res = createStaticProxiesFromText(payload.rawLines, payload.protocol)
      broadcastStateUpdate()
      return res
    }
  )

  ipcMain.handle('proxies:check-one', async (_ev, proxyId: string) => {
    const res = await checkSingleProxy(proxyId)
    broadcastStateUpdate()
    return res
  })

  ipcMain.handle('proxies:check-all', async () => {
    const proxies = store.getProxies()
    await Promise.all(
      proxies.map(async (p) => {
        await checkSingleProxy(p.id)
        broadcastStateUpdate()
      })
    )
    return { ok: true }
  })

  ipcMain.handle('proxies:delete', (_ev, proxyId: string) => {
    const list = store.deleteProxy(proxyId)
    broadcastStateUpdate()
    return list
  })

  ipcMain.handle(
    'proxies:auto-pair',
    (_ev, options?: { poolId?: string; mode?: '1_to_1' | '1_per_pool' }) => {
      const res = autoPairProxiesToAccounts(options)
      broadcastStateUpdate()
      return res
    }
  )

  ipcMain.handle('rotating-proxies:upsert', (_ev, entry: RotatingProxyEntry) => {
    const norm = normalizeRotatingKeyInput(
      entry.apiKey,
      entry.provider,
      entry.nhamang || 'Random',
      entry.tinhthanh || '0'
    )
    entry.apiKey = norm.apiKey
    entry.provider = norm.provider
    if (norm.provider === 'topproxy') {
      entry.nhamang = norm.nhamang
      entry.tinhthanh = norm.tinhthanh
    }
    const list = store.upsertRotatingProxy(entry)
    broadcastStateUpdate()
    return list
  })

  ipcMain.handle(
    'rotating-proxies:add-batch',
    async (
      _ev,
      payload: {
        rawKeys: string
        provider: RotatingProxyEntry['provider']
        protocol: 'http' | 'socks5'
        namePrefix?: string
        nhamang?: string
        tinhthanh?: string
      }
    ) => {
      const res = await createRotatingProxiesBatch(payload)
      broadcastStateUpdate()
      return res
    }
  )

  ipcMain.handle(
    'rotating-proxies:rotate',
    async (_ev, payload: { id: string; force: boolean }) => {
      const res = await resolveRotatingProxy(payload.id, payload.force)
      broadcastStateUpdate()
      return res
    }
  )

  ipcMain.handle('rotating-proxies:rotate-all', async (_ev, force = false) => {
    const rotKeys = store.getRotatingProxies()
    await Promise.all(
      rotKeys.map(async (r) => {
        await resolveRotatingProxy(r.id, Boolean(force))
        broadcastStateUpdate()
      })
    )
    return { ok: true, count: rotKeys.length }
  })

  ipcMain.handle(
    'topproxy:sync-account',
    async (
      _ev,
      payload: {
        accountApiKey: string
        protocol: 'http' | 'socks5'
        nhamang?: string
        tinhthanh?: string
        syncRotating?: boolean
        syncStaticType?: string
      }
    ) => {
      const res = await syncTopProxyAccount(payload)
      broadcastStateUpdate()
      return res
    }
  )

  ipcMain.handle('rotating-proxies:delete', (_ev, id: string) => {
    const list = store.deleteRotatingProxy(id)
    broadcastStateUpdate()
    return list
  })

  // 6. Characters (@tag)
  ipcMain.handle('characters:upsert', (_ev, char: CharacterEntry) => {
    const list = store.upsertCharacter(char)
    broadcastStateUpdate()
    return list
  })

  ipcMain.handle('characters:delete', (_ev, id: string) => {
    const list = store.deleteCharacter(id)
    broadcastStateUpdate()
    return list
  })

  // 7. Batch Video Queue
  ipcMain.handle('queue:submit', (_ev, payload: QueueSubmitPayload) => {
    return submitBatchTasks(payload)
  })

  ipcMain.handle('queue:retry-one', (_ev, taskId: string) => {
    retryTask(taskId)
    return { ok: true }
  })

  ipcMain.handle('queue:retry-all-failed', () => {
    const count = retryAllFailedTasks()
    return { ok: true, count }
  })

  ipcMain.handle('queue:cancel-one', (_ev, taskId: string) => {
    cancelTask(taskId)
    return { ok: true }
  })

  ipcMain.handle('queue:delete-one', (_ev, taskId: string) => {
    store.deleteTask(taskId)
    broadcastStateUpdate()
    return { ok: true }
  })

  ipcMain.handle('queue:clear-finished', () => {
    store.clearFinishedTasks()
    broadcastStateUpdate()
    return { ok: true }
  })

  ipcMain.handle('queue:clear-failed', () => {
    store.clearFailedTasks()
    broadcastStateUpdate()
    return { ok: true }
  })

  ipcMain.handle('queue:retry-many', (_ev, ids: string[]) => {
    const count = retryTasks(Array.isArray(ids) ? ids : [])
    return { ok: true, count }
  })

  ipcMain.handle('queue:recover-one', (_ev, taskId: string) =>
    typeof taskId === 'string' ? recoverTaskVideo(taskId) : { ok: false, message: 'Thiếu mã task.' }
  )

  ipcMain.handle('queue:edit-prompt-retry', (_ev, payload: { taskId: string; prompt: string }) =>
    typeof payload?.taskId === 'string' && typeof payload?.prompt === 'string'
      ? editPromptAndRetry(payload.taskId, payload.prompt)
      : { ok: false, message: 'Dữ liệu không hợp lệ.' }
  )

  ipcMain.handle('queue:delete-many', (_ev, ids: string[]) => {
    const count = deleteTasks(Array.isArray(ids) ? ids : [])
    return { ok: true, count }
  })

  ipcMain.handle('queue:set-paused', (_ev, paused: boolean) => {
    setQueuePaused(paused)
    return { ok: true, paused }
  })

  // 8. Video Library & Frame Extraction
  ipcMain.handle('library:pull-from-account', async (_ev, accountId: string) => {
    const res = await pullVideosFromAccount(accountId)
    broadcastStateUpdate()
    return res
  })

  ipcMain.handle('library:pull-from-all', async () => {
    const accounts = store.getAccounts().filter((a) => a.enabled)
    let totalPulled = 0
    for (const acc of accounts) {
      const r = await pullVideosFromAccount(acc.id)
      totalPulled += r.pulledCount
      broadcastStateUpdate()
    }
    return {
      ok: true,
      pulledCount: totalPulled,
      message:
        totalPulled > 0
          ? `Đã kéo tổng cộng ${totalPulled} video mới từ ${accounts.length} tài khoản!`
          : 'Không có video mới nào chưa tải trên các tài khoản đang bật.'
    }
  })

  ipcMain.handle('library:upgrade-watermarked', async () => {
    const res = await upgradeWatermarkedVideosFromDola(() => broadcastStateUpdate())
    broadcastStateUpdate()
    return res
  })

  ipcMain.handle('library:extract-last-frame', async (_ev, videoFilePath: string) => {
    return await extractLastFrame(videoFilePath)
  })

  ipcMain.handle(
    'library:delete-video',
    (_ev, payload: { id: string; removeFile: boolean }) => {
      store.deleteVideo(payload.id, payload.removeFile)
      broadcastStateUpdate()
      return { ok: true }
    }
  )
}

app.whenReady().then(() => {
  registerCustomMediaProtocol()
  registerProxyAuthHandler()
  registerIpcHandlers()
  createMainWindow()

  // Recover stalled tasks synchronously so the initial UI state is accurate without heavy network I/O
  recoverStalledTasksOnStartup()

  // Defer background seeding & health checks by 3.5s so the main window renders and responds at 60fps immediately
  setTimeout(() => {
    void (async () => {
      await importSeedanceAccountsBundle(DEFAULT_SEEDANCE_ACCOUNTS_DATA, {
        preserveRuntimeStatus: true
      }).catch((err) => {
        console.error('[account-seed] Failed to seed default accounts:', err)
      })

      await seedUserDefaultRotatingProxies(() => broadcastStateUpdate()).catch((err) => {
        console.error('[proxy-seed] Failed to seed rotating proxies:', err)
      })

      broadcastStateUpdate()
      triggerQueueScheduler()

      const accountsToCheck = store.getAccounts().filter((acc) => {
        if (acc.cookieHeader && acc.status === 'ready') return false
        const priorMsg = acc.statusMessage || ''
        const isKnownFbBlocked =
          !acc.cookieHeader &&
          /(?:checkpoint|2fa|xác thực 2 yếu tố|khóa két sắt|đình chỉ)/i.test(priorMsg)
        if (isKnownFbBlocked) return false
        return acc.status === 'unknown'
      })

      // Run 1 gentle background health-check worker so startup never spawns multiple Chromium windows at once
      for (const acc of accountsToCheck) {
        const checked = await checkAccountHealth(acc.id).catch(() => null)
        broadcastStateUpdate()
        if (checked?.status === 'ready') {
          triggerQueueScheduler()
        } else if (acc.enabled && acc.sourceType === 'facebook' && acc.fbCookie) {
          await loginWithFacebookAccount(acc.id, false, () => {
            broadcastStateUpdate()
          }).catch(() => {})
          broadcastStateUpdate()
          triggerQueueScheduler()
        }
      }
      triggerQueueScheduler()
    })()
  }, 3500)

  app.on('activate', () => {
    if (!mainWindow || mainWindow.isDestroyed()) createMainWindow()
  })
})

app.on('before-quit', () => {
  store.flushSync()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

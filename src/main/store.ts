import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import {
  AccountPoolEntry,
  AccountProfile,
  AppSettings,
  CharacterEntry,
  ProjectEntry,
  ProxyEntry,
  RotatingProxyEntry,
  VideoLibraryItem,
  VideoTask
} from '../shared/types'
import { localDayKey, rolledOver } from './daily'
import { extractEmail } from './email'

export const DEFAULT_ACCOUNT_POOL_ID = 'pool-default'

export interface StoreSchema {
  settings: AppSettings
  accountPools: AccountPoolEntry[]
  accounts: AccountProfile[]
  proxies: ProxyEntry[]
  rotatingProxies: RotatingProxyEntry[]
  characters: CharacterEntry[]
  projects: ProjectEntry[]
  tasks: VideoTask[]
  videos: VideoLibraryItem[]
}

class AppStore {
  private filePath: string
  private data: StoreSchema
  private saveTimer: NodeJS.Timeout | null = null

  constructor() {
    const userDataDir = app.getPath('userData')
    const defaultOutputDir = path.join(app.getPath('downloads'), 'ViraAI_Videos')
    if (!fs.existsSync(defaultOutputDir)) {
      try {
        fs.mkdirSync(defaultOutputDir, { recursive: true })
      } catch {}
    }

    this.filePath = path.join(userDataDir, 'viraai-store.json')

    const defaultProjectId = 'proj-default'
    const defaultData: StoreSchema = {
      settings: {
        dolaBaseUrl: 'https://www.dola.com',
        outputDir: defaultOutputDir,
        concurrency: 2,
        loginConcurrency: 3,
        batchAllocationMode: '20_per_acc',
        autoRecycleOnQuota: true,
        preferProMode: true,
        showBrowserDuringGen: false,
        useHttpApiMode: true,
        pollTimeoutMinutes: 12,
        autoRemoveWatermark: true,
        activeProjectId: defaultProjectId,
        activePoolId: 'all'
      },
      accountPools: [
        {
          id: DEFAULT_ACCOUNT_POOL_ID,
          name: 'Kho mặc định',
          createdAt: Date.now(),
          updatedAt: Date.now()
        }
      ],
      accounts: [],
      proxies: [],
      rotatingProxies: [],
      characters: [],
      projects: [
        {
          id: defaultProjectId,
          name: 'Dự án mặc định',
          outputDir: defaultOutputDir,
          defaultRatio: '9:16',
          defaultDuration: 10,
          createdAt: Date.now(),
          updatedAt: Date.now()
        }
      ],
      tasks: [],
      videos: []
    }

    this.data = this.loadFromDisk(defaultData)
  }

  private loadFromDisk(fallback: StoreSchema): StoreSchema {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf-8')
        const parsed = JSON.parse(raw)
        return {
          settings: { ...fallback.settings, ...(parsed.settings || {}) },
          accountPools:
            Array.isArray(parsed.accountPools) && parsed.accountPools.length > 0
              ? parsed.accountPools
              : fallback.accountPools,
          // extractEmail cleans emails saved before the parser fix (token blob stored as the email)
          accounts: Array.isArray(parsed.accounts)
            ? parsed.accounts.map((a: AccountProfile) =>
                a.email ? { ...a, email: extractEmail(a.email) } : a
              )
            : [],
          proxies: Array.isArray(parsed.proxies) ? parsed.proxies : [],
          rotatingProxies: Array.isArray(parsed.rotatingProxies) ? parsed.rotatingProxies : [],
          characters: Array.isArray(parsed.characters) ? parsed.characters : [],
          projects:
            Array.isArray(parsed.projects) && parsed.projects.length > 0
              ? parsed.projects
              : fallback.projects,
          tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
          videos: Array.isArray(parsed.videos) ? parsed.videos : []
        }
      }
    } catch (err) {
      console.error('[store] Failed to load store from disk:', err)
    }
    return fallback
  }

  private isSavingAsync = false
  private pendingAsyncSave = false

  public flushSync(): void {
    try {
      const dir = path.dirname(this.filePath)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }
      const tmpPath = `${this.filePath}.tmp`
      fs.writeFileSync(tmpPath, JSON.stringify(this.data), 'utf-8')
      fs.renameSync(tmpPath, this.filePath)
    } catch (err) {
      console.error('[store] Failed to save store:', err)
    }
  }

  private async flushAsync(): Promise<void> {
    if (this.isSavingAsync) {
      this.pendingAsyncSave = true
      return
    }
    this.isSavingAsync = true
    try {
      const dir = path.dirname(this.filePath)
      const tmpPath = `${this.filePath}.tmp`
      const jsonStr = JSON.stringify(this.data)
      await fs.promises.writeFile(tmpPath, jsonStr, 'utf-8')
      await fs.promises.rename(tmpPath, this.filePath)
    } catch (err) {
      console.error('[store] Failed to async save store:', err)
    } finally {
      this.isSavingAsync = false
      if (this.pendingAsyncSave) {
        this.pendingAsyncSave = false
        this.scheduleSave()
      }
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      void this.flushAsync()
    }, 1000)
  }

  // Settings
  public getSettings(): AppSettings {
    return this.data.settings
  }

  public updateSettings(patch: Partial<AppSettings>): AppSettings {
    this.data.settings = { ...this.data.settings, ...patch }
    if (patch.outputDir && !fs.existsSync(patch.outputDir)) {
      try {
        fs.mkdirSync(patch.outputDir, { recursive: true })
      } catch {}
    }
    this.scheduleSave()
    return this.data.settings
  }

  // Projects (Kho Video)
  public getProjects(): ProjectEntry[] {
    return this.data.projects
  }

  public saveProject(project: ProjectEntry): ProjectEntry[] {
    const idx = this.data.projects.findIndex((p) => p.id === project.id)
    if (idx >= 0) {
      this.data.projects[idx] = { ...project, updatedAt: Date.now() }
    } else {
      this.data.projects.unshift(project)
    }
    if (project.outputDir && !fs.existsSync(project.outputDir)) {
      try {
        fs.mkdirSync(project.outputDir, { recursive: true })
      } catch {}
    }
    this.scheduleSave()
    return this.data.projects
  }

  public deleteProject(id: string): ProjectEntry[] {
    if (this.data.projects.length <= 1) return this.data.projects
    this.data.projects = this.data.projects.filter((p) => p.id !== id)
    if (this.data.settings.activeProjectId === id && this.data.projects[0]) {
      this.data.settings.activeProjectId = this.data.projects[0].id
    }
    this.scheduleSave()
    return this.data.projects
  }

  // Account Pools (Kho Tài Khoản)
  public getAccountPools(): AccountPoolEntry[] {
    return this.data.accountPools
  }

  public saveAccountPool(pool: AccountPoolEntry): AccountPoolEntry[] {
    const idx = this.data.accountPools.findIndex((p) => p.id === pool.id)
    if (idx >= 0) {
      this.data.accountPools[idx] = { ...pool, updatedAt: Date.now() }
    } else {
      this.data.accountPools.push({
        ...pool,
        createdAt: pool.createdAt || Date.now(),
        updatedAt: Date.now()
      })
    }
    this.scheduleSave()
    return this.data.accountPools
  }

  public deleteAccountPool(id: string): AccountPoolEntry[] {
    if (this.data.accountPools.length <= 1) return this.data.accountPools
    this.data.accountPools = this.data.accountPools.filter((p) => p.id !== id)
    const fallbackPoolId = this.data.accountPools[0]?.id || DEFAULT_ACCOUNT_POOL_ID
    for (const acc of this.data.accounts) {
      if ((acc.poolId || DEFAULT_ACCOUNT_POOL_ID) === id) {
        acc.poolId = fallbackPoolId
      }
    }
    if (this.data.settings.activePoolId === id) {
      this.data.settings.activePoolId = 'all'
    }
    this.scheduleSave()
    return this.data.accountPools
  }

  public assignAccountsToPool(accountIds: string[], poolId: string): AccountProfile[] {
    const idSet = new Set(accountIds)
    for (const acc of this.data.accounts) {
      if (idSet.has(acc.id)) {
        acc.poolId = poolId
      }
    }
    this.scheduleSave()
    return this.data.accounts
  }

  /**
   * Automatically split accounts (all or specific IDs) into pools of `poolSize` accounts each
   * (e.g. 5, 10, 15, 20 Facebook vias per pool).
   */
  public autoSplitAccountsIntoPools(
    poolSize: number,
    prefix = 'Kho Via',
    targetAccountIds?: string[]
  ): { pools: AccountPoolEntry[]; accounts: AccountProfile[]; poolCount: number } {
    const size = Math.max(1, Math.floor(poolSize || 5))
    const idSet =
      targetAccountIds && targetAccountIds.length > 0 ? new Set(targetAccountIds) : null
    const targets = idSet
      ? this.data.accounts.filter((a) => idSet.has(a.id))
      : this.data.accounts

    if (targets.length === 0) {
      return { pools: this.data.accountPools, accounts: this.data.accounts, poolCount: 0 }
    }

    const totalChunks = Math.ceil(targets.length / size)
    const now = Date.now()
    const cleanPrefix = (prefix || 'Kho Via').trim()

    for (let i = 0; i < totalChunks; i++) {
      const poolName = `${cleanPrefix} #${i + 1}`
      let pool = this.data.accountPools.find(
        (p) => p.name.toLowerCase() === poolName.toLowerCase()
      )
      if (!pool) {
        pool = {
          id: `pool-${now}-${i + 1}`,
          name: poolName,
          createdAt: now + i,
          updatedAt: now + i
        }
        this.data.accountPools.push(pool)
      }
      const slice = targets.slice(i * size, (i + 1) * size)
      for (const acc of slice) {
        acc.poolId = pool.id
      }
    }

    this.scheduleSave()
    return {
      pools: this.data.accountPools,
      accounts: this.data.accounts,
      poolCount: totalChunks
    }
  }

  // Accounts
  public getAccounts(): AccountProfile[] {
    return this.data.accounts
  }

  public getAccountById(id: string): AccountProfile | undefined {
    return this.data.accounts.find((a) => a.id === id)
  }

  /**
   * Resets videosToday to 0 for any account whose counter belongs to a past local day.
   * Returns true when at least one account was rolled over. Cheap no-op on the common path.
   */
  public rolloverDailyVideoCounts(): boolean {
    const today = localDayKey()
    let changed = false
    this.data.accounts = this.data.accounts.map((acc) => {
      let next = rolledOver(acc, today)
      if (
        next.status === 'quota_exhausted' &&
        next.creditsLeftDate !== today &&
        !/近\s*7\s*天|7[- ]day/i.test(next.statusMessage || '')
      ) {
        next = {
          ...next,
          status: 'ready',
          videosToday: 0,
          videosTodayDate: today,
          creditsLeft: undefined,
          creditsLeftDate: undefined,
          statusMessage: 'Sẵn sàng (Native Engine)'
        }
      }
      if (next !== acc) changed = true
      return next
    })
    if (changed) this.scheduleSave()
    return changed
  }

  public upsertAccount(account: AccountProfile): AccountProfile[] {
    const normalized: AccountProfile = {
      ...account,
      poolId: account.poolId || DEFAULT_ACCOUNT_POOL_ID
    }
    const idx = this.data.accounts.findIndex((a) => a.id === normalized.id)
    if (idx >= 0) {
      this.data.accounts[idx] = normalized
    } else {
      this.data.accounts.push(normalized)
    }
    this.scheduleSave()
    return this.data.accounts
  }

  public updateAccount(id: string, patch: Partial<AccountProfile>): AccountProfile | undefined {
    const idx = this.data.accounts.findIndex((a) => a.id === id)
    if (idx < 0) return undefined
    this.data.accounts[idx] = { ...this.data.accounts[idx], ...patch }
    this.scheduleSave()
    return this.data.accounts[idx]
  }

  public deleteAccount(id: string): AccountProfile[] {
    this.data.accounts = this.data.accounts.filter((a) => a.id !== id)
    this.scheduleSave()
    return this.data.accounts
  }

  // Static Proxies
  public getProxies(): ProxyEntry[] {
    return this.data.proxies
  }

  public setProxies(proxies: ProxyEntry[]): ProxyEntry[] {
    this.data.proxies = proxies
    this.scheduleSave()
    return this.data.proxies
  }

  public upsertProxy(proxy: ProxyEntry): ProxyEntry[] {
    const idx = this.data.proxies.findIndex((p) => p.id === proxy.id)
    if (idx >= 0) {
      this.data.proxies[idx] = proxy
    } else {
      this.data.proxies.push(proxy)
    }
    this.scheduleSave()
    return this.data.proxies
  }

  public deleteProxy(id: string): ProxyEntry[] {
    this.data.proxies = this.data.proxies.filter((p) => p.id !== id)
    // Unbind from accounts
    for (const acc of this.data.accounts) {
      if (acc.proxyId === id) acc.proxyId = undefined
    }
    this.scheduleSave()
    return this.data.proxies
  }

  // Rotating Proxies
  public getRotatingProxies(): RotatingProxyEntry[] {
    return this.data.rotatingProxies
  }

  public upsertRotatingProxy(entry: RotatingProxyEntry): RotatingProxyEntry[] {
    const idx = this.data.rotatingProxies.findIndex((r) => r.id === entry.id)
    if (idx >= 0) {
      this.data.rotatingProxies[idx] = entry
    } else {
      this.data.rotatingProxies.push(entry)
    }
    this.scheduleSave()
    return this.data.rotatingProxies
  }

  public deleteRotatingProxy(id: string): RotatingProxyEntry[] {
    this.data.rotatingProxies = this.data.rotatingProxies.filter((r) => r.id !== id)
    const rotKey = `rot:${id}`
    for (const acc of this.data.accounts) {
      if (acc.proxyId === rotKey) acc.proxyId = undefined
    }
    this.scheduleSave()
    return this.data.rotatingProxies
  }

  // Characters (@tag)
  public getCharacters(): CharacterEntry[] {
    return this.data.characters
  }

  public upsertCharacter(char: CharacterEntry): CharacterEntry[] {
    const cleanTag = char.tag.replace(/^@+/, '').trim().toLowerCase()
    const normalized: CharacterEntry = { ...char, tag: cleanTag }
    const idx = this.data.characters.findIndex((c) => c.id === normalized.id)
    if (idx >= 0) {
      this.data.characters[idx] = normalized
    } else {
      this.data.characters.unshift(normalized)
    }
    this.scheduleSave()
    return this.data.characters
  }

  public deleteCharacter(id: string): CharacterEntry[] {
    this.data.characters = this.data.characters.filter((c) => c.id !== id)
    this.scheduleSave()
    return this.data.characters
  }

  // Tasks
  public getTasks(): VideoTask[] {
    return this.data.tasks
  }

  public addTasks(newTasks: VideoTask[]): VideoTask[] {
    this.data.tasks.unshift(...newTasks)
    this.scheduleSave()
    return this.data.tasks
  }

  public updateTask(id: string, patch: Partial<VideoTask>): VideoTask | undefined {
    const idx = this.data.tasks.findIndex((t) => t.id === id)
    if (idx < 0) return undefined
    const prev = this.data.tasks[idx]
    this.data.tasks[idx] = {
      ...prev,
      ...patch,
      updatedAt: Date.now()
    }
    // Avoid disk writes on pure 5s polling elapsed-time text updates
    const keys = Object.keys(patch)
    const isPollingTickOnly =
      prev.status === 'polling' &&
      (patch.status === undefined || patch.status === 'polling') &&
      keys.every((k) => k === 'status' || k === 'progressText')
    if (!isPollingTickOnly) {
      this.scheduleSave()
    }
    return this.data.tasks[idx]
  }

  public deleteTask(id: string): VideoTask[] {
    this.data.tasks = this.data.tasks.filter((t) => t.id !== id)
    this.scheduleSave()
    return this.data.tasks
  }

  /** Remove a specific set of tasks by id (bulk delete of selected rows). */
  public deleteTasks(ids: string[]): VideoTask[] {
    const idSet = new Set(ids)
    this.data.tasks = this.data.tasks.filter((t) => !idSet.has(t.id))
    this.scheduleSave()
    return this.data.tasks
  }

  public clearFinishedTasks(): VideoTask[] {
    this.data.tasks = this.data.tasks.filter(
      (t) => t.status !== 'completed' && t.status !== 'cancelled' && t.status !== 'failed'
    )
    this.scheduleSave()
    return this.data.tasks
  }

  /** Remove only the error rows (failed + cancelled), keeping completed and active/queued tasks. */
  public clearFailedTasks(): VideoTask[] {
    this.data.tasks = this.data.tasks.filter(
      (t) => t.status !== 'failed' && t.status !== 'cancelled'
    )
    this.scheduleSave()
    return this.data.tasks
  }

  // Videos Library
  public getVideos(): VideoLibraryItem[] {
    return this.data.videos
  }

  public addVideo(video: VideoLibraryItem): VideoLibraryItem[] {
    const existingIdx = this.data.videos.findIndex(
      (v) => v.id === video.id || (video.localFile && v.localFile === video.localFile)
    )
    if (existingIdx >= 0) {
      this.data.videos[existingIdx] = video
    } else {
      this.data.videos.unshift(video)
    }
    this.scheduleSave()
    return this.data.videos
  }

  public updateVideo(idOrFile: string, patch: Partial<VideoLibraryItem>): VideoLibraryItem | undefined {
    const idx = this.data.videos.findIndex(
      (v) => v.id === idOrFile || (v.localFile && v.localFile === idOrFile)
    )
    if (idx < 0) return undefined
    this.data.videos[idx] = {
      ...this.data.videos[idx],
      ...patch
    }
    this.scheduleSave()
    return this.data.videos[idx]
  }

  public deleteVideo(id: string, removeFile = false): VideoLibraryItem[] {
    const item = this.data.videos.find((v) => v.id === id)
    if (item && removeFile && item.localFile && fs.existsSync(item.localFile)) {
      try {
        fs.unlinkSync(item.localFile)
      } catch {}
    }
    this.data.videos = this.data.videos.filter((v) => v.id !== id)
    this.scheduleSave()
    return this.data.videos
  }
}

export const store = new AppStore()

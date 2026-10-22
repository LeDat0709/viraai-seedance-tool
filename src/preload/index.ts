import { contextBridge, ipcRenderer } from 'electron'
import {
  AccountPoolEntry,
  AccountProfile,
  AppSettings,
  CharacterEntry,
  ProjectEntry,
  QueueSubmitPayload,
  RotatingProxyEntry
} from '../shared/types'

const api = {
  getState: () => ipcRenderer.invoke('state:get'),
  onStateUpdated: (callback: (state: any) => void) => {
    const listener = (_event: any, data: any) => callback(data)
    ipcRenderer.on('state:updated', listener)
    return () => ipcRenderer.removeListener('state:updated', listener)
  },

  // Settings & Dialogs
  updateSettings: (patch: Partial<AppSettings>) => ipcRenderer.invoke('settings:update', patch),
  selectFolder: () => ipcRenderer.invoke('dialog:select-folder'),
  selectImages: (multi = true) => ipcRenderer.invoke('dialog:select-images', multi),
  selectTextFile: () => ipcRenderer.invoke('dialog:select-text-file'),
  openPath: (targetPath: string) => ipcRenderer.invoke('shell:open-path', targetPath),
  showItemInFolder: (targetPath: string) => ipcRenderer.invoke('shell:show-item', targetPath),

  // Projects (Kho Video)
  saveProject: (project: ProjectEntry) => ipcRenderer.invoke('projects:save', project),
  deleteProject: (id: string) => ipcRenderer.invoke('projects:delete', id),

  // Account Pools (Kho Tài Khoản)
  saveAccountPool: (pool: AccountPoolEntry) => ipcRenderer.invoke('account-pools:save', pool),
  deleteAccountPool: (id: string) => ipcRenderer.invoke('account-pools:delete', id),
  assignAccountsToPool: (accountIds: string[], poolId: string) =>
    ipcRenderer.invoke('account-pools:assign', { accountIds, poolId }),
  autoSplitAccountsIntoPools: (payload: {
    poolSize: number
    prefix?: string
    accountIds?: string[]
  }) => ipcRenderer.invoke('account-pools:auto-split', payload),

  // Accounts
  addCookieAccount: (payload: {
    name: string
    cookie: string
    proxyId?: string
    poolId?: string
  }) => ipcRenderer.invoke('accounts:add-cookie', payload),
  importAccountsJsonFile: (payload?: { poolId?: string; proxyId?: string }) =>
    ipcRenderer.invoke('accounts:import-json-file', payload),
  addFacebookBatch: (payload: {
    rawLines: string
    autoLoginNow: boolean
    showWindow?: boolean
    proxyId?: string
    poolId?: string
    concurrency?: number
  }) => ipcRenderer.invoke('accounts:add-facebook-batch', payload),
  loginFacebookAccount: (accountId: string, showWindow = true) =>
    ipcRenderer.invoke('accounts:login-facebook', { accountId, showWindow }),
  loginAccountsBatch: (payload: {
    accountIds: string[]
    showWindow?: boolean
    concurrency?: number
  }) => ipcRenderer.invoke('accounts:login-batch', payload),
  addGoogleBatch: (payload: {
    rawLines: string
    autoLoginNow: boolean
    poolId?: string
    concurrency?: number
  }) => ipcRenderer.invoke('accounts:add-google-batch', payload),
  createManualAccount: (name: string, poolId?: string) =>
    ipcRenderer.invoke('accounts:create-manual', { name, poolId }),
  openAccountBrowser: (accountId: string) => ipcRenderer.invoke('accounts:open-browser', accountId),
  loginGoogleAccount: (accountId: string) => ipcRenderer.invoke('accounts:login-google', accountId),
  checkAccount: (accountId: string) => ipcRenderer.invoke('accounts:check-one', accountId),
  checkAllAccounts: (payload?: { accountIds?: string[]; concurrency?: number }) =>
    ipcRenderer.invoke('accounts:check-all', payload),
  recycleAccount: (accountId: string) => ipcRenderer.invoke('accounts:recycle-one', accountId),
  recycleAllExhausted: (payload?: { accountIds?: string[]; concurrency?: number }) =>
    ipcRenderer.invoke('accounts:recycle-all-exhausted', payload),
  updateAccount: (id: string, patch: Partial<AccountProfile>) =>
    ipcRenderer.invoke('accounts:update', { id, patch }),
  deleteAccount: (accountId: string) => ipcRenderer.invoke('accounts:delete', accountId),

  // Proxies
  addProxiesBatch: (rawLines: string, protocol: 'http' | 'socks5') =>
    ipcRenderer.invoke('proxies:add-batch', { rawLines, protocol }),
  checkProxy: (proxyId: string) => ipcRenderer.invoke('proxies:check-one', proxyId),
  checkAllProxies: () => ipcRenderer.invoke('proxies:check-all'),
  deleteProxy: (proxyId: string) => ipcRenderer.invoke('proxies:delete', proxyId),
  autoPairProxies: (options?: { poolId?: string; mode?: '1_to_1' | '1_per_pool' }) =>
    ipcRenderer.invoke('proxies:auto-pair', options),

  // Rotating Proxies & TopProxy.vn
  upsertRotatingProxy: (entry: RotatingProxyEntry) =>
    ipcRenderer.invoke('rotating-proxies:upsert', entry),
  addRotatingProxiesBatch: (payload: {
    rawKeys: string
    provider: RotatingProxyEntry['provider']
    protocol: 'http' | 'socks5'
    namePrefix?: string
    nhamang?: string
    tinhthanh?: string
  }) => ipcRenderer.invoke('rotating-proxies:add-batch', payload),
  rotateProxyKey: (id: string, force = true) =>
    ipcRenderer.invoke('rotating-proxies:rotate', { id, force }),
  rotateAllProxyKeys: (force = false) =>
    ipcRenderer.invoke('rotating-proxies:rotate-all', force),
  syncTopProxyAccount: (payload: {
    accountApiKey: string
    protocol: 'http' | 'socks5'
    nhamang?: string
    tinhthanh?: string
    syncRotating?: boolean
    syncStaticType?: string
  }) => ipcRenderer.invoke('topproxy:sync-account', payload),
  deleteRotatingProxy: (id: string) => ipcRenderer.invoke('rotating-proxies:delete', id),

  // Characters (@tag)
  upsertCharacter: (char: CharacterEntry) => ipcRenderer.invoke('characters:upsert', char),
  deleteCharacter: (id: string) => ipcRenderer.invoke('characters:delete', id),

  // Queue
  submitQueue: (payload: QueueSubmitPayload) => ipcRenderer.invoke('queue:submit', payload),
  retryTask: (taskId: string) => ipcRenderer.invoke('queue:retry-one', taskId),
  retryAllFailedTasks: () => ipcRenderer.invoke('queue:retry-all-failed'),
  cancelTask: (taskId: string) => ipcRenderer.invoke('queue:cancel-one', taskId),
  deleteTask: (taskId: string) => ipcRenderer.invoke('queue:delete-one', taskId),
  clearFinishedTasks: () => ipcRenderer.invoke('queue:clear-finished'),
  clearFailedTasks: () => ipcRenderer.invoke('queue:clear-failed'),
  retryTasks: (ids: string[]) => ipcRenderer.invoke('queue:retry-many', ids),
  recoverTask: (taskId: string): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke('queue:recover-one', taskId),
  editPromptAndRetry: (taskId: string, prompt: string): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke('queue:edit-prompt-retry', { taskId, prompt }),
  deleteTasks: (ids: string[]) => ipcRenderer.invoke('queue:delete-many', ids),
  setQueuePaused: (paused: boolean) => ipcRenderer.invoke('queue:set-paused', paused),

  // Library
  pullVideosFromAccount: (accountId: string) =>
    ipcRenderer.invoke('library:pull-from-account', accountId),
  pullVideosFromAllAccounts: () => ipcRenderer.invoke('library:pull-from-all'),
  upgradeWatermarkedVideos: (): Promise<{
    ok: boolean
    upgradedCount: number
    totalTargets: number
    message: string
  }> => ipcRenderer.invoke('library:upgrade-watermarked'),
  extractLastFrame: (videoFilePath: string) =>
    ipcRenderer.invoke('library:extract-last-frame', videoFilePath),
  deleteVideo: (id: string, removeFile: boolean) =>
    ipcRenderer.invoke('library:delete-video', { id, removeFile })
}

contextBridge.exposeInMainWorld('api', api)

export type ExposedViraApi = typeof api

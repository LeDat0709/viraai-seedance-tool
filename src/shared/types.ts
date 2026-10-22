export type AccountSourceType = 'cookie' | 'facebook' | 'google' | 'apple' | 'manual'

export type AccountHealthStatus =
  | 'unknown'
  | 'checking'
  | 'ready'
  | 'quota_exhausted'
  | 'expired'
  | 'recycling'
  | 'error'

export interface AccountPoolEntry {
  id: string
  name: string
  createdAt: number
  updatedAt: number
}

export interface AccountProfile {
  id: string
  name: string
  poolId?: string // ID of AccountPoolEntry ('pool-default' by default)
  email?: string
  password?: string
  fbUid?: string
  fbCookie?: string
  fbToken?: string
  twoFactorSecret?: string
  otpUrl?: string
  sourceType: AccountSourceType
  cookieHeader?: string
  partition: string
  enabled: boolean
  proxyId?: string // ID of static proxy or 'rot:<id>' for rotating proxy
  status: AccountHealthStatus
  statusMessage?: string
  userId?: string
  screenName?: string
  videosToday: number
  videosTodayDate?: string // local YYYY-MM-DD the videosToday counter belongs to
  creditsLeft?: number // video credits Dola last reported left for the day
  creditsLeftDate?: string // local YYYY-MM-DD creditsLeft belongs to
  totalVideos: number
  lastCheckedAt?: number
  lastRecycledAt?: number
  createdAt: number
}

export interface ProxyEntry {
  id: string
  raw: string
  protocol: 'http' | 'socks5'
  host: string
  port: number
  username?: string
  password?: string
  label?: string
  status: 'unknown' | 'checking' | 'alive' | 'dead'
  exitIp?: string
  latencyMs?: number
  errorMessage?: string
  lastCheckedAt?: number
}

export type RotatingProxyProvider =
  | 'topproxy'
  | 'tmproxy'
  | 'tinsoft'
  | 'kiotproxy'
  | 'wwproxy'
  | 'custom'

export interface RotatingProxyEntry {
  id: string
  name: string
  provider: RotatingProxyProvider
  apiKey: string
  customApiUrl?: string
  nhamang?: string // TopProxy: 'Random' | 'viettel' | 'fpt' | 'vnpt'
  tinhthanh?: string // TopProxy: '0' .. '31'
  isp?: string
  location?: string
  tokenExpiration?: string
  protocol: 'http' | 'socks5'
  currentProxy?: string // host:port:user:pass or http://...
  exitIp?: string
  nextRotateAt?: number
  status: 'unknown' | 'checking' | 'active' | 'cooldown' | 'expired' | 'error'
  statusMessage?: string
  lastRotatedAt?: number
}

export interface CharacterImage {
  path: string
  role: string // e.g., 'Chính diện', 'Góc nghiêng', 'Toàn thân', etc.
}

export interface CharacterEntry {
  id: string
  name: string
  tag: string // without @, e.g. 'linh' -> used as @linh
  description: string
  images: CharacterImage[]
  createdAt: number
}

export interface ReferenceImageInput {
  path: string
  name?: string
  role?: string
}

export type VideoAspectRatio = '9:16' | '16:9' | '21:9' | '4:3' | '1:1' | '3:4'
export type VideoDuration = 5 | 10 | 15 | 30
export type BatchAllocationMode = '20_per_acc' | '10_per_acc' | 'even_split'

export type TaskStatus =
  | 'queued'
  | 'preparing'
  | 'uploading'
  | 'submitting'
  | 'polling'
  | 'downloading'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface VideoTask {
  id: string
  projectId: string
  poolId?: string
  sequenceNumber: number
  prompt: string
  expandedPrompt?: string
  model: 'seedance_v2.5' | 'seedance_v2.0_fast'
  mode: 'text_to_video' | 'image_to_video'
  ratio: VideoAspectRatio
  duration: VideoDuration
  referenceImages: ReferenceImageInput[]
  assignedAccountId?: string
  assignedAccountName?: string
  assignedProxyId?: string
  assignedProxyLabel?: string
  conversationId?: string
  videoId?: string
  videoUrl?: string
  localFile?: string
  status: TaskStatus
  progressText?: string
  errorCode?: string
  errorMessage?: string
  retryCount: number
  busyRetryAt?: number // set once Dola Pro was overloaded: the single auto-retry waits until then, on the same account
  resumeAfterRestart?: boolean // interrupted while Dola rendered: rerun on the same account, collect that video, don't re-send
  recoverOnly?: boolean // "Lấy lại video": only collect from conversationId; never send a new prompt
  createdAt: number
  updatedAt: number
  finishedAt?: number
}

export interface VideoLibraryItem {
  id: string
  projectId?: string
  prompt: string
  ratio: VideoAspectRatio
  duration: number
  profileName: string
  localFile: string
  videoUrl?: string
  sizeBytes: number
  model: string
  createdAt: number
}

export interface ProjectEntry {
  id: string
  name: string
  outputDir: string
  defaultRatio: VideoAspectRatio
  defaultDuration: VideoDuration
  createdAt: number
  updatedAt: number
}

export interface AppSettings {
  dolaBaseUrl: string
  outputDir: string
  concurrency: number
  loginConcurrency?: number
  batchAllocationMode: BatchAllocationMode
  autoRecycleOnQuota: boolean
  preferProMode: boolean
  /** HTTP engine chat mode: 'fast' calls the video tool directly; 'pro' lets Dola's agent call it (default 'fast'). */
  httpChatMode?: 'fast' | 'pro'
  showBrowserDuringGen: boolean
  useHttpApiMode?: boolean
  pollTimeoutMinutes: number
  autoRemoveWatermark: boolean
  activeProjectId: string
  activePoolId?: string
}

export interface QueueSubmitPayload {
  projectId?: string
  poolId?: string
  prompts: string[]
  model: 'seedance_v2.5' | 'seedance_v2.0_fast'
  mode: 'text_to_video' | 'image_to_video'
  ratio: VideoAspectRatio
  duration: VideoDuration
  referenceImages: ReferenceImageInput[]
  selectedAccountIds?: string[]
}


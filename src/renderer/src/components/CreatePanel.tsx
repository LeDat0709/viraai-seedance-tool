import React, { useState, useRef, useEffect } from 'react'
import {
  Sparkles,
  Zap,
  Image as ImageIcon,
  FileText,
  Upload,
  Play,
  Pause,
  RotateCcw,
  Trash2,
  FolderOpen,
  FolderPlus,
  CheckCircle2,
  AlertCircle,
  AlertTriangle,
  Loader2,
  Plus,
  X,
  AtSign,
  Film,
  Scissors,
  ListChecks,
  Clock,
  Crop,
  Hourglass,
  Ban,
  Square,
  List,
  LayoutGrid,
  Table2,
  Shield,
  RefreshCw,
  Bug,
  Wand2,
  Activity
} from 'lucide-react'
import {
  ensureWebCrawlerInitialized,
  spiderCrawlAndClickRetry,
  spiderDoctorFixPrompts,
  spiderEnhancePrompts,
  spiderRewriteViolatedPrompt,
  spiderSplitIdeaToSeries,
  SpiderPromptStyle
} from '../utils/web-crawler-spider'
import { QueueGrid, QueueTable } from './QueueViews'
import { FailureActions } from './QueueViews'
import { ConnectionFlowGraph } from './ConnectionFlowGraph'
import {
  TASK_STEPS,
  cleanProgressText,
  errorLabelOf,
  DAILY_VIDEO_LIMIT_ESTIMATE,
  estimateCapacity,
  failureKindOf,
  findPromptRisk,
  groupFailures,
  localDayKeyOf,
  stepIndexOf
} from './queue-display'

/** A PRO_BUSY seen this recently means Dola is overloaded right now. */
const DOLA_BUSY_WINDOW_MS = 10 * 60_000
import {
  AccountPoolEntry,
  AccountProfile,
  AppSettings,
  BatchAllocationMode,
  CharacterEntry,
  ProjectEntry,
  ProxyEntry,
  ReferenceImageInput,
  RotatingProxyEntry,
  VideoAspectRatio,
  VideoDuration,
  VideoLibraryItem,
  VideoTask
} from '../../../shared/types'

interface CreatePanelProps {
  settings: AppSettings
  projects: ProjectEntry[]
  accountPools: AccountPoolEntry[]
  accounts: AccountProfile[]
  proxies: ProxyEntry[]
  rotatingProxies: RotatingProxyEntry[]
  characters: CharacterEntry[]
  tasks: VideoTask[]
  videos?: VideoLibraryItem[]
  queuePaused: boolean
  onOpenCharactersModal: () => void
  onSelectVideoPreview: (filePath: string, title: string) => void
  onOpenAccounts: () => void
}

const RATIOS: { value: VideoAspectRatio; desc: string }[] = [
  { value: '9:16', desc: 'Dọc TikTok / Reels' },
  { value: '16:9', desc: 'Ngang YouTube' },
  { value: '21:9', desc: 'Điện ảnh Cinema' },
  { value: '4:3', desc: 'Tiêu chuẩn' },
  { value: '1:1', desc: 'Vuông Feed IG' },
  { value: '3:4', desc: 'Chân dung Ads' }
]

const DURATIONS: { value: VideoDuration; desc: string }[] = [
  { value: 5, desc: 'Nhanh' },
  { value: 10, desc: 'Chuẩn Ads' },
  { value: 15, desc: 'Kể chuyện' },
  { value: 30, desc: 'Dài' }
]

const RUNNING_STATUSES = ['queued', 'preparing', 'uploading', 'submitting', 'polling', 'downloading']
const DEFAULT_POOL_ID = 'pool-default'
const poolOfAcc = (a: AccountProfile): string => a.poolId || DEFAULT_POOL_ID
const mediaUrl = (filePath: string, cacheKey?: number): string =>
  `viraai-media://local/${encodeURIComponent(filePath)}${cacheKey ? `?v=${cacheKey}` : ''}`

const isWatermarkedItem = (item: {
  id?: string
  videoId?: string
  videoUrl?: string
  sizeBytes?: number
  fileSizeBytes?: number
}): boolean => {
  const vid = String(item.id || item.videoId || '')
  const url = String(item.videoUrl || '')
  const sz = item.sizeBytes || item.fileSizeBytes || 0
  if (sz > 0 && sz < 3_600_000) return true
  if (/lr=unwatermarked|logo_type=unwatermarked/i.test(url) && !vid.startsWith('direct_')) return false
  if (/lr=video_gen_watermark|watermark_dyn|\/tos-[^/]*-ve-/i.test(url)) return true
  if (vid.startsWith('direct_')) return true
  return false
}

export const CreatePanel: React.FC<CreatePanelProps> = ({
  settings,
  projects,
  accountPools,
  accounts,
  proxies,
  rotatingProxies,
  characters,
  tasks,
  videos = [],
  queuePaused,
  onOpenCharactersModal,
  onSelectVideoPreview,
  onOpenAccounts
}) => {
  const [model, setModel] = useState<'seedance_v2.5' | 'seedance_v2.0_fast'>('seedance_v2.5')
  const [mode, setMode] = useState<'text_to_video' | 'image_to_video'>('text_to_video')
  const [promptText, setPromptText] = useState('')
  const [splitByLine, setSplitByLine] = useState(true)
  const [ratio, setRatio] = useState<VideoAspectRatio>('9:16')
  const [duration, setDuration] = useState<VideoDuration>(10)
  const [refImages, setRefImages] = useState<ReferenceImageInput[]>([])
  const [queueFilter, setQueueFilter] = useState<'all' | 'running' | 'completed' | 'failed'>('all')
  const [queueView, setQueueView] = useState<'list' | 'grid' | 'table' | 'flow'>('list')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [showNewProject, setShowNewProject] = useState(false)
  const [newProjName, setNewProjName] = useState('')
  const [bannerMsg, setBannerMsg] = useState<string | null>(null)
  const [applyingQueueProxy, setApplyingQueueProxy] = useState(false)
  const [upgradingNoLogo, setUpgradingNoLogo] = useState(false)
  const [spiderNote, setSpiderNote] = useState<string | null>(null)

  const watermarkedTotalCount = React.useMemo(() => {
    const wmVids = videos.filter((v) => isWatermarkedItem(v))
    const wmTasksOnly = tasks.filter(
      (t) =>
        t.status === 'completed' &&
        t.localFile &&
        isWatermarkedItem(t) &&
        !wmVids.some((v) => v.localFile === t.localFile)
    )
    return wmVids.length + wmTasksOnly.length
  }, [videos, tasks])

  const handleBatchUpgradeNoLogo = async () => {
    setUpgradingNoLogo(true)
    setSpiderHealLog('⚡ Đang xóa logo hàng loạt tốc độ cao (song song 5 luồng VOD lr=unwatermarked)…')
    try {
      const res = await window.api.upgradeWatermarkedVideos()
      setSpiderHealLog(res.message)
    } catch (err: any) {
      setSpiderHealLog(`Lỗi khi xóa logo hàng loạt: ${err?.message || String(err)}`)
    } finally {
      setUpgradingNoLogo(false)
    }
  }
  const [spiderAutoHeal, setSpiderAutoHeal] = useState<boolean>(() => {
    try {
      return localStorage.getItem('vira.spiderAutoHeal') !== 'false'
    } catch {
      return true
    }
  })
  const [spiderHealLog, setSpiderHealLog] = useState<string | null>(null)
  const spiderHealAttemptsRef = useRef<Map<string, number>>(new Map())
  const spiderHealingIdsRef = useRef<Set<string>>(new Set())
  const prevTaskStatusesRef = useRef<Map<string, string>>(new Map())

  const toggleSpiderAutoHeal = () => {
    setSpiderAutoHeal((prev) => {
      const next = !prev
      try {
        localStorage.setItem('vira.spiderAutoHeal', String(next))
      } catch {}
      return next
    })
  }

  const triggerSpiderHealForTask = (task: VideoTask, forceManual = false) => {
    if (spiderHealingIdsRef.current.has(task.id)) return
    const prevAttempts = spiderHealAttemptsRef.current.get(task.id) || 0
    if (!forceManual && prevAttempts >= 2) return

    const attempt = prevAttempts + 1
    spiderHealAttemptsRef.current.set(task.id, attempt)
    spiderHealingIdsRef.current.add(task.id)

    const { rewrittenPrompt, summary } = spiderRewriteViolatedPrompt(
      task.prompt,
      task.duration,
      task.errorMessage,
      attempt
    )

    const msg = `🕷️ Nhện AI đã tự sửa prompt vi phạm của Video #${task.sequenceNumber} (Lần ${attempt}: ${summary}) và nhấn Chạy lại!`
    setSpiderHealLog(msg)
    setSpiderNote(msg)

    spiderCrawlAndClickRetry(
      task.id,
      async () => {
        try {
          await window.api.editPromptAndRetry(task.id, rewrittenPrompt)
        } finally {
          spiderHealingIdsRef.current.delete(task.id)
        }
      },
      900
    )
  }

  // Tự động theo dõi các Task trong Hàng đợi: chỉ khi Task vừa chuyển sang failed do vi phạm chính sách trong phiên hiện tại -> Nhện bò tới sửa prompt & bấm thử lại!
  useEffect(() => {
    const prevMap = prevTaskStatusesRef.current
    const refusedToHeal: VideoTask[] = []

    for (const task of tasks) {
      const prevStatus = prevMap.get(task.id)
      const attempts = spiderHealAttemptsRef.current.get(task.id) || 0
      const isPolicyRefused = task.status === 'failed' && failureKindOf(task) === 'edit'

      if (
        spiderAutoHeal &&
        isPolicyRefused &&
        !spiderHealingIdsRef.current.has(task.id) &&
        prevStatus !== undefined &&
        prevStatus !== 'failed' &&
        attempts < 2
      ) {
        refusedToHeal.push(task)
      }
      prevMap.set(task.id, task.status)
    }

    if (refusedToHeal.length > 0) {
      refusedToHeal.forEach((task, idx) => {
        setTimeout(() => {
          triggerSpiderHealForTask(task, false)
        }, 400 + idx * 950)
      })
    }
  }, [tasks, spiderAutoHeal])

  const handleSpiderFixAllRefusedTasks = (refusedTasks: VideoTask[]) => {
    if (refusedTasks.length === 0) return
    refusedTasks.forEach((task, idx) => {
      setTimeout(() => {
        triggerSpiderHealForTask(task, true)
      }, idx * 750)
    })
  }

  const handleSpiderDoctorFix = () => {
    const api = ensureWebCrawlerInitialized()
    api.lureToElement(textareaRef.current)
    if (!promptText.trim()) {
      setSpiderNote('Nhện AI: Hãy nhập ý tưởng hoặc prompt trước để Nhện bắt bệnh & sửa lỗi nhé!')
      return
    }
    const { fixedText, changes } = spiderDoctorFixPrompts(promptText, duration)
    setPromptText(fixedText)
    if (changes.length > 0) {
      setSpiderNote(`Nhện AI đã sửa ${changes.length} điểm: ${changes.join(' · ')}`)
    } else {
      setSpiderNote(`Nhện AI: Prompt đã chuẩn thời lượng ${duration}s và an toàn chính sách Dola!`)
    }
  }

  const handleSpiderBoostStyle = (style: SpiderPromptStyle, label: string) => {
    const api = ensureWebCrawlerInitialized()
    api.lureToElement(textareaRef.current)
    const next = spiderEnhancePrompts(promptText, style, ratio, duration)
    setPromptText(next)
    setSpiderNote(`Nhện AI: Đã nâng cấp prompt theo chuẩn "${label}" (${ratio} · ${duration}s)!`)
  }

  const handleSpiderSplitSeries = () => {
    const api = ensureWebCrawlerInitialized()
    api.lureToElement(textareaRef.current)
    if (!promptText.trim()) {
      setSpiderNote('Nhện AI: Hãy nhập 1 câu ý tưởng gốc trước khi tách chuỗi 4 phân cảnh!')
      return
    }
    const next = spiderSplitIdeaToSeries(promptText, duration)
    setPromptText(next)
    setSplitByLine(true)
    setSpiderNote(`Nhện AI: Đã tách ý tưởng thành chuỗi 4 phân cảnh liên hoàn (${duration}s/cảnh) và giữ nguyên @nhân_vật!`)
  }

  // @tag autocomplete state
  const [tagSuggestOpen, setTagSuggestOpen] = useState(false)
  const [tagQuery, setTagQuery] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  const activeProject = projects.find((p) => p.id === settings.activeProjectId) || projects[0]
  const activePoolId = settings.activePoolId || 'all'
  const scopedAccounts =
    activePoolId === 'all'
      ? accounts
      : accounts.filter((a) => poolOfAcc(a) === activePoolId)
  const enabledAccounts = scopedAccounts.filter((a) => a.enabled)
  const readyAccounts = enabledAccounts.filter((a) => a.status === 'ready')
  const threadCount = settings.concurrency || 2
  const isShortOnAccounts = readyAccounts.length < threadCount
  const capacity = estimateCapacity(scopedAccounts, localDayKeyOf())
  const proxyAliveCount = rotatingProxies.filter((r) => r.status === 'active' || r.status === 'cooldown').length
  const isDolaBusy = tasks.some(
    (t) =>
      Date.now() - t.updatedAt < DOLA_BUSY_WINDOW_MS &&
      (t.errorCode === 'PRO_BUSY' || /710022002|quá tải/i.test(t.progressText || ''))
  )
  const pendingCount = tasks.filter((t) => RUNNING_STATUSES.includes(t.status)).length
  const healthTone: 'ok' | 'warn' | 'bad' =
    readyAccounts.length === 0 || proxyAliveCount === 0
      ? 'bad'
      : isShortOnAccounts || proxyAliveCount < threadCount || isDolaBusy
        ? 'warn'
        : 'ok'
  const failureGroups = groupFailures(tasks)
  const liveRotatingProxies = rotatingProxies.filter((r) => r.status !== 'expired')
  const proxiedReadyCount = readyAccounts.filter((a) => Boolean(a.proxyId)).length

  const formatRotatingEntry = (rot: RotatingProxyEntry): string => {
    const label = rot.name || `TopProxy (${rot.apiKey.slice(0, 6)}…)`
    const ipPart = rot.currentProxy
      ? rot.currentProxy.split(':').slice(0, 2).join(':')
      : rot.exitIp
    return ipPart ? `${label} · ${ipPart}` : `${label} (Key xoay)`
  }

  const formatProxyLabelById = (proxyId?: string): string | undefined => {
    if (!proxyId) return undefined
    if (proxyId.startsWith('rot:')) {
      const rotId = proxyId.slice(4)
      const rot = rotatingProxies.find((r) => r.id === rotId)
      if (!rot) return undefined
      return formatRotatingEntry(rot)
    }
    const stat = proxies.find((p) => p.id === proxyId)
    if (!stat) return undefined
    return `${stat.label || 'Proxy tĩnh'} · ${stat.host}:${stat.port}`
  }

  const resolveTaskProxyLabel = (task: VideoTask): string | undefined => {
    if (task.assignedAccountId) {
      const acc = accounts.find((a) => a.id === task.assignedAccountId)
      const liveFromAcc = formatProxyLabelById(acc?.proxyId)
      if (liveFromAcc) return liveFromAcc
    }
    if (task.assignedProxyId) {
      const liveFromTask = formatProxyLabelById(task.assignedProxyId)
      if (liveFromTask) return liveFromTask
    }
    if (task.assignedProxyLabel && !task.assignedProxyLabel.includes('undefined')) {
      return task.assignedProxyLabel
    }
    if (liveRotatingProxies.length > 0) {
      const fallback = liveRotatingProxies[(task.sequenceNumber - 1) % liveRotatingProxies.length]
      if (fallback) {
        return formatRotatingEntry(fallback)
      }
    }
    return undefined
  }

  const handleApplyAndRotateQueueProxies = async () => {
    setApplyingQueueProxy(true)
    try {
      const pairRes = await window.api.autoPairProxies({ poolId: activePoolId, mode: '1_to_1' })
      await window.api.rotateAllProxyKeys(true)
      setBannerMsg(
        pairRes.message ||
          `Đã gắn & xoay ${liveRotatingProxies.length} Key TopProxy cho các tài khoản trong Hàng đợi!`
      )
      setTimeout(() => setBannerMsg(null), 5000)
    } catch (err) {
      setBannerMsg(`Lỗi gắn proxy: ${(err as Error).message}`)
    } finally {
      setApplyingQueueProxy(false)
    }
  }

  const parsedPrompts = splitByLine
    ? promptText
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
    : promptText.trim()
      ? [promptText.trim()]
      : []
  const promptRisks = parsedPrompts
    .map((p, i) => ({ line: i + 1, reason: findPromptRisk(p) }))
    .filter((r): r is { line: number; reason: string } => Boolean(r.reason))

  const handlePromptChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value
    setPromptText(val)
    const cursor = e.target.selectionStart || 0
    const before = val.slice(0, cursor)
    const match = /@([a-zA-Z0-9_-]*)$/.exec(before)
    if (match && characters.length > 0) {
      setTagQuery(match[1].toLowerCase())
      setTagSuggestOpen(true)
    } else {
      setTagSuggestOpen(false)
    }
  }

  const insertCharacterTag = (char: CharacterEntry) => {
    if (!textareaRef.current) return
    const el = textareaRef.current
    const cursor = el.selectionStart || promptText.length
    const before = promptText.slice(0, cursor)
    const after = promptText.slice(cursor)
    const replacedBefore = before.replace(/@([a-zA-Z0-9_-]*)$/, `@${char.tag} `)
    setPromptText(replacedBefore + after)
    setTagSuggestOpen(false)
    setTimeout(() => el.focus(), 20)
  }

  const handleImportTxtFile = async () => {
    const res = await window.api.selectTextFile()
    if (!res?.content) return
    setPromptText((prev) => (prev.trim() ? `${prev.trim()}\n${res.content.trim()}` : res.content.trim()))
    setSplitByLine(true)
  }

  const handlePickImages = async () => {
    const paths = await window.api.selectImages(true)
    if (!paths || paths.length === 0) return
    setMode('image_to_video')
    setRefImages((prev) => {
      const existing = new Set(prev.map((i) => i.path))
      const added: ReferenceImageInput[] = []
      for (const p of paths) {
        if (!existing.has(p) && prev.length + added.length < 10) {
          const baseName = p.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '') || 'Ảnh tham chiếu'
          added.push({ path: p, name: baseName, role: 'Chính diện' })
        }
      }
      return [...prev, ...added].slice(0, 10)
    })
  }

  const handleSubmitQueue = async () => {
    if (parsedPrompts.length === 0) {
      setBannerMsg('Vui lòng nhập ít nhất 1 câu lệnh (prompt) để tạo video.')
      return
    }
    const res = await window.api.submitQueue({
      projectId: activeProject?.id,
      poolId: activePoolId,
      prompts: parsedPrompts,
      model,
      mode: refImages.length > 0 ? 'image_to_video' : mode,
      ratio,
      duration,
      referenceImages: refImages
    })
    if (res.ok) {
      setPromptText('')
      setBannerMsg(res.message)
      setTimeout(() => setBannerMsg(null), 4000)
    } else {
      setBannerMsg(res.message)
    }
  }

  const handleExtractFrameAndUse = async (videoFile: string) => {
    const res = await window.api.extractLastFrame(videoFile)
    if (res.ok && res.imagePath) {
      setMode('image_to_video')
      setRefImages((prev) => [
        { path: res.imagePath!, name: 'Khung cuối nối cảnh', role: 'Khung hình đầu' },
        ...prev.slice(0, 9)
      ])
      setBannerMsg('Đã trích khung cuối và gắn vào ô Ảnh tham chiếu để nối tiếp cảnh!')
      setTimeout(() => setBannerMsg(null), 4000)
    } else {
      setBannerMsg(res.message)
    }
  }

  const handleCreateProject = async () => {
    if (!newProjName.trim()) return
    const folder = (await window.api.selectFolder()) || settings.outputDir
    const newProj: ProjectEntry = {
      id: `proj-${Date.now()}`,
      name: newProjName.trim(),
      outputDir: folder,
      defaultRatio: ratio,
      defaultDuration: duration,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
    await window.api.saveProject(newProj)
    await window.api.updateSettings({ activeProjectId: newProj.id, outputDir: folder })
    setNewProjName('')
    setShowNewProject(false)
  }

  const filteredTasks = tasks.filter((t) => {
    if (queueFilter === 'running') return RUNNING_STATUSES.includes(t.status)
    if (queueFilter === 'completed') return t.status === 'completed'
    if (queueFilter === 'failed') return t.status === 'failed' || t.status === 'cancelled'
    return true
  })

  const runningCount = tasks.filter((t) => RUNNING_STATUSES.includes(t.status)).length
  const doneCount = tasks.filter((t) => t.status === 'completed').length
  const errorCount = tasks.filter((t) => t.status === 'failed' || t.status === 'cancelled').length

  const matchingCharacters = characters.filter(
    (c) => !tagQuery || c.tag.toLowerCase().includes(tagQuery) || c.name.toLowerCase().includes(tagQuery)
  )

  const sectionLabel =
    'text-[11px] font-semibold uppercase tracking-wider text-vira-muted flex items-center gap-1.5'
  const selectClass =
    'w-full h-8 pl-2.5 pr-7 rounded-lg bg-vira-bg text-white text-xs border border-vira-border appearance-none focus:outline-none focus:border-vira-accent'

  return (
    <div className="flex h-full w-full overflow-hidden">
      {/* ===== LEFT CONFIG PANEL ===== */}
      <aside className="w-[460px] min-w-[460px] h-full flex flex-col bg-vira-panel border-r border-vira-border">
        <div className="px-4 py-3 flex items-center justify-between border-b border-vira-border">
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-vira-accent" />
            <span className="font-bold text-sm tracking-tight">Cấu hình khởi tạo Video</span>
          </div>
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-vira-card text-vira-accent font-semibold">
            PIPELINE v2.5
          </span>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-5">
          {/* Project selector */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label className={sectionLabel}>
                <FolderOpen className="w-3.5 h-3.5 text-vira-accent" /> Dự án hiện tại
              </label>
              <button
                onClick={() => setShowNewProject((v) => !v)}
                className="text-[11px] text-vira-accent hover:underline flex items-center gap-0.5"
              >
                <Plus className="w-3 h-3" /> Dự án mới
              </button>
            </div>
            {showNewProject ? (
              <div className="flex items-center gap-1.5">
                <input
                  autoFocus
                  value={newProjName}
                  onChange={(e) => setNewProjName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleCreateProject()}
                  placeholder="Tên dự án mới…"
                  className="flex-1 h-9 px-3 rounded-lg bg-vira-bg border border-vira-border text-xs focus:outline-none focus:border-vira-accent"
                />
                <button
                  onClick={handleCreateProject}
                  className="h-9 px-3 rounded-lg bg-vira-accent text-[#0b1220] font-bold text-xs flex items-center gap-1"
                >
                  <FolderPlus className="w-4 h-4" /> Tạo
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-1.5">
                <select
                  value={activeProject?.id || ''}
                  onChange={(e) => {
                    const p = projects.find((x) => x.id === e.target.value)
                    if (p) window.api.updateSettings({ activeProjectId: p.id, outputDir: p.outputDir })
                  }}
                  className="flex-1 h-9 pl-3 pr-8 rounded-lg bg-vira-bg text-white text-xs border border-vira-border appearance-none focus:outline-none focus:border-vira-accent cursor-pointer"
                >
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <button
                  onClick={() => window.api.openPath(activeProject?.outputDir || settings.outputDir)}
                  title="Mở thư mục dự án"
                  className="w-9 h-9 flex items-center justify-center rounded-lg bg-vira-bg border border-vira-border text-vira-muted hover:text-vira-accent"
                >
                  <FolderOpen className="w-4 h-4" />
                </button>
              </div>
            )}
          </div>

          {/* Model + modality */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className={sectionLabel}>
                <Sparkles className="w-3.5 h-3.5 text-vira-accent" /> Mô hình Video AI (Dola / Cici)
              </label>
              <button
                onClick={onOpenAccounts}
                title={
                  isShortOnAccounts
                    ? `Chỉ ${readyAccounts.length} nick sẵn sàng cho ${threadCount} luồng — bấm để xem / làm mới nick`
                    : 'Bấm để mở Quản lý tài khoản'
                }
                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold border hover:brightness-125 ${
                  isShortOnAccounts
                    ? 'bg-amber-400/10 text-amber-400 border-amber-400/30'
                    : 'bg-vira-accent/10 text-vira-accent border-vira-accent/20'
                }`}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${isShortOnAccounts ? 'bg-amber-400' : 'bg-vira-accent'}`} />{' '}
                {readyAccounts.length}/{enabledAccounts.length} acc sẵn sàng
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {(
                [
                  { id: 'seedance_v2.5', icon: Sparkles, name: 'Seedance 2.5 Pro', desc: 'Chất lượng cao · 5s–30s' },
                  { id: 'seedance_v2.0_fast', icon: Zap, name: 'Seedance 2.0 Fast', desc: 'Tốc độ nhanh · 5s–15s' }
                ] as const
              ).map((m) => {
                const active = model === m.id
                const Icon = m.icon
                return (
                  <button
                    key={m.id}
                    onClick={() => setModel(m.id)}
                    className={`text-left p-2.5 rounded-xl border-2 transition-all ${
                      active ? 'bg-vira-card border-vira-accent' : 'bg-vira-bg border-vira-border hover:border-vira-muted'
                    }`}
                  >
                    <div className="flex items-center gap-1.5 mb-1">
                      <Icon className={`w-4 h-4 ${active ? 'text-vira-accent' : 'text-vira-muted'}`} />
                      <span className="font-semibold text-sm">{m.name}</span>
                    </div>
                    <p className="text-[11px] text-vira-muted">{m.desc}</p>
                  </button>
                )
              })}
            </div>
            <div className="flex p-0.5 rounded-lg bg-vira-bg border border-vira-border text-xs font-medium">
              <button
                onClick={() => setMode('text_to_video')}
                className={`flex-1 py-1.5 rounded-md flex items-center justify-center gap-1.5 ${
                  mode === 'text_to_video' && refImages.length === 0
                    ? 'bg-vira-card text-vira-accent font-semibold'
                    : 'text-vira-muted hover:text-white'
                }`}
              >
                <FileText className="w-3.5 h-3.5" /> Văn bản → Video
              </button>
              <button
                onClick={handlePickImages}
                className={`flex-1 py-1.5 rounded-md flex items-center justify-center gap-1.5 ${
                  refImages.length > 0 ? 'bg-vira-card text-vira-accent font-semibold' : 'text-vira-muted hover:text-white'
                }`}
              >
                <ImageIcon className="w-3.5 h-3.5" /> Ảnh tham chiếu ({refImages.length}/10)
              </button>
            </div>
            {refImages.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {refImages.map((img, i) => (
                  <span
                    key={img.path + i}
                    className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-lg bg-vira-bg border border-vira-border text-[10px] text-white"
                  >
                    <span className="truncate max-w-[90px]">{img.name}</span>
                    <button
                      onClick={() => setRefImages((prev) => prev.filter((_, idx) => idx !== i))}
                      className="text-vira-muted hover:text-rose-300"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* Prompt */}
          <div className="space-y-1.5 relative">
            <div className="flex items-center justify-between">
              <label className={sectionLabel}>
                <FileText className="w-3.5 h-3.5 text-vira-accent" /> Danh sách câu lệnh (Prompt)
              </label>
              <div className="flex items-center gap-1">
                <button
                  onClick={onOpenCharactersModal}
                  className="text-[10px] px-2 py-0.5 rounded bg-vira-card hover:text-vira-accent flex items-center gap-1"
                >
                  <AtSign className="w-3 h-3 text-vira-accent" /> Kho @nhân_vật ({characters.length})
                </button>
                <button
                  onClick={handleImportTxtFile}
                  className="text-[10px] px-2 py-0.5 rounded bg-vira-card hover:text-vira-accent flex items-center gap-1"
                >
                  <Upload className="w-3 h-3" /> Nhập .txt
                </button>
              </div>
            </div>
            <div className="rounded-xl bg-vira-bg border border-vira-border focus-within:border-vira-accent transition-colors">
              <textarea
                ref={textareaRef}
                value={promptText}
                onChange={handlePromptChange}
                rows={4}
                placeholder="Nhập một hoặc nhiều prompt (mỗi dòng một video)… Gõ @ để chèn nhân vật."
                className="w-full bg-transparent p-3 text-white text-xs leading-relaxed resize-none focus:outline-none placeholder:text-vira-muted/60"
              />
              <div className="flex items-center justify-between px-3 py-1.5 border-t border-vira-border text-[10px] text-vira-muted">
                <span>
                  Đã phân tách: <strong className="text-vira-accent">{parsedPrompts.length} dòng</strong> (
                  {parsedPrompts.length} video)
                </span>
                {promptText && (
                  <button onClick={() => setPromptText('')} className="hover:text-vira-accent flex items-center gap-0.5">
                    <Trash2 className="w-3 h-3" /> Xoá sạch
                  </button>
                )}
              </div>
            </div>

            {/* Trợ lý Nhện AI /[•]\ — Sửa Prompt, Nâng cấp Điện ảnh & Tách Chuỗi Phân cảnh */}
            <div className="rounded-xl bg-[#080e1a] border border-vira-accent/30 p-2 space-y-1.5">
              <div className="flex items-center justify-between gap-1">
                <span className="text-[10px] font-extrabold text-vira-accent flex items-center gap-1">
                  <Bug className="w-3 h-3" />
                  Trợ lý Nhện AI /[•]\ — Sửa & Nâng cấp Prompt
                </span>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={toggleSpiderAutoHeal}
                    title="Khi bật: Hễ có video nào bị Dola từ chối vì vi phạm chính sách / bản quyền / trẻ em, Con Nhện sẽ tự động bò sang thẻ lỗi, viết lại prompt an toàn và nhấn Chạy lại!"
                    className={`px-2 py-0.5 rounded-md text-[10px] font-bold transition flex items-center gap-1 border ${
                      spiderAutoHeal
                        ? 'bg-[#5cc8ff]/15 border-[#5cc8ff]/40 text-[#5cc8ff]'
                        : 'bg-vira-card border-vira-border text-vira-muted'
                    }`}
                  >
                    <Bug className="w-2.5 h-2.5" />
                    Tự sửa & Thử lại khi vi phạm: {spiderAutoHeal ? 'BẬT' : 'TẮT'}
                  </button>
                  <button
                    onClick={handleSpiderDoctorFix}
                    className="px-2 py-0.5 rounded-md bg-vira-accent text-[#0b1220] text-[10px] font-extrabold hover:opacity-90 transition flex items-center gap-1"
                    title="Tự động co mốc thời gian khớp số giây đã chọn, lọc từ nhạy cảm tránh Dola chặn và bỏ câu mở đầu thừa"
                  >
                    <Wand2 className="w-2.5 h-2.5" />
                    Bắt bệnh & Chuẩn hóa ({duration}s)
                  </button>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-1">
                <button
                  onClick={() => handleSpiderBoostStyle('cinematic', 'Điện ảnh 8K')}
                  className="px-2 py-1 rounded-lg bg-vira-card hover:bg-vira-accent/20 hover:text-vira-accent border border-vira-border text-[10px] font-semibold text-white transition"
                >
                  🎬 +Điện ảnh 8K
                </button>
                <button
                  onClick={() => handleSpiderBoostStyle('tiktok', 'TikTok Viral 9:16')}
                  className="px-2 py-1 rounded-lg bg-vira-card hover:bg-vira-accent/20 hover:text-vira-accent border border-vira-border text-[10px] font-semibold text-white transition"
                >
                  📱 +TikTok Viral
                </button>
                <button
                  onClick={() => handleSpiderBoostStyle('anime', 'Anime Shinkai 4K')}
                  className="px-2 py-1 rounded-lg bg-vira-card hover:bg-vira-accent/20 hover:text-vira-accent border border-vira-border text-[10px] font-semibold text-white transition"
                >
                  🌸 +Anime 4K
                </button>
                <button
                  onClick={() => handleSpiderBoostStyle('commercial', 'Quảng cáo TVC')}
                  className="px-2 py-1 rounded-lg bg-vira-card hover:bg-vira-accent/20 hover:text-vira-accent border border-vira-border text-[10px] font-semibold text-white transition"
                >
                  🛍️ +TVC Sản phẩm
                </button>
                <button
                  onClick={handleSpiderSplitSeries}
                  className="px-2 py-1 rounded-lg bg-vira-accent/15 hover:bg-vira-accent/25 border border-vira-accent/40 text-[10px] font-bold text-vira-accent transition"
                  title="Tách 1 câu ý tưởng thành chuỗi 4 phân cảnh liên hoàn (Toàn cảnh -> Trung cảnh -> Cận cảnh -> Kết cảnh) giữ nguyên @nhân_vật"
                >
                  🎞️ Tách chuỗi 4 cảnh
                </button>
              </div>
              {spiderNote && (
                <div className="flex items-center justify-between gap-2 text-[10px] text-emerald-300 bg-emerald-500/10 border border-emerald-500/25 rounded-lg px-2 py-1">
                  <span>{spiderNote}</span>
                  <button
                    onClick={() => setSpiderNote(null)}
                    className="text-vira-muted hover:text-white shrink-0"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              )}
            </div>
            {promptRisks.length > 0 && (
              <div className="rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-[11px] text-amber-300 space-y-0.5">
                {promptRisks.slice(0, 3).map((r) => (
                  <div key={r.line}>
                    Dòng {r.line}: {r.reason}
                  </div>
                ))}
                {promptRisks.length > 3 && <div>…và {promptRisks.length - 3} dòng khác.</div>}
              </div>
            )}
            <label className="flex items-center gap-2 cursor-pointer pt-0.5">
              <input
                type="checkbox"
                checked={splitByLine}
                onChange={(e) => setSplitByLine(e.target.checked)}
                className="w-3.5 h-3.5 rounded accent-vira-accent cursor-pointer"
              />
              <span className="text-[11px] text-vira-muted">Tách mỗi dòng thành 1 video riêng</span>
            </label>

            {tagSuggestOpen && matchingCharacters.length > 0 && (
              <div className="absolute z-20 left-0 right-0 mt-1 max-h-48 overflow-y-auto rounded-xl bg-vira-card border border-vira-border shadow-xl">
                {matchingCharacters.slice(0, 8).map((c) => (
                  <button
                    key={c.id}
                    onClick={() => insertCharacterTag(c)}
                    className="w-full text-left px-3 py-2 hover:bg-vira-bg flex items-center gap-2"
                  >
                    <AtSign className="w-3.5 h-3.5 text-vira-accent" />
                    <span className="text-xs font-semibold text-white">@{c.tag}</span>
                    <span className="text-[11px] text-vira-muted truncate">{c.name}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Duration */}
          <div className="space-y-1.5">
            <label className={sectionLabel}>
              <Clock className="w-3.5 h-3.5 text-vira-accent" /> Thời lượng video
            </label>
            <div className="grid grid-cols-4 gap-2">
              {DURATIONS.map((d) => {
                const active = duration === d.value
                return (
                  <button
                    key={d.value}
                    onClick={() => setDuration(d.value)}
                    className={`py-2 rounded-lg border text-center transition-all ${
                      active ? 'bg-vira-card border-2 border-vira-accent' : 'bg-vira-bg border-vira-border hover:border-vira-muted'
                    }`}
                  >
                    <span className={`block font-bold text-sm ${active ? 'text-vira-accent' : 'text-white'}`}>
                      {d.value}s
                    </span>
                    <span className="block text-[9px] text-vira-muted">{d.desc}</span>
                  </button>
                )
              })}
            </div>
          </div>

          {/* Ratio */}
          <div className="space-y-1.5">
            <label className={sectionLabel}>
              <Crop className="w-3.5 h-3.5 text-vira-accent" /> Tỷ lệ khung hình
            </label>
            <div className="grid grid-cols-3 gap-2">
              {RATIOS.map((r) => {
                const active = ratio === r.value
                return (
                  <button
                    key={r.value}
                    onClick={() => setRatio(r.value)}
                    className={`p-2 rounded-xl border flex flex-col items-center justify-center transition-all ${
                      active ? 'bg-vira-card border-2 border-vira-accent' : 'bg-vira-bg border-vira-border hover:border-vira-muted'
                    }`}
                  >
                    <span className={`text-sm font-bold ${active ? 'text-vira-accent' : 'text-white'}`}>{r.value}</span>
                    <span className="text-[10px] text-vira-muted">{r.desc}</span>
                  </button>
                )
              })}
            </div>
          </div>

          {/* Allocation + concurrency (no recycle toggle) */}
          <div className="space-y-2 pt-1 border-t border-vira-border">
            <label className={sectionLabel}>
              <ListChecks className="w-3.5 h-3.5 text-vira-accent" /> Cấu hình phân phối &amp; luồng chạy
            </label>
            <div className="space-y-1">
              <span className="text-[11px] text-vira-muted">Kho tài khoản sử dụng (Pool)</span>
              <select
                value={activePoolId}
                onChange={(e) => window.api.updateSettings({ activePoolId: e.target.value })}
                className={selectClass}
              >
                <option value="all">
                  Tất cả kho tài khoản (
                  {accounts.filter((a) => a.enabled && a.status === 'ready').length}/
                  {accounts.filter((a) => a.enabled).length} acc sẵn sàng)
                </option>
                {accountPools.map((pool) => {
                  const inPool = accounts.filter((a) => poolOfAcc(a) === pool.id)
                  const readyInPool = inPool.filter((a) => a.enabled && a.status === 'ready').length
                  return (
                    <option key={pool.id} value={pool.id}>
                      {pool.name} ({readyInPool}/{inPool.length} acc)
                    </option>
                  )
                })}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <span className="text-[11px] text-vira-muted">Chia lô tài khoản</span>
                <select
                  value={settings.batchAllocationMode}
                  onChange={(e) =>
                    window.api.updateSettings({ batchAllocationMode: e.target.value as BatchAllocationMode })
                  }
                  className={selectClass}
                >
                  <option value="20_per_acc">20 video / 1 tài khoản</option>
                  <option value="10_per_acc">10 video / 1 tài khoản</option>
                  <option value="even_split">Chia đều xoay vòng (không trần)</option>
                </select>
              </div>
              <div className="space-y-1">
                <span className="text-[11px] text-vira-muted">Số luồng song song</span>
                <select
                  value={settings.concurrency}
                  onChange={(e) => window.api.updateSettings({ concurrency: Number(e.target.value) })}
                  className={selectClass}
                >
                  {[1, 2, 3, 4, 5, 6, 8].map((n) => (
                    <option key={n} value={n}>
                      {n} luồng cùng lúc
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="space-y-1 pt-1">
              <span className="text-[11px] text-vira-muted">Cơ chế khởi tạo (Engine Mode)</span>
              <select
                value={settings.useHttpApiMode !== false ? 'http_api' : 'browser'}
                onChange={(e) => {
                  const isHttp = e.target.value === 'http_api'
                  window.api.updateSettings({
                    useHttpApiMode: isHttp,
                    ...(isHttp ? { showBrowserDuringGen: false } : {})
                  })
                }}
                className={selectClass}
              >
                <option value="http_api">
                  ⚡ HTTP API trực tiếp (Không mở Chrome · Giải mã AES-128-CBC không logo)
                </option>
                <option value="browser">
                  🌐 Trình duyệt tự động (Mở khoá DolaX 30s + UI Automation)
                </option>
              </select>
            </div>
            <div className="p-2.5 rounded-xl bg-vira-card/70 border border-emerald-500/25 space-y-2 mt-1">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-semibold text-emerald-300 flex items-center gap-1.5">
                  <Shield className="w-3.5 h-3.5 text-emerald-400" />
                  Proxy áp dụng cho Hàng đợi
                </span>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 font-semibold">
                  {liveRotatingProxies.length} Key xoay sống · {proxiedReadyCount}/{readyAccounts.length} acc đã gắn
                </span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] text-vira-muted truncate">
                  Tự động gắn &amp; chuyển sang Key sống khi chạy tác vụ
                </span>
                <button
                  type="button"
                  onClick={handleApplyAndRotateQueueProxies}
                  disabled={applyingQueueProxy}
                  className="h-7 px-2.5 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/30 text-emerald-300 text-[10px] font-semibold flex items-center gap-1 shrink-0 transition"
                >
                  <RefreshCw className={`w-3 h-3 ${applyingQueueProxy ? 'animate-spin' : ''}`} />
                  {applyingQueueProxy ? 'Đang gắn & xoay…' : 'Gắn & Xoay Proxy'}
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Footer CTA */}
        <div className="p-4 border-t border-vira-border">
          {bannerMsg && (
            <div className="mb-2 p-2 rounded-lg bg-vira-accent/10 border border-vira-accent/30 text-[11px] text-vira-accent">
              {bannerMsg}
            </div>
          )}
          <button
            onClick={handleSubmitQueue}
            disabled={parsedPrompts.length === 0}
            className="w-full h-11 rounded-xl bg-vira-accent text-[#0b1220] font-bold text-sm flex items-center justify-center gap-2 hover:bg-vira-accentHover active:scale-[0.99] transition-all disabled:opacity-40"
          >
            <Sparkles className="w-5 h-5" />
            Tạo {parsedPrompts.length > 0 ? `${parsedPrompts.length} ` : ''}Video{' '}
            {model === 'seedance_v2.5' ? 'Seedance 2.5 Pro' : 'Seedance 2.0 Fast'}
          </button>
        </div>
      </aside>

      {/* ===== RIGHT QUEUE PANEL ===== */}
      <section className="flex-1 h-full flex flex-col bg-vira-bg min-w-0">
        {/* Health bar: what will limit this run, before pressing Tạo */}
        <div
          className={`px-5 py-1.5 flex items-center gap-x-4 gap-y-1 flex-wrap text-[11px] font-semibold border-b ${
            healthTone === 'bad'
              ? 'bg-rose-500/10 border-rose-500/30 text-rose-300'
              : healthTone === 'warn'
                ? 'bg-amber-400/10 border-amber-400/30 text-amber-300'
                : 'bg-vira-accent/5 border-vira-border text-vira-accent'
          }`}
        >
          <button onClick={onOpenAccounts} className="hover:underline">
            {readyAccounts.length} nick sống / {threadCount} luồng
          </button>
          <span>
            {proxyAliveCount}/{rotatingProxies.length} proxy sống
          </span>
          {isDolaBusy && <span>⚠ Dola đang quá tải</span>}
          <span
            className="font-normal text-vira-muted"
            title={`Dola báo: ${capacity.knownCredits} lượt. ${capacity.unknownAccounts} nick chưa báo được ước tính ${DAILY_VIDEO_LIMIT_ESTIMATE} video/ngày trừ số đã làm hôm nay.`}
          >
            Hôm nay còn ~{capacity.estimatedCredits} lượt (ước tính)
            {pendingCount > 0 && ` · ${pendingCount} video đang chờ`}
            {capacity.estimatedCredits > pendingCount && (
              <span className="text-amber-300">
                {` · thêm ${capacity.estimatedCredits - pendingCount} prompt để dùng hết lượt`}
              </span>
            )}
          </span>
        </div>
        <div className="min-h-14 px-5 py-2 flex items-center justify-between border-b border-vira-border gap-3 flex-wrap">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <Film className="w-5 h-5 text-vira-accent" />
              <span className="font-bold text-base">Hàng đợi tạo Video</span>
              <span className="text-[11px] px-2 py-0.5 rounded-full bg-vira-card text-vira-muted font-semibold">
                {tasks.length} tác vụ
              </span>
              <span
                className="text-[11px] px-2 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/25 text-emerald-300 font-semibold flex items-center gap-1"
                title="Tất cả tác vụ trong hàng đợi đều được định tuyến qua Proxy xoay đã gắn"
              >
                <Shield className="w-3 h-3" />
                Proxy: {liveRotatingProxies.length} Key xoay đang bật
              </span>
            </div>
            <div className="flex items-center gap-1">
              {(
                [
                  ['all', `Tất cả (${tasks.length})`],
                  ['running', `Đang chạy (${runningCount})`],
                  ['completed', `Hoàn tất (${doneCount})`],
                  ['failed', `Lỗi (${errorCount})`]
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setQueueFilter(key)}
                  className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold ${
                    queueFilter === key ? 'bg-vira-card text-vira-accent' : 'text-vira-muted hover:text-white hover:bg-vira-card'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center p-0.5 rounded-lg bg-vira-bg border border-vira-border">
              {(
                [
                  ['list', 'Danh sách', List],
                  ['grid', 'Lưới', LayoutGrid],
                  ['table', 'Bảng', Table2],
                  ['flow', 'Luồng kết nối (LIVE)', Activity]
                ] as const
              ).map(([key, label, Icon]) => (
                <button
                  key={key}
                  onClick={() => setQueueView(key)}
                  title={label}
                  aria-label={label}
                  aria-pressed={queueView === key}
                  className={`h-7 px-2 flex items-center justify-center gap-1 rounded-md text-[11px] font-semibold ${
                    queueView === key
                      ? key === 'flow'
                        ? 'bg-[#19160e] text-[#eac54f] border border-[#d4af37]/50'
                        : 'bg-vira-card text-vira-accent'
                      : 'text-vira-muted hover:text-white'
                  }`}
                >
                  <Icon className={`w-4 h-4 ${key === 'flow' ? 'text-[#eac54f]' : ''}`} />
                  {key === 'flow' && <span>Luồng kết nối</span>}
                </button>
              ))}
            </div>
            <button
              onClick={handleBatchUpgradeNoLogo}
              disabled={upgradingNoLogo}
              title="Quét song song và thay thế toàn bộ video còn dính logo bằng bản gốc Không Logo (lr=unwatermarked) từ Dola"
              className={`h-8 px-3 rounded-lg font-bold text-xs flex items-center gap-1.5 disabled:opacity-50 transition-colors ${
                watermarkedTotalCount > 0
                  ? 'bg-amber-500 hover:bg-amber-400 text-[#0b1220] shadow-md shadow-amber-500/20'
                  : 'bg-vira-card border border-vira-accent/40 text-vira-accent hover:bg-vira-accent/15'
              }`}
            >
              <Sparkles className={`w-3.5 h-3.5 ${upgradingNoLogo ? 'animate-spin' : ''}`} />
              {upgradingNoLogo
                ? 'Đang xóa logo nhanh…'
                : watermarkedTotalCount > 0
                  ? `✨ Xóa logo hàng loạt (${watermarkedTotalCount})`
                  : '✨ Xóa logo hàng loạt'}
            </button>
            <button
              onClick={() => window.api.setQueuePaused(!queuePaused)}
              className="h-8 px-2.5 rounded-lg bg-vira-card border border-vira-border hover:border-vira-accent text-xs flex items-center gap-1.5"
            >
              {queuePaused ? (
                <>
                  <Play className="w-3.5 h-3.5 text-vira-accent" /> Tiếp tục
                </>
              ) : (
                <>
                  <Pause className="w-3.5 h-3.5 text-amber-400" /> Tạm dừng
                </>
              )}
            </button>
            <button
              onClick={() => window.api.retryAllFailedTasks()}
              className="h-8 px-2.5 rounded-lg bg-vira-card border border-vira-border hover:border-vira-accent text-xs flex items-center gap-1.5"
            >
              <RotateCcw className="w-3.5 h-3.5 text-vira-accent" /> Chạy lại lỗi
            </button>
            <button
              onClick={() => window.api.clearFailedTasks()}
              title="Xóa toàn bộ dòng lỗi & đã huỷ (giữ lại video đã xong)"
              className="h-8 px-2.5 rounded-lg bg-vira-card border border-vira-border hover:border-rose-500/50 text-xs flex items-center gap-1.5"
            >
              <Trash2 className="w-3.5 h-3.5 text-rose-400" /> Xóa lỗi
            </button>
            <button
              onClick={() => window.api.clearFinishedTasks()}
              className="h-8 px-2.5 rounded-lg bg-vira-card border border-vira-border hover:border-vira-accent text-xs flex items-center gap-1.5"
            >
              <Trash2 className="w-3.5 h-3.5 text-vira-muted" /> Dọn mục xong
            </button>
          </div>
        </div>

        {queueView === 'list' && filteredTasks.length > 0 && (
          <div className="flex items-center gap-2 px-5 py-2 border-b border-vira-border bg-vira-bg/40 text-xs">
            <label className="flex items-center gap-1.5 cursor-pointer text-vira-muted hover:text-white">
              <input
                type="checkbox"
                checked={filteredTasks.every((t) => selectedIds.has(t.id))}
                onChange={(e) =>
                  setSelectedIds(e.target.checked ? new Set(filteredTasks.map((t) => t.id)) : new Set())
                }
                className="w-4 h-4 accent-vira-accent cursor-pointer"
              />
              Chọn tất cả
            </label>
            {selectedIds.size > 0 && (
              <>
                <span className="font-semibold text-vira-accent">Đã chọn {selectedIds.size}</span>
                <button
                  onClick={() => {
                    window.api.retryTasks([...selectedIds])
                    setSelectedIds(new Set())
                  }}
                  className="h-7 px-2.5 rounded-lg bg-vira-card border border-vira-border hover:border-vira-accent flex items-center gap-1.5"
                >
                  <RotateCcw className="w-3.5 h-3.5 text-vira-accent" /> Chạy lại
                </button>
                <button
                  onClick={() => {
                    window.api.deleteTasks([...selectedIds])
                    setSelectedIds(new Set())
                  }}
                  className="h-7 px-2.5 rounded-lg bg-rose-500/10 text-rose-300 hover:bg-rose-500/20 flex items-center gap-1.5"
                >
                  <Trash2 className="w-3.5 h-3.5" /> Xóa
                </button>
                <button
                  onClick={() => setSelectedIds(new Set())}
                  className="ml-auto text-vira-muted hover:text-white"
                >
                  Bỏ chọn
                </button>
              </>
            )}
          </div>
        )}

        {/* Failed tasks grouped by fix, one button per group */}
        {failureGroups.recover.length + failureGroups.edit.length + failureGroups.retry.length > 0 && (
          <div className="px-5 py-2 border-b border-vira-border flex items-center gap-2 flex-wrap text-[11px]">
            <span className="text-vira-muted">Lỗi:</span>
            {failureGroups.retry.length > 0 && (
              <button
                onClick={() => window.api.retryTasks(failureGroups.retry.map((t) => t.id))}
                className="h-7 px-2.5 rounded-lg bg-vira-card border border-vira-border hover:border-vira-accent flex items-center gap-1.5"
              >
                <RotateCcw className="w-3.5 h-3.5 text-vira-accent" /> {failureGroups.retry.length} task quá tải / lỗi nick, proxy → Chạy lại
              </button>
            )}
            {failureGroups.recover.length > 0 && (
              <button
                onClick={async () => {
                  const results = await Promise.all(failureGroups.recover.map((t) => window.api.recoverTask(t.id)))
                  const failedMsgs = results.filter((r) => !r.ok).map((r) => r.message)
                  if (failedMsgs.length > 0) window.alert([...new Set(failedMsgs)].join('\n'))
                }}
                title="Đã gửi tới Dola nhưng hết thời gian chờ — vào lại hội thoại để tải video, không gửi lại lệnh"
                className="h-7 px-2.5 rounded-lg bg-vira-card border border-vira-border hover:border-vira-accent flex items-center gap-1.5"
              >
                <RotateCcw className="w-3.5 h-3.5 text-vira-accent" /> {failureGroups.recover.length} task hết thời gian chờ → Lấy lại video
              </button>
            )}
            {failureGroups.edit.length > 0 && (
              <>
                <button
                  onClick={() => handleSpiderFixAllRefusedTasks(failureGroups.edit)}
                  title="Con Nhện AI sẽ tự động bò tới từng task bị từ chối, viết lại prompt khử vi phạm và nhấn Chạy lại!"
                  className="h-7 px-2.5 rounded-lg bg-[#5cc8ff]/15 border border-[#5cc8ff]/40 text-[#5cc8ff] hover:bg-[#5cc8ff]/25 font-bold flex items-center gap-1.5"
                >
                  <Bug className="w-3.5 h-3.5" /> 🕷️ Nhện tự sửa & Thử lại ({failureGroups.edit.length} task bị từ chối)
                </button>
                <button
                  onClick={() => {
                    setQueueFilter('failed')
                    setQueueView('list')
                  }}
                  title="Bấm 'Sửa tay' trên từng thẻ"
                  className="h-7 px-2.5 rounded-lg bg-amber-400/10 border border-amber-400/30 text-amber-300 flex items-center gap-1.5"
                >
                  Xem {failureGroups.edit.length} task từ chối
                </button>
              </>
            )}
          </div>
        )}

        {spiderHealLog && (
          <div className="px-5 py-2 border-b border-[#5cc8ff]/30 bg-[#5cc8ff]/10 flex items-center justify-between gap-2 text-xs text-[#5cc8ff]">
            <span className="font-semibold flex items-center gap-1.5">
              <Bug className="w-4 h-4 shrink-0" />
              {spiderHealLog}
            </span>
            <button onClick={() => setSpiderHealLog(null)} className="text-vira-muted hover:text-white">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-5 space-y-3">
          {queueView === 'flow' ? (
            <ConnectionFlowGraph
              accounts={accounts}
              tasks={tasks}
              accountPools={accountPools}
              activePoolId={settings.activePoolId}
              compact
            />
          ) : filteredTasks.length === 0 ? (
            <div className="py-24 text-center text-vira-muted">
              <Film className="w-12 h-12 mx-auto mb-3 opacity-35" />
              <p className="text-sm">Hàng đợi trống. Nhập câu lệnh bên trái và bấm Tạo Video.</p>
            </div>
          ) : queueView === 'grid' ? (
            <QueueGrid
              tasks={filteredTasks}
              onPreview={onSelectVideoPreview}
              resolveProxyLabel={resolveTaskProxyLabel}
              onUpgradeNoLogo={handleBatchUpgradeNoLogo}
              upgradingNoLogo={upgradingNoLogo}
            />
          ) : queueView === 'table' ? (
            <QueueTable
              tasks={filteredTasks}
              onPreview={onSelectVideoPreview}
              resolveProxyLabel={resolveTaskProxyLabel}
              onUpgradeNoLogo={handleBatchUpgradeNoLogo}
              upgradingNoLogo={upgradingNoLogo}
            />
          ) : (
            filteredTasks.map((task, idx) => {
              const running = RUNNING_STATUSES.includes(task.status)
              const done = task.status === 'completed'
              const failed = task.status === 'failed' || task.status === 'cancelled'
              const proxyLabel = resolveTaskProxyLabel(task)
              const shouldMountVideoTag = done && Boolean(task.localFile) && idx < 10
              return (
                <div
                  key={task.id}
                  data-task-id={task.id}
                  className="p-3.5 rounded-2xl bg-vira-panel border border-vira-border relative overflow-hidden"
                >
                  <div
                    className={`absolute left-0 top-0 bottom-0 w-1 ${
                      done ? 'bg-vira-accent' : failed ? 'bg-rose-400' : 'bg-vira-accent/60'
                    }`}
                  />
                  <div className="flex items-start gap-4 pl-1.5">
                    {/* Thumbnail / placeholder */}
                    <div className="relative w-20 h-28 rounded-xl overflow-hidden bg-vira-bg flex-shrink-0 border border-vira-border flex items-center justify-center">
                      {shouldMountVideoTag ? (
                        <video
                          src={mediaUrl(task.localFile!, task.fileSizeBytes || task.updatedAt)}
                          className="w-full h-full object-cover cursor-pointer"
                          preload="metadata"
                          muted
                          onClick={() => onSelectVideoPreview(task.localFile!, `Video #${task.sequenceNumber}`)}
                        />
                      ) : done && task.localFile ? (
                        <button
                          type="button"
                          onClick={() => onSelectVideoPreview(task.localFile!, `Video #${task.sequenceNumber}`)}
                          className="w-full h-full flex flex-col items-center justify-center gap-1 bg-vira-card/60 hover:bg-vira-card text-vira-accent transition-colors"
                          title="Bấm để phát video"
                        >
                          <Play className="w-6 h-6 fill-current" />
                          <span className="text-[9px] font-bold text-white">Xem MP4</span>
                        </button>
                      ) : failed ? (
                        <div className="flex flex-col items-center text-rose-300 px-1 text-center" title={task.errorMessage}>
                          <AlertCircle className="w-7 h-7" />
                          <span className="text-[9px] mt-1 font-semibold">{errorLabelOf(task)}</span>
                        </div>
                      ) : (
                        <div className="flex flex-col items-center text-vira-muted">
                          <Loader2 className="w-6 h-6 animate-spin text-vira-accent" />
                          <span className="text-[9px] mt-1 font-semibold text-white">
                            {stepIndexOf(task.status) < 0 ? 'Chờ lượt' : TASK_STEPS[stepIndexOf(task.status)]}
                          </span>
                        </div>
                      )}
                    </div>

                    {/* Body */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <label className="flex items-center gap-2 min-w-0 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={selectedIds.has(task.id)}
                            onChange={(e) =>
                              setSelectedIds((prev) => {
                                const next = new Set(prev)
                                if (e.target.checked) next.add(task.id)
                                else next.delete(task.id)
                                return next
                              })
                            }
                            className="w-4 h-4 shrink-0 accent-vira-accent cursor-pointer"
                          />
                          <span className="font-semibold text-sm text-white truncate">
                            VIDEO #{task.sequenceNumber}
                          </span>
                        </label>
                        <span
                          className={`px-2 py-0.5 rounded-full text-[11px] font-semibold flex items-center gap-1 ${
                            done
                              ? task.errorMessage
                                ? 'bg-amber-400/10 text-amber-400'
                                : 'bg-vira-accent/10 text-vira-accent'
                              : failed
                                ? 'bg-rose-500/10 text-rose-300'
                                : 'bg-vira-accent/10 text-vira-accent'
                          }`}
                        >
                          {done ? (
                            <CheckCircle2 className="w-3.5 h-3.5" />
                          ) : failed ? (
                            <Ban className="w-3.5 h-3.5" />
                          ) : (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          )}
                          {done ? 'Sẵn sàng' : failed ? 'Thất bại' : 'Đang xử lý'}
                        </span>
                      </div>

                      <div className="flex items-center gap-1.5 flex-wrap mt-1 text-[10px]">
                        <span className="px-1.5 py-0.5 rounded bg-vira-card text-white">
                          {task.ratio} · {task.duration}s
                        </span>
                        <span className="px-1.5 py-0.5 rounded bg-vira-card text-vira-accent">
                          {task.model === 'seedance_v2.5' ? 'Seedance 2.5 Pro' : 'Seedance 2.0 Fast'}
                        </span>
                        {task.assignedAccountName && (
                          <span className="text-vira-muted">Acc: {task.assignedAccountName}</span>
                        )}
                        {proxyLabel && (
                          <span
                            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/25 text-emerald-300 font-medium"
                            title={`Proxy đang áp dụng: ${proxyLabel}`}
                          >
                            <Shield className="w-3 h-3 shrink-0" />
                            <span>Proxy: {proxyLabel}</span>
                          </span>
                        )}
                      </div>

                      <p className="text-xs text-vira-muted line-clamp-1 mt-1.5">{task.prompt}</p>

                      <div className="flex items-center justify-between gap-2 mt-2 pt-2 border-t border-vira-border">
                        <span
                          className={`text-[11px] flex items-center gap-1 min-w-0 ${
                            done
                              ? task.errorMessage
                                ? 'text-amber-400'
                                : 'text-vira-accent'
                              : failed
                                ? 'text-rose-300'
                                : 'text-vira-muted'
                          }`}
                        >
                          {done && task.errorMessage ? (
                            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                          ) : done ? (
                            <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                          ) : failed ? (
                            <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                          ) : (
                            <Hourglass className="w-3.5 h-3.5 shrink-0" />
                          )}
                          <span className="truncate" title={task.errorMessage || task.progressText}>
                            {cleanProgressText(task.errorMessage || task.progressText) ||
                              (done ? 'Đã tải video thành công' : '')}
                          </span>
                        </span>

                        {done ? (
                          <button
                            onClick={() => onSelectVideoPreview(task.localFile!, `Video #${task.sequenceNumber}`)}
                            className="h-6 px-2.5 rounded-md bg-vira-accent text-[#0b1220] text-[10px] font-bold flex items-center gap-1 shrink-0"
                          >
                            <Play className="w-3 h-3 fill-current" /> Xem video
                          </button>
                        ) : failed ? (
                          <div className="shrink-0 max-w-[60%]">
                            <FailureActions task={task} />
                          </div>
                        ) : null}
                      </div>
                    </div>

                    {/* Side actions */}
                    <div className="flex flex-col items-center gap-1 pl-2 border-l border-vira-border">
                      {done ? (
                        <>
                          <button
                            onClick={() => handleExtractFrameAndUse(task.localFile!)}
                            title="Trích khung cuối nối cảnh"
                            className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-vira-card text-vira-muted hover:text-vira-accent"
                          >
                            <Scissors className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => window.api.showItemInFolder(task.localFile!)}
                            title="Mở thư mục"
                            className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-vira-card text-vira-muted hover:text-white"
                          >
                            <FolderOpen className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => window.api.deleteTask(task.id)}
                            title="Xoá tác vụ"
                            className="w-7 h-7 flex items-center justify-center rounded-lg bg-rose-500/10 text-rose-300 hover:bg-rose-500/20"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </>
                      ) : running ? (
                        <button
                          onClick={() => window.api.cancelTask(task.id)}
                          title="Dừng tác vụ"
                          className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-vira-card text-vira-muted hover:text-rose-300"
                        >
                          <Square className="w-4 h-4" />
                        </button>
                      ) : (
                        <button
                          onClick={() => window.api.deleteTask(task.id)}
                          title="Xoá tác vụ"
                          className="w-7 h-7 flex items-center justify-center rounded-lg bg-rose-500/10 text-rose-300 hover:bg-rose-500/20"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              )
            })
          )}
        </div>

        <div className="h-9 px-5 border-t border-vira-border flex items-center justify-between text-[11px] font-mono text-vira-muted">
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-vira-accent" />
            {runningCount} đang chạy · {doneCount} xong · {errorCount} lỗi
          </span>
          <span className="truncate max-w-[50%]">Thư mục: {activeProject?.outputDir || settings.outputDir}</span>
        </div>
      </section>
    </div>
  )
}

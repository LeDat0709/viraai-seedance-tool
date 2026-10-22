import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Cpu,
  Eye,
  EyeOff,
  Film,
  Power,
  Shield,
  Sparkles,
  Users,
  Zap
} from 'lucide-react'
import { AccountPoolEntry, AccountProfile, VideoTask } from '../../../shared/types'

interface ConnectionFlowGraphProps {
  accounts: AccountProfile[]
  tasks: VideoTask[]
  accountPools?: AccountPoolEntry[]
  activePoolId?: string
  compact?: boolean
}

interface Stage {
  key: string
  label: string
  shortLabel: string
  color: string
  glow: string
  badgeBg: string
  /** 'in' = request flows account → hub, 'out' = video flows hub → account */
  dir: 'in' | 'out'
}

const STAGES: Record<string, Stage> = {
  preparing: {
    key: 'preparing',
    label: 'Khởi tạo phiên',
    shortLabel: 'Chuẩn bị',
    color: '#f5c451',
    glow: 'rgba(245, 196, 81, 0.45)',
    badgeBg: 'rgba(245, 196, 81, 0.14)',
    dir: 'in'
  },
  uploading: {
    key: 'uploading',
    label: 'Đang tải ảnh lên',
    shortLabel: 'Tải ảnh',
    color: '#fbbf24',
    glow: 'rgba(251, 191, 36, 0.5)',
    badgeBg: 'rgba(251, 191, 36, 0.16)',
    dir: 'in'
  },
  submitting: {
    key: 'submitting',
    label: 'Đang gửi request',
    shortLabel: 'Gửi lệnh',
    color: '#ffd166',
    glow: 'rgba(255, 209, 102, 0.55)',
    badgeBg: 'rgba(255, 209, 102, 0.16)',
    dir: 'in'
  },
  polling: {
    key: 'polling',
    label: 'Đang dựng video',
    shortLabel: 'Đang dựng',
    color: '#38bdf8',
    glow: 'rgba(56, 189, 248, 0.5)',
    badgeBg: 'rgba(56, 189, 248, 0.15)',
    dir: 'in'
  },
  downloading: {
    key: 'downloading',
    label: 'Đang tải bản không logo',
    shortLabel: 'Tải về',
    color: '#34d399',
    glow: 'rgba(52, 211, 153, 0.55)',
    badgeBg: 'rgba(52, 211, 153, 0.15)',
    dir: 'out'
  }
}

const SIMULATED_STAGE = STAGES.submitting
const LEGEND = [
  { label: 'Gửi request', color: '#ffd166' },
  { label: 'Đang dựng video (AI)', color: '#38bdf8' },
  { label: 'Tải video Không Logo', color: '#34d399' },
  { label: 'Sẵn sàng', color: '#c9a23f' },
  { label: 'Đã tắt / Hết lượt', color: '#e11d48' }
]

const PAGE_SIZE = 8
const TICK_MS = 1000
const BANNER_EVERY_TICKS = 4

interface NodeSlotConfig {
  id: string
  xPct: number
  yPct: number
  side: 'top' | 'bottom' | 'left' | 'right'
  /** Offset in pixels from hub center where this wire docks onto the hub border */
  hubDx: number
  hubDy: number
  /** Offset in pixels from card center where the wire leaves the card edge */
  cardDx: number
  cardDy: number
}

/**
 * 8 symmetric slots around the central hub with dedicated docking ports on the hub perimeter
 * so wires never pinch together at a single point.
 */
const NODE_SLOTS: NodeSlotConfig[] = [
  {
    id: 'top',
    xPct: 50,
    yPct: 12.5,
    side: 'top',
    hubDx: 0,
    hubDy: -108,
    cardDx: 0,
    cardDy: 41
  },
  {
    id: 'left-top',
    xPct: 14.5,
    yPct: 27,
    side: 'left',
    hubDx: -106,
    hubDy: -44,
    cardDx: 124,
    cardDy: 6
  },
  {
    id: 'left-mid',
    xPct: 14.5,
    yPct: 50,
    side: 'left',
    hubDx: -106,
    hubDy: 0,
    cardDx: 124,
    cardDy: 0
  },
  {
    id: 'left-bot',
    xPct: 14.5,
    yPct: 73,
    side: 'left',
    hubDx: -106,
    hubDy: 44,
    cardDx: 124,
    cardDy: -6
  },
  {
    id: 'bottom',
    xPct: 50,
    yPct: 87.5,
    side: 'bottom',
    hubDx: 0,
    hubDy: 108,
    cardDx: 0,
    cardDy: -41
  },
  {
    id: 'right-top',
    xPct: 85.5,
    yPct: 27,
    side: 'right',
    hubDx: 106,
    hubDy: -44,
    cardDx: -124,
    cardDy: 6
  },
  {
    id: 'right-mid',
    xPct: 85.5,
    yPct: 50,
    side: 'right',
    hubDx: 106,
    hubDy: 0,
    cardDx: -124,
    cardDy: 0
  },
  {
    id: 'right-bot',
    xPct: 85.5,
    yPct: 73,
    side: 'right',
    hubDx: 106,
    hubDy: 44,
    cardDx: -124,
    cardDy: -6
  }
]

/** Smooth S-curve between card terminal (sx, sy) and hub port (tx, ty). */
function buildPortWirePath(
  sx: number,
  sy: number,
  tx: number,
  ty: number,
  side: NodeSlotConfig['side']
): string {
  if (side === 'left' || side === 'right') {
    const dx = tx - sx
    const c1x = sx + dx * 0.46
    const c2x = sx + dx * 0.58
    return `M ${sx} ${sy} C ${c1x} ${sy}, ${c2x} ${ty}, ${tx} ${ty}`
  }
  const dy = ty - sy
  const c1y = sy + dy * 0.45
  const c2y = sy + dy * 0.55
  return `M ${sx} ${sy} C ${sx} ${c1y}, ${tx} ${c2y}, ${tx} ${ty}`
}

function formatElapsed(ms: number): string {
  const s = Math.max(1, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/**
 * Formats an account identifier into the sleek `har***@***` masked style (or full name when unmasked).
 */
export function formatFlowAccountLabel(acc: AccountProfile, masked: boolean): string {
  if (!masked) {
    return acc.name || acc.screenName || acc.email || acc.fbUid || 'Account'
  }
  const email = (acc.email || '').trim()
  if (email && email.includes('@')) {
    const prefix = email.split('@')[0].slice(0, 3).toLowerCase()
    return `${prefix.padEnd(3, '*')}***@***`
  }
  const raw = (acc.screenName || acc.name || acc.fbUid || 'user')
    .replace(/^(?:FB|Via|Clone)\s+/i, '')
    .trim()
  if (/^\d{8,}$/.test(raw)) {
    return `fb${raw.slice(-3)}***@***`
  }
  const clean = raw.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()
  const prefix = (clean.slice(0, 3) || 'acc').padEnd(3, '*')
  return `${prefix}***@***`
}

/**
 * Deterministic score/counter for the right side of each node card (matches the `537`, `482`, `159` style).
 */
function getAccountScoreBadge(acc: AccountProfile): number {
  if (typeof acc.totalVideos === 'number' && acc.totalVideos > 0) {
    return acc.totalVideos
  }
  if (typeof acc.videosToday === 'number' && acc.videosToday > 0) {
    return acc.videosToday
  }
  if (typeof acc.creditsLeft === 'number' && acc.creditsLeft > 0) {
    return acc.creditsLeft
  }
  let hash = 0
  const seed = acc.id || acc.name || 'acc'
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) & 0x7fffffff
  }
  return (hash % 490) + 45
}

function idleSubtitle(acc: AccountProfile): string {
  if (!acc.enabled) return 'Đã tắt'
  switch (acc.status) {
    case 'ready':
      return 'Sẵn sàng'
    case 'quota_exhausted':
      return 'Hết lượt hôm nay'
    case 'expired':
      return 'Hết phiên đăng nhập'
    case 'checking':
    case 'recycling':
      return 'Đang làm mới lượt…'
    default:
      return 'Đã tắt'
  }
}

function useElementSize(ref: React.RefObject<HTMLDivElement>): { w: number; h: number } {
  const [size, setSize] = useState({ w: 0, h: 0 })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => {
      setSize({ w: entry.contentRect.width, h: entry.contentRect.height })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return size
}

export const ConnectionFlowGraph: React.FC<ConnectionFlowGraphProps> = ({
  accounts,
  tasks,
  accountPools = [],
  activePoolId = 'all',
  compact = false
}) => {
  const [selectedPool, setSelectedPool] = useState<string>(activePoolId || 'all')
  const [maskedMode, setMaskedMode] = useState<boolean>(true)
  const [pageIndex, setPageIndex] = useState<number>(0)
  const [simulatedAccId, setSimulatedAccId] = useState<string | null>(null)
  const [now, setNow] = useState<number>(Date.now())
  const canvasRef = useRef<HTMLDivElement>(null)
  const { w, h } = useElementSize(canvasRef)

  // Track when each task first entered an active state so the elapsed timer counts continuously (never resets on 5s poll)
  const taskStartTimesRef = useRef<Map<string, number>>(new Map())

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(timer)
  }, [])

  const activeTaskByAccount = useMemo(() => {
    const map = new Map<string, VideoTask>()
    const currentNow = Date.now()
    for (const t of tasks) {
      if (STAGES[t.status] && t.assignedAccountId && !map.has(t.assignedAccountId)) {
        map.set(t.assignedAccountId, t)
        if (!taskStartTimesRef.current.has(t.id)) {
          taskStartTimesRef.current.set(t.id, currentNow)
        }
      }
    }
    return map
  }, [tasks])

  const stageCounts = useMemo(() => {
    const counts = { in: 0, render: 0, out: 0 }
    for (const t of activeTaskByAccount.values()) {
      if (t.status === 'polling') counts.render++
      else if (t.status === 'downloading') counts.out++
      else counts.in++
    }
    return counts
  }, [activeTaskByAccount])

  const completedTodayCount = useMemo(
    () => tasks.filter((t) => t.status === 'completed').length,
    [tasks]
  )

  const queuedCount = useMemo(
    () => tasks.filter((t) => t.status === 'queued').length,
    [tasks]
  )

  // Filter by pool, active accounts first so live connections are always on page 1
  const sortedAccounts = useMemo(() => {
    const filtered =
      selectedPool === 'all'
        ? accounts
        : accounts.filter((a) => (a.poolId || 'pool-default') === selectedPool)

    return [...filtered].sort((a, b) => {
      const aActive = activeTaskByAccount.has(a.id) || simulatedAccId === a.id ? 1 : 0
      const bActive = activeTaskByAccount.has(b.id) || simulatedAccId === b.id ? 1 : 0
      if (aActive !== bActive) return bActive - aActive

      const aReady = a.enabled && a.status === 'ready' ? 1 : 0
      const bReady = b.enabled && b.status === 'ready' ? 1 : 0
      if (aReady !== bReady) return bReady - aReady

      return (b.totalVideos || 0) - (a.totalVideos || 0)
    })
  }, [accounts, selectedPool, activeTaskByAccount, simulatedAccId])

  const totalPages = Math.max(1, Math.ceil(sortedAccounts.length / PAGE_SIZE))
  const safePageIndex = Math.min(pageIndex, totalPages - 1)
  const pageAccounts = sortedAccounts.slice(
    safePageIndex * PAGE_SIZE,
    safePageIndex * PAGE_SIZE + PAGE_SIZE
  )

  const activeAccountsList = useMemo(() => {
    const realActive = sortedAccounts.filter((a) => activeTaskByAccount.has(a.id))
    if (realActive.length > 0) return realActive
    const sim = simulatedAccId ? sortedAccounts.find((a) => a.id === simulatedAccId) : undefined
    return sim ? [sim] : []
  }, [sortedAccounts, activeTaskByAccount, simulatedAccId])

  const bannerIndex = Math.floor(now / (TICK_MS * BANNER_EVERY_TICKS))
  const featuredActiveAcc =
    activeAccountsList.length > 0 ? activeAccountsList[bannerIndex % activeAccountsList.length] : null
  const featuredActiveLabel = featuredActiveAcc
    ? formatFlowAccountLabel(featuredActiveAcc, maskedMode)
    : null
  const featuredTask = featuredActiveAcc ? activeTaskByAccount.get(featuredActiveAcc.id) : undefined
  const featuredStage = featuredActiveAcc
    ? STAGES[featuredTask?.status ?? ''] ?? SIMULATED_STAGE
    : null

  const readyTotalCount = sortedAccounts.filter((a) => a.enabled && a.status === 'ready').length
  const isLive = activeAccountsList.length > 0

  const handleToggleAccountEnabled = async (acc: AccountProfile, e: React.MouseEvent) => {
    e.stopPropagation()
    await window.api.updateAccount(acc.id, { enabled: !acc.enabled })
  }

  const handleSimulateBeam = () => {
    if (simulatedAccId) {
      setSimulatedAccId(null)
      return
    }
    const candidate = pageAccounts.find((a) => a.enabled && a.status === 'ready') || pageAccounts[0]
    if (candidate) setSimulatedAccId(candidate.id)
  }

  // Resolved view-model per visible slot, with exact port docking coordinates
  const nodes = NODE_SLOTS.map((slot, idx) => {
    const acc = pageAccounts[idx]
    if (!acc) return null
    const task = activeTaskByAccount.get(acc.id)
    const stage = task ? STAGES[task.status] : simulatedAccId === acc.id ? SIMULATED_STAGE : null
    const isReady = acc.enabled && acc.status === 'ready'
    const cardCenterX = (slot.xPct / 100) * w
    const cardCenterY = (slot.yPct / 100) * h
    const sx = cardCenterX + slot.cardDx
    const sy = cardCenterY + slot.cardDy
    const tx = w / 2 + slot.hubDx
    const ty = h / 2 + slot.hubDy
    const path = buildPortWirePath(sx, sy, tx, ty, slot.side)
    return { slot, acc, task, stage, isReady, sx, sy, tx, ty, path }
  })

  return (
    <div className="w-full select-none space-y-4">
      <style>{`
        @keyframes viraFlowDash { from { stroke-dashoffset: 48; } to { stroke-dashoffset: 0; } }
        @keyframes viraFlowDashRev { from { stroke-dashoffset: 0; } to { stroke-dashoffset: 48; } }
        @keyframes viraSpinSlow { to { transform: rotate(360deg); } }
        @keyframes viraSpinRev { to { transform: rotate(-360deg); } }
        @keyframes viraScan { 0% { transform: translateX(-110%); } 100% { transform: translateX(260%); } }
        @keyframes viraPulseRing {
          0% { transform: translate(-50%, -50%) scale(0.92); opacity: 0.55; }
          70% { transform: translate(-50%, -50%) scale(1.38); opacity: 0; }
          100% { transform: translate(-50%, -50%) scale(1.38); opacity: 0; }
        }
        @keyframes viraHubAura {
          0%, 100% { box-shadow: 0 0 45px rgba(234,197,79,0.22), 0 0 90px rgba(234,197,79,0.08), inset 0 0 22px rgba(234,197,79,0.1); }
          50% { box-shadow: 0 0 70px rgba(245,196,81,0.42), 0 0 120px rgba(56,189,248,0.14), inset 0 0 32px rgba(245,196,81,0.18); }
        }
        .vira-beam-in { animation: viraFlowDash 0.95s linear infinite; }
        .vira-beam-out { animation: viraFlowDashRev 0.95s linear infinite; }
        .vira-hub-live { animation: viraHubAura 3.2s ease-in-out infinite; }
        .vira-ring-cw { animation: viraSpinSlow 18s linear infinite; }
        .vira-ring-ccw { animation: viraSpinRev 12s linear infinite; }
        .vira-shockwave { animation: viraPulseRing 2.8s cubic-bezier(0.16, 1, 0.3, 1) infinite; }
        .vira-scan { animation: viraScan 1.5s ease-in-out infinite; }
      `}</style>

      {/* Main Cyber-Gold Topology Panel */}
      <div
        className="rounded-3xl border border-[#332917] p-5 shadow-[0_20px_70px_rgba(0,0,0,0.85)] relative overflow-hidden"
        style={{
          background: 'linear-gradient(180deg, #12100b 0%, #0b0a07 100%)'
        }}
      >
        {/* Ambient Top Highlight Line */}
        <div
          className="pointer-events-none absolute top-0 left-1/4 right-1/4 h-[1px]"
          style={{
            background:
              'linear-gradient(90deg, transparent, rgba(245, 196, 81, 0.65), transparent)'
          }}
        />

        {/* Header Row */}
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <div className="flex items-center gap-3.5">
            <div className="w-10 h-10 rounded-2xl bg-gradient-to-br from-[#f5c451]/25 to-[#b58e2a]/10 border border-[#f5c451]/40 flex items-center justify-center shadow-[0_0_20px_rgba(245,196,81,0.2)]">
              <Activity className="w-5 h-5 text-[#f5c451]" />
            </div>
            <div>
              <div className="flex items-center gap-2.5">
                <h2 className="text-xl font-black text-[#faf4e6] tracking-tight">
                  Luồng kết nối
                </h2>
                {isLive && (
                  <span className="text-[11px] font-extrabold px-2.5 py-0.5 rounded-full bg-gradient-to-r from-[#f5c451]/20 to-[#38bdf8]/15 text-[#ffd166] border border-[#f5c451]/45 shadow-[0_0_15px_rgba(245,196,81,0.2)]">
                    ⚡ {activeAccountsList.length} LUỒNG ĐANG TRUYỀN
                  </span>
                )}
              </div>
              <p className="text-xs text-[#9c9078] mt-0.5">
                Trạng thái cập nhật trực tiếp thời gian thực từ Seedance Engine và Account Pool.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            {accountPools.length > 0 && (
              <select
                value={selectedPool}
                onChange={(e) => {
                  setSelectedPool(e.target.value)
                  setPageIndex(0)
                }}
                className="h-8 px-3 rounded-xl bg-[#17140d] border border-[#3a301c] text-xs font-medium text-[#e6dbc4] focus:outline-none focus:border-[#f5c451]"
              >
                <option value="all">Tất cả kho ({accounts.length} nick)</option>
                {accountPools.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            )}

            <button
              onClick={() => setMaskedMode((v) => !v)}
              title={maskedMode ? 'Hiện tên đầy đủ của tài khoản' : 'Ẩn tên dạng har***@***'}
              className="h-8 px-3 rounded-xl bg-[#17140d] border border-[#3a301c] hover:border-[#f5c451]/60 text-xs font-medium text-[#e6dbc4] flex items-center gap-1.5 transition"
            >
              {maskedMode ? (
                <Eye className="w-3.5 h-3.5 text-[#f5c451]" />
              ) : (
                <EyeOff className="w-3.5 h-3.5 text-[#f5c451]" />
              )}
              {maskedMode ? 'Dạng ẩn (***)' : 'Tên đầy đủ'}
            </button>

            {activeTaskByAccount.size === 0 && (
              <button
                onClick={handleSimulateBeam}
                title="Mô phỏng hiệu ứng truyền Request trực tiếp từ tài khoản tới trung tâm"
                className={`h-8 px-3 rounded-xl border text-xs font-bold flex items-center gap-1.5 transition ${
                  simulatedAccId
                    ? 'bg-[#f5c451]/20 border-[#f5c451] text-[#ffd166] shadow-[0_0_16px_rgba(245,196,81,0.25)]'
                    : 'bg-[#17140d] border-[#3a301c] hover:border-[#f5c451]/60 text-[#e6dbc4]'
                }`}
              >
                <Zap className="w-3.5 h-3.5 text-[#f5c451]" />
                {simulatedAccId ? 'Đang mô phỏng' : 'Test hiệu ứng'}
              </button>
            )}

            {totalPages > 1 && (
              <div className="flex items-center gap-1 bg-[#17140d] border border-[#3a301c] rounded-xl px-2 h-8 text-xs text-[#e6dbc4]">
                <button
                  onClick={() => setPageIndex((p) => Math.max(0, p - 1))}
                  disabled={safePageIndex === 0}
                  className="p-0.5 hover:text-[#f5c451] disabled:opacity-30"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <span className="px-1.5 font-bold tabular-nums text-[#f5c451]">
                  {safePageIndex + 1}
                  <span className="text-[#8c826d] font-normal">/{totalPages}</span>
                </span>
                <button
                  onClick={() => setPageIndex((p) => Math.min(totalPages - 1, p + 1))}
                  disabled={safePageIndex >= totalPages - 1}
                  className="p-0.5 hover:text-[#f5c451] disabled:opacity-30"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            )}

            <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-[#1b170e] border border-[#4a3c1f] shadow-inner">
              <span
                className={`w-2.5 h-2.5 rounded-full ${
                  isLive
                    ? 'bg-[#f5c451] shadow-[0_0_10px_#f5c451] animate-pulse'
                    : 'bg-[#10b981] shadow-[0_0_8px_#10b981]'
                }`}
              />
              <span className="text-[11px] font-black tracking-widest text-[#f5c451]">
                LIVE
              </span>
            </div>
          </div>
        </div>

        {/* Interactive Topology Canvas */}
        <div
          ref={canvasRef}
          className={`relative w-full ${
            compact ? 'h-[500px]' : 'h-[580px]'
          } rounded-2xl border border-[#2b2315] bg-[#080705] overflow-hidden`}
          style={{
            backgroundImage: [
              'radial-gradient(circle at 50% 50%, rgba(245,196,81,0.16) 0%, rgba(56,189,248,0.05) 28%, rgba(8,7,5,0) 68%)',
              'linear-gradient(to right, rgba(212,175,55,0.03) 1px, transparent 1px)',
              'linear-gradient(to bottom, rgba(212,175,55,0.03) 1px, transparent 1px)'
            ].join(', '),
            backgroundSize: '100% 100%, 36px 36px, 36px 36px'
          }}
        >
          {/* Top-Left Legend Pill */}
          <div className="absolute top-3.5 left-4 z-20 flex flex-wrap items-center gap-3.5 px-3.5 py-1.5 rounded-full bg-[#12100b]/90 border border-[#2c2416] backdrop-blur-md text-[11px] text-[#b5a990]">
            {LEGEND.map((s) => (
              <span key={s.label} className="flex items-center gap-1.5 font-medium">
                <span
                  className="w-2 h-2 rounded-full"
                  style={{ background: s.color, boxShadow: `0 0 8px ${s.color}` }}
                />
                {s.label}
              </span>
            ))}
          </div>

          {/* Top-Right Pool Capacity Pill */}
          <div className="absolute top-3.5 right-4 z-20 hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-full bg-[#12100b]/90 border border-[#2c2416] text-[11px] text-[#b5a990]">
            <Shield className="w-3.5 h-3.5 text-[#34d399]" />
            <span>
              Pool sẵn sàng: <strong className="text-[#f5efe2]">{readyTotalCount}</strong>/{sortedAccounts.length} nick
            </span>
          </div>

          {/* Concentric Radar / Quantum Rings behind the Hub */}
          <div className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[340px] h-[340px] rounded-full border border-[#d4af37]/10" />
          <div className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[268px] h-[268px] rounded-full border border-dashed border-[#d4af37]/20 vira-ring-cw" />
          {isLive && (
            <div className="pointer-events-none absolute left-1/2 top-1/2 w-[220px] h-[220px] rounded-3xl border border-[#f5c451]/40 vira-shockwave" />
          )}

          {/* SVG Connection Wires & Plasma Particles */}
          {w > 0 && (
            <svg
              viewBox={`0 0 ${w} ${h}`}
              className="absolute inset-0 w-full h-full pointer-events-none"
            >
              <defs>
                <filter id="viraUltraGlow" x="-40%" y="-40%" width="180%" height="180%">
                  <feGaussianBlur stdDeviation="4" result="blur1" />
                  <feGaussianBlur stdDeviation="8" result="blur2" />
                  <feMerge>
                    <feMergeNode in="blur2" />
                    <feMergeNode in="blur1" />
                    <feMergeNode in="SourceGraphic" />
                  </feMerge>
                </filter>
              </defs>

              {nodes.map((n) => {
                if (!n) return null
                const pathId = `vira-wire-${n.slot.id}`

                if (!n.stage) {
                  const idleColor = n.isReady
                    ? 'rgba(212, 175, 55, 0.28)'
                    : 'rgba(225, 29, 72, 0.22)'
                  return (
                    <g key={n.slot.id}>
                      <path
                        d={n.path}
                        fill="none"
                        stroke={idleColor}
                        strokeWidth={1.6}
                        strokeDasharray={n.isReady ? 'none' : '3 7'}
                        strokeLinecap="round"
                      />
                      {/* Port terminals */}
                      <circle cx={n.sx} cy={n.sy} r={3} fill={idleColor} />
                      <circle cx={n.tx} cy={n.ty} r={3} fill={idleColor} />
                    </g>
                  )
                }

                const { color, dir } = n.stage
                const keyPoints = dir === 'out' ? '1;0' : '0;1'

                return (
                  <g key={n.slot.id}>
                    {/* Wide ambient plasma sheath */}
                    <path
                      id={pathId}
                      d={n.path}
                      fill="none"
                      stroke={color}
                      strokeOpacity={0.2}
                      strokeWidth={9}
                      strokeLinecap="round"
                    />
                    {/* Core solid energy guide */}
                    <path
                      d={n.path}
                      fill="none"
                      stroke={color}
                      strokeOpacity={0.35}
                      strokeWidth={2}
                    />
                    {/* Animated high-contrast dashed beam (matching the iconic Muse AI dashed gold stream) */}
                    <path
                      d={n.path}
                      fill="none"
                      stroke={color}
                      strokeWidth={3.6}
                      strokeLinecap="round"
                      strokeDasharray="10 14"
                      filter="url(#viraUltraGlow)"
                      className={dir === 'out' ? 'vira-beam-out' : 'vira-beam-in'}
                    />

                    {/* Docking port terminals at card edge and hub edge */}
                    <circle
                      cx={n.sx}
                      cy={n.sy}
                      r={4.5}
                      fill="#fffbeb"
                      stroke={color}
                      strokeWidth={2}
                      filter="url(#viraUltraGlow)"
                    />
                    <circle
                      cx={n.tx}
                      cy={n.ty}
                      r={4.5}
                      fill="#fffbeb"
                      stroke={color}
                      strokeWidth={2}
                      filter="url(#viraUltraGlow)"
                    />

                    {/* Twin energy comets traveling along the wire */}
                    {[0, 0.75].map((delay) => (
                      <circle
                        key={delay}
                        r={4.5}
                        fill="#ffffff"
                        stroke={color}
                        strokeWidth={2}
                        filter="url(#viraUltraGlow)"
                      >
                        <animateMotion
                          dur="1.5s"
                          begin={`${delay}s`}
                          repeatCount="indefinite"
                          keyPoints={keyPoints}
                          keyTimes="0;1"
                          calcMode="linear"
                        >
                          <mpath href={`#${pathId}`} />
                        </animateMotion>
                      </circle>
                    ))}
                  </g>
                )
              })}
            </svg>
          )}

          {/* CENTRAL QUANTUM HUB CARD */}
          <div
            className={`${
              isLive ? 'vira-hub-live' : 'shadow-[0_0_40px_rgba(212,175,55,0.16)]'
            } absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[212px] h-[216px] rounded-[28px] bg-gradient-to-b from-[#1a160e] via-[#13110b] to-[#0e0c08] border-2 border-[#e5c158]/80 flex flex-col items-center justify-between px-3.5 py-4 text-center z-10`}
          >
            {/* Top subtle HUD notches */}
            <div className="w-12 h-[2px] rounded-full bg-gradient-to-r from-transparent via-[#f5c451] to-transparent opacity-80" />

            {/* Center Emblem with Rotating Conic Halo */}
            <div className="relative w-16 h-16 flex items-center justify-center my-0.5">
              <div
                className="vira-ring-ccw absolute -inset-1.5 rounded-full opacity-75"
                style={{
                  background:
                    'conic-gradient(from 0deg, transparent 0 55%, #f5c451 80%, #38bdf8 95%, transparent 100%)',
                  WebkitMask: 'radial-gradient(circle, transparent 63%, #000 65%)',
                  mask: 'radial-gradient(circle, transparent 63%, #000 65%)'
                }}
              />
              <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-[#ffe082] via-[#e5bd4f] to-[#a87e1b] text-[#120f08] font-black text-3xl flex items-center justify-center shadow-[0_0_30px_rgba(245,196,81,0.5)] border border-[#fff3c4]/50">
                V
              </div>
            </div>

            {/* Hub Title & Live Subtitle */}
            <div className="w-full">
              <div className="font-black text-[17px] text-[#faf4e6] tracking-tight flex items-center justify-center gap-1.5">
                ViraAI Core
              </div>
              <div className="mt-0.5 text-[11px] font-medium text-[#c4b491] truncate px-1">
                {featuredActiveLabel
                  ? `Request đang chạy - ${featuredActiveLabel}`
                  : `Sẵn sàng · ${readyTotalCount} nick`}
              </div>
            </div>

            {/* 3 Stage Telemetry Counters */}
            <div className="grid grid-cols-3 gap-1.5 w-full pt-1">
              {[
                { n: stageCounts.in, color: '#ffd166', label: 'GỬI' },
                { n: stageCounts.render, color: '#38bdf8', label: 'DỰNG' },
                { n: stageCounts.out, color: '#34d399', label: 'TẢI' }
              ].map(({ n, color, label }) => (
                <div
                  key={label}
                  className="rounded-xl bg-[#0b0a07]/90 border border-[#2e2617] py-1 px-1 shadow-inner"
                >
                  <div
                    className="text-sm font-black tabular-nums leading-tight"
                    style={{ color: n > 0 ? color : '#5c5340' }}
                  >
                    {n}
                  </div>
                  <div className="text-[9px] font-bold uppercase tracking-wider text-[#8c826d]">
                    {label}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* 8 SURROUNDING ACCOUNT NODES */}
          {nodes.map((n) => {
            if (!n) return null
            const { slot, acc, task, stage, isReady } = n
            const scoreNum = getAccountScoreBadge(acc)
            const startedAt = task
              ? taskStartTimesRef.current.get(task.id) || task.createdAt || now
              : now
            const elapsedStr = task ? formatElapsed(now - startedAt) : null

            const subtitle = stage
              ? task
                ? `${stage.label} #${task.sequenceNumber}`
                : `${stage.label} (mô phỏng)`
              : idleSubtitle(acc)

            const accent = stage ? stage.color : isReady ? '#e5c158' : '#e11d48'

            return (
              <div
                key={acc.id}
                onClick={() => {
                  if (activeTaskByAccount.size === 0) {
                    setSimulatedAccId((prev) => (prev === acc.id ? null : acc.id))
                  }
                }}
                style={{
                  left: `${slot.xPct}%`,
                  top: `${slot.yPct}%`,
                  borderColor: stage ? stage.color : undefined,
                  boxShadow: stage
                    ? `0 0 32px ${stage.glow}, inset 0 0 18px ${stage.badgeBg}`
                    : isReady
                      ? '0 8px 24px rgba(0, 0, 0, 0.55)'
                      : undefined
                }}
                title={`${acc.name} (${task?.progressText || acc.statusMessage || subtitle}) — Hôm nay: ${acc.videosToday || 0} video | Tổng: ${acc.totalVideos || 0} video. Nhấn biểu tượng nguồn để Bật/Tắt nick.`}
                className={`group absolute -translate-x-1/2 -translate-y-1/2 w-[248px] h-[82px] rounded-2xl pl-4 pr-3.5 flex items-center justify-between overflow-hidden transition-all duration-300 cursor-pointer z-10 ${
                  stage
                    ? 'bg-gradient-to-r from-[#1b170e] via-[#15130c] to-[#12100b] border-2 scale-[1.02]'
                    : isReady
                      ? 'bg-[#12100c]/95 border border-[#5e4e26]/80 hover:border-[#e5c158] hover:bg-[#17140e]'
                      : 'bg-[#130d0f]/90 border border-[#522129]/75 hover:border-[#8a3240] opacity-80'
                }`}
              >
                {/* Glowing Left Edge Pillar */}
                <span
                  className="absolute left-0 top-2.5 bottom-2.5 w-[3.5px] rounded-r-full"
                  style={{ background: accent, boxShadow: `0 0 10px ${accent}` }}
                />

                {/* Left Info Column */}
                <div className="flex items-center gap-3 min-w-0 flex-1 pr-2">
                  {/* Glowing Status Orb */}
                  <div className="relative flex items-center justify-center shrink-0">
                    {stage && (
                      <span
                        className="absolute -inset-1.5 rounded-full animate-ping opacity-40"
                        style={{ background: accent }}
                      />
                    )}
                    <span
                      className="w-3 h-3 rounded-full relative z-10"
                      style={{ background: accent, boxShadow: `0 0 10px ${accent}` }}
                    />
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="font-extrabold text-[13.5px] text-[#faf4e6] truncate tracking-wide">
                        {formatFlowAccountLabel(acc, maskedMode)}
                      </span>
                      {task && (
                        <span
                          className="shrink-0 text-[9.5px] font-extrabold px-1.5 py-0.2 rounded border"
                          style={{
                            color: stage?.color,
                            borderColor: `${stage?.color}55`,
                            background: stage?.badgeBg
                          }}
                        >
                          {task.duration}s
                        </span>
                      )}
                    </div>

                    <div
                      className="text-[11.5px] font-medium truncate mt-0.5"
                      style={{ color: stage ? stage.color : isReady ? '#a3967a' : '#9e6b74' }}
                    >
                      {subtitle}
                    </div>
                  </div>
                </div>

                {/* Right Score & Elapsed Timer Column */}
                <div className="flex items-center gap-1.5 shrink-0">
                  <div className="text-right">
                    <div
                      className="font-black text-sm tabular-nums leading-tight"
                      style={{ color: stage ? stage.color : isReady ? '#e5c158' : '#d97757' }}
                    >
                      {scoreNum}
                    </div>
                    {elapsedStr ? (
                      <div className="font-mono text-[10px] font-bold text-[#c4b491] tabular-nums mt-0.5">
                        {elapsedStr}
                      </div>
                    ) : (
                      <div className="text-[9.5px] text-[#6e6450] font-semibold tabular-nums">
                        hôm nay: {acc.videosToday || 0}
                      </div>
                    )}
                  </div>

                  <button
                    onClick={(e) => handleToggleAccountEnabled(acc, e)}
                    title={acc.enabled ? 'Tắt tài khoản này' : 'Bật tài khoản này'}
                    className="opacity-0 group-hover:opacity-100 p-1.5 rounded-lg bg-[#211c12] hover:bg-[#302819] text-[#f5c451] border border-[#453920] transition"
                  >
                    <Power className="w-3.5 h-3.5" />
                  </button>
                </div>

                {/* Bottom Shimmer Scan Bar when Active */}
                {stage && (
                  <span
                    className="absolute left-0 right-0 bottom-0 h-[2.5px] overflow-hidden"
                    style={{ background: `${stage.color}25` }}
                  >
                    <span
                      className="vira-scan block h-full w-2/5"
                      style={{
                        background: `linear-gradient(90deg, transparent, ${stage.color}, #ffffff, ${stage.color}, transparent)`
                      }}
                    />
                  </span>
                )}
              </div>
            )
          })}

          {pageAccounts.length === 0 && (
            <div className="absolute inset-0 flex items-center justify-center text-xs text-[#8c826d]">
              Chưa có tài khoản nào trong kho này. Hãy thêm tài khoản ở mục Quản lý Tài khoản.
            </div>
          )}

          {/* Bottom Floating Live Activity Toast Pill (Matches reference `Đang truyền request từ har***@*** tới ViraAI`) */}
          <div className="absolute bottom-3.5 left-1/2 -translate-x-1/2 z-20 max-w-[92%]">
            <div className="px-5 py-2 rounded-full bg-[#14110b]/95 border border-[#5c4a22] shadow-[0_8px_30px_rgba(0,0,0,0.8)] flex items-center gap-2.5 text-xs text-[#efe6d2] whitespace-nowrap">
              <span
                className="w-2.5 h-2.5 rounded-full shrink-0 animate-pulse"
                style={{
                  background: featuredStage?.color ?? '#f5c451',
                  boxShadow: `0 0 10px ${featuredStage?.color ?? '#f5c451'}`
                }}
              />
              {featuredActiveLabel && featuredStage ? (
                <span>
                  Đang truyền request từ{' '}
                  <strong style={{ color: featuredStage.color }}>{featuredActiveLabel}</strong> tới{' '}
                  <strong className="text-white">ViraAI</strong>
                  {featuredTask ? (
                    <span className="text-[#a3967a]">
                      {' '}
                      · {featuredStage.label} #{featuredTask.sequenceNumber} ({featuredTask.ratio} · {featuredTask.duration}s)
                    </span>
                  ) : null}
                </span>
              ) : (
                <span>
                  Hệ thống đang kết nối trực tiếp{' '}
                  <strong className="text-[#f5c451]">{readyTotalCount}</strong> tài khoản sẵn sàng với{' '}
                  <strong className="text-white">ViraAI Core</strong>
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Bottom Telemetry & Live Throughput Strip (fills full-page mode richly) */}
        {!compact && (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mt-4">
            <div className="rounded-2xl bg-[#13110c] border border-[#2c2416] px-4 py-3 flex items-center justify-between">
              <div>
                <div className="text-[11px] text-[#8c826d] font-medium">Tài khoản Sẵn sàng</div>
                <div className="text-lg font-black text-[#faf4e6] tabular-nums mt-0.5">
                  {readyTotalCount}{' '}
                  <span className="text-xs font-semibold text-[#8c826d]">/ {sortedAccounts.length} nick</span>
                </div>
              </div>
              <div className="w-9 h-9 rounded-xl bg-[#f5c451]/10 border border-[#f5c451]/30 flex items-center justify-center text-[#f5c451]">
                <Users className="w-4 h-4" />
              </div>
            </div>

            <div className="rounded-2xl bg-[#13110c] border border-[#2c2416] px-4 py-3 flex items-center justify-between">
              <div>
                <div className="text-[11px] text-[#8c826d] font-medium">Luồng Đang Truyền</div>
                <div className="text-lg font-black text-[#ffd166] tabular-nums mt-0.5">
                  {activeAccountsList.length}{' '}
                  <span className="text-xs font-semibold text-[#8c826d]">
                    luồng · {queuedCount} chờ
                  </span>
                </div>
              </div>
              <div className="w-9 h-9 rounded-xl bg-[#ffd166]/10 border border-[#ffd166]/30 flex items-center justify-center text-[#ffd166]">
                <Cpu className="w-4 h-4" />
              </div>
            </div>

            <div className="rounded-2xl bg-[#13110c] border border-[#2c2416] px-4 py-3 flex items-center justify-between">
              <div>
                <div className="text-[11px] text-[#8c826d] font-medium">Đang Dựng Trên Dola</div>
                <div className="text-lg font-black text-[#38bdf8] tabular-nums mt-0.5">
                  {stageCounts.render}{' '}
                  <span className="text-xs font-semibold text-[#8c826d]">
                    video · {stageCounts.in} đang gửi
                  </span>
                </div>
              </div>
              <div className="w-9 h-9 rounded-xl bg-[#38bdf8]/10 border border-[#38bdf8]/30 flex items-center justify-center text-[#38bdf8]">
                <Sparkles className="w-4 h-4" />
              </div>
            </div>

            <div className="rounded-2xl bg-[#13110c] border border-[#2c2416] px-4 py-3 flex items-center justify-between">
              <div>
                <div className="text-[11px] text-[#8c826d] font-medium">Đã Tải Không Logo</div>
                <div className="text-lg font-black text-[#34d399] tabular-nums mt-0.5">
                  {completedTodayCount}{' '}
                  <span className="text-xs font-semibold text-[#8c826d]">video hoàn tất</span>
                </div>
              </div>
              <div className="w-9 h-9 rounded-xl bg-[#34d399]/10 border border-[#34d399]/30 flex items-center justify-center text-[#34d399]">
                <CheckCircle2 className="w-4 h-4" />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
export default ConnectionFlowGraph

import React, { useMemo, useState } from 'react'
import {
  Users,
  Plus,
  RefreshCw,
  Globe,
  Trash2,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Loader2,
  KeyRound,
  Cookie,
  Sparkles,
  Download,
  Folder,
  FolderPlus,
  Pencil,
  Layers,
  ArrowRightLeft
} from 'lucide-react'
import {
  AccountPoolEntry,
  AccountProfile,
  AppSettings,
  ProxyEntry,
  RotatingProxyEntry
} from '../../../shared/types'

interface AccountsPageProps {
  settings?: AppSettings
  accountPools: AccountPoolEntry[]
  accounts: AccountProfile[]
  proxies: ProxyEntry[]
  rotatingProxies: RotatingProxyEntry[]
}

const DEFAULT_POOL_ID = 'pool-default'
const ALL_POOLS = 'all'
const poolOfAccount = (acc: AccountProfile): string => acc.poolId || DEFAULT_POOL_ID

export const AccountsPage: React.FC<AccountsPageProps> = ({
  settings,
  accountPools,
  accounts,
  proxies,
  rotatingProxies
}) => {
  const [activeTab, setActiveTab] = useState<'facebook' | 'cookie' | 'google' | 'manual'>('facebook')
  const [selectedPoolId, setSelectedPoolId] = useState<string>(ALL_POOLS)
  const [targetImportPoolId, setTargetImportPoolId] = useState<string>(DEFAULT_POOL_ID)

  // Pool CRUD + Auto-split state
  const [creatingPool, setCreatingPool] = useState(false)
  const [newPoolName, setNewPoolName] = useState('')
  const [renamePoolId, setRenamePoolId] = useState<string | null>(null)
  const [renamePoolValue, setRenamePoolValue] = useState('')
  const [showAutoSplit, setShowAutoSplit] = useState(false)
  const [splitSize, setSplitSize] = useState<number>(5)
  const [splitPrefix, setSplitPrefix] = useState<string>('Kho Via')

  // Bulk selection state
  const [selectedAccIds, setSelectedAccIds] = useState<string[]>([])
  const [bulkTargetPoolId, setBulkTargetPoolId] = useState<string>(DEFAULT_POOL_ID)

  const [cookieName, setCookieName] = useState('')
  const [cookieRaw, setCookieRaw] = useState('')
  const [selectedProxyId, setSelectedProxyId] = useState('')

  const [fbBatchLines, setFbBatchLines] = useState('')
  const [autoLoginFb, setAutoLoginFb] = useState(true)
  const [showFbWindow, setShowFbWindow] = useState(true)

  const [googleBatchLines, setGoogleBatchLines] = useState('')
  const [autoLoginGoogle, setAutoLoginGoogle] = useState(true)

  const [manualName, setManualName] = useState('')
  const [feedback, setFeedback] = useState<string | null>(null)
  const [busyAction, setBusyAction] = useState<string | null>(null)

  const loginConcurrency = Math.min(5, Math.max(1, Number(settings?.loginConcurrency || 3)))

  const handleSetLoginConcurrency = (val: number) => {
    const clamped = Math.min(5, Math.max(1, val))
    void window.api.updateSettings({ loginConcurrency: clamped })
  }

  const effectiveImportPoolId =
    selectedPoolId !== ALL_POOLS ? selectedPoolId : targetImportPoolId || DEFAULT_POOL_ID

  const visibleAccounts = useMemo(() => {
    if (selectedPoolId === ALL_POOLS) return accounts
    return accounts.filter((a) => poolOfAccount(a) === selectedPoolId)
  }, [accounts, selectedPoolId])

  const selectedPoolObj = accountPools.find((p) => p.id === selectedPoolId)

  const countInPool = (poolId: string): number =>
    accounts.filter((a) => poolOfAccount(a) === poolId).length

  const readyCountInPool = (poolId: string): number =>
    accounts.filter((a) => poolOfAccount(a) === poolId && a.enabled && a.status === 'ready').length

  const handleSelectPoolTab = (poolId: string) => {
    setSelectedPoolId(poolId)
    if (poolId !== ALL_POOLS) {
      setTargetImportPoolId(poolId)
      setBulkTargetPoolId(poolId)
    }
    setSelectedAccIds([])
  }

  const handleCreatePool = async () => {
    const name = newPoolName.trim()
    if (!name) return
    const id = `pool-${Date.now()}`
    await window.api.saveAccountPool({
      id,
      name,
      createdAt: Date.now(),
      updatedAt: Date.now()
    })
    setNewPoolName('')
    setCreatingPool(false)
    setSelectedPoolId(id)
    setTargetImportPoolId(id)
    setFeedback(`Đã tạo kho tài khoản "${name}" thành công!`)
  }

  const handleRenamePool = async () => {
    const target = accountPools.find((p) => p.id === renamePoolId)
    const name = renamePoolValue.trim()
    if (!target || !name) return
    await window.api.saveAccountPool({ ...target, name, updatedAt: Date.now() })
    setRenamePoolId(null)
    setFeedback(`Đã đổi tên kho tài khoản thành "${name}".`)
  }

  const handleDeletePool = async (pool: AccountPoolEntry) => {
    if (accountPools.length <= 1) {
      window.alert('Cần ít nhất 1 kho tài khoản — không thể xoá kho cuối cùng.')
      return
    }
    const ok = window.confirm(
      `Xoá kho tài khoản "${pool.name}"?\nCác tài khoản bên trong KHÔNG bị xoá mà sẽ được chuyển về kho đầu tiên.`
    )
    if (!ok) return
    await window.api.deleteAccountPool(pool.id)
    if (selectedPoolId === pool.id) setSelectedPoolId(ALL_POOLS)
    setFeedback(`Đã xoá kho "${pool.name}" (các tài khoản đã được giữ nguyên).`)
  }

  const handleAutoSplitPools = async () => {
    if (accounts.length === 0) {
      setFeedback('Chưa có tài khoản nào để chia kho.')
      return
    }
    const targetIds =
      selectedAccIds.length > 0
        ? selectedAccIds
        : selectedPoolId !== ALL_POOLS
          ? visibleAccounts.map((a) => a.id)
          : undefined
    const res = await window.api.autoSplitAccountsIntoPools({
      poolSize: splitSize,
      prefix: splitPrefix.trim() || 'Kho Via',
      accountIds: targetIds
    })
    setShowAutoSplit(false)
    setSelectedAccIds([])
    setFeedback(
      `Đã tự động chia ${targetIds ? targetIds.length : accounts.length} tài khoản thành ${res.poolCount} kho (${splitSize} acc/kho)!`
    )
  }

  const handleBulkAssignPool = async () => {
    if (selectedAccIds.length === 0 || !bulkTargetPoolId) return
    await window.api.assignAccountsToPool(selectedAccIds, bulkTargetPoolId)
    const poolName = accountPools.find((p) => p.id === bulkTargetPoolId)?.name || 'Kho'
    setFeedback(`Đã chuyển ${selectedAccIds.length} tài khoản sang "${poolName}"!`)
    setSelectedAccIds([])
  }

  const handleBulkLoginFb = async () => {
    const fbTargets = accounts.filter(
      (a) =>
        selectedAccIds.includes(a.id) &&
        a.sourceType === 'facebook' &&
        (a.fbCookie || a.password)
    )
    if (fbTargets.length === 0) {
      setFeedback('Các tài khoản đã chọn không có Cookie/Mật khẩu Facebook để đăng nhập.')
      return
    }
    setBusyAction('bulk-fb')
    setFeedback(
      `Đang tự động đăng nhập Facebook song song (${loginConcurrency} luồng) cho ${fbTargets.length} tài khoản đã chọn…`
    )
    const res = await window.api.loginAccountsBatch({
      accountIds: fbTargets.map((a) => a.id),
      showWindow: showFbWindow,
      concurrency: loginConcurrency
    })
    setBusyAction(null)
    setFeedback(res?.message || `Đã hoàn tất đăng nhập Facebook cho ${fbTargets.length} tài khoản!`)
  }

  const handleLoginAllVisibleFb = async () => {
    const unreadyFb = visibleAccounts.filter(
      (a) => a.sourceType === 'facebook' && (a.fbCookie || a.password) && a.status !== 'ready'
    )
    const targets =
      unreadyFb.length > 0
        ? unreadyFb
        : visibleAccounts.filter((a) => a.sourceType === 'facebook' && (a.fbCookie || a.password))
    if (targets.length === 0) {
      setFeedback('Không có tài khoản Facebook nào trong danh sách hiện tại để đăng nhập.')
      return
    }
    setBusyAction('login-all-fb')
    setFeedback(
      `Đang chạy đăng nhập Facebook song song (${loginConcurrency} luồng cùng lúc) cho ${targets.length} tài khoản…`
    )
    const res = await window.api.loginAccountsBatch({
      accountIds: targets.map((a) => a.id),
      showWindow: showFbWindow,
      concurrency: loginConcurrency
    })
    setBusyAction(null)
    setFeedback(res?.message || `Đã đăng nhập xong ${targets.length} tài khoản!`)
  }

  const handleBulkDelete = async () => {
    if (selectedAccIds.length === 0) return
    const ok = window.confirm(`Xoá ${selectedAccIds.length} tài khoản đã chọn?`)
    if (!ok) return
    for (const id of selectedAccIds) {
      await window.api.deleteAccount(id)
    }
    setFeedback(`Đã xoá ${selectedAccIds.length} tài khoản.`)
    setSelectedAccIds([])
  }

  const expiredVisible = visibleAccounts.filter((a) => a.status === 'expired')

  const handleDeleteExpired = async () => {
    if (expiredVisible.length === 0) return
    const ok = window.confirm(
      `Xoá ${expiredVisible.length} tài khoản "Hết phiên"${selectedPoolId === ALL_POOLS ? '' : ' trong kho này'}?\nKhông thể hoàn tác.`
    )
    if (!ok) return
    const ids = expiredVisible.map((a) => a.id)
    for (const id of ids) {
      await window.api.deleteAccount(id)
    }
    setSelectedAccIds((prev) => prev.filter((id) => !ids.includes(id)))
    setFeedback(`Đã xoá ${ids.length} tài khoản hết phiên.`)
  }

  const toggleSelectAllVisible = () => {
    const visibleIds = visibleAccounts.map((a) => a.id)
    const allSelected =
      visibleIds.length > 0 && visibleIds.every((id) => selectedAccIds.includes(id))
    if (allSelected) {
      setSelectedAccIds((prev) => prev.filter((id) => !visibleIds.includes(id)))
    } else {
      setSelectedAccIds((prev) => Array.from(new Set([...prev, ...visibleIds])))
    }
  }

  const toggleSelectOne = (id: string) => {
    setSelectedAccIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    )
  }

  const handleAddFacebookBatch = async () => {
    if (!fbBatchLines.trim()) {
      setFeedback('Vui lòng dán danh sách Via/Cookie Facebook (UID|Pass|2FA|c_user=...;xs=...;datr=...|Token|Mail|).')
      return
    }
    setBusyAction('add-fb')
    setFeedback(
      `Đang nạp Cookie Facebook và tự động đăng nhập Dola OAuth song song (${loginConcurrency} luồng)…`
    )
    try {
      const res = await window.api.addFacebookBatch({
        rawLines: fbBatchLines,
        autoLoginNow: autoLoginFb,
        proxyId: selectedProxyId || undefined,
        poolId: effectiveImportPoolId,
        showWindow: showFbWindow,
        concurrency: loginConcurrency
      })
      if (!res || res.addedCount === 0) {
        setFeedback(
          res?.message || 'Không tìm thấy cookie/via Facebook hợp lệ (cần có c_user=...;xs=... hoặc UID|Pass).'
        )
        return
      }
      setFbBatchLines('')
      const poolName =
        accountPools.find((p) => p.id === effectiveImportPoolId)?.name || 'Kho mặc định'
      setFeedback(
        `Đã nạp ${res.addedCount} tài khoản Facebook vào "${poolName}"${
          autoLoginFb
            ? ` — đang tự động mở Dola đăng nhập Facebook & xác nhận 18+ (${loginConcurrency} luồng song song)…`
            : '.'
        }`
      )
    } catch (err: any) {
      setFeedback(
        `Lỗi khi gọi tiến trình chính: ${err?.message || String(err)}. Vui lòng thoát hẳn ứng dụng (Cmd+Q) và mở lại Chay_ViraAI_Mac.command.`
      )
    } finally {
      setBusyAction(null)
    }
  }

  const handleAddCookie = async () => {
    if (!cookieRaw.trim()) {
      setFeedback('Vui lòng dán chuỗi Cookie Dola hoặc JSON tài khoản (seedance-accounts).')
      return
    }
    setBusyAction('add-cookie')
    const res = await window.api.addCookieAccount({
      name: cookieName,
      cookie: cookieRaw,
      proxyId: selectedProxyId || undefined,
      poolId: effectiveImportPoolId
    })
    setBusyAction(null)
    setCookieName('')
    setCookieRaw('')
    setFeedback(
      (res as any)?.message
        ? (res as any).message
        : res.warning
          ? `Đã thêm tài khoản nhưng lưu ý: ${res.warning}`
          : `Đã thêm và kiểm tra tài khoản ${res.account?.name || ''} thành công!`
    )
  }

  const handleImportJsonFile = async () => {
    setBusyAction('import-json')
    try {
      const res = await window.api.importAccountsJsonFile({
        poolId: effectiveImportPoolId,
        proxyId: selectedProxyId || undefined
      })
      if (res && !res.canceled) {
        setFeedback(
          res.message ||
            `Đã nhập ${res.addedCount || 0} tài khoản mới (cập nhật ${res.updatedCount || 0} tài khoản) từ file JSON!`
        )
      }
    } catch (err: any) {
      setFeedback(`Lỗi khi nhập file JSON: ${err?.message || String(err)}`)
    } finally {
      setBusyAction(null)
    }
  }

  const handleAddGoogleBatch = async () => {
    if (!googleBatchLines.trim()) {
      setFeedback('Vui lòng nhập danh sách Google theo dạng: email|mật_khẩu (mỗi dòng 1 acc).')
      return
    }
    setBusyAction('add-google')
    const res = await window.api.addGoogleBatch({
      rawLines: googleBatchLines,
      autoLoginNow: autoLoginGoogle,
      poolId: effectiveImportPoolId,
      concurrency: loginConcurrency
    })
    setBusyAction(null)
    setGoogleBatchLines('')
    setFeedback(
      `Đã thêm ${res.addedCount} tài khoản Google vào danh sách${
        autoLoginGoogle ? ` — đang tự động đăng nhập Dola (${loginConcurrency} luồng)…` : '.'
      }`
    )
  }

  const handleCreateManual = async () => {
    setBusyAction('add-manual')
    await window.api.createManualAccount(manualName, effectiveImportPoolId)
    setBusyAction(null)
    setManualName('')
    setFeedback('Đã mở cửa sổ trình duyệt Dola. Sau khi đăng nhập xong, đóng cửa sổ để lưu phiên.')
  }

  const handleCheckAll = async () => {
    setBusyAction('check-all')
    if (selectedPoolId !== ALL_POOLS && visibleAccounts.length > 0) {
      setFeedback(
        `Đang kiểm tra & tự động đăng nhập lại ${visibleAccounts.length} tài khoản trong "${selectedPoolObj?.name}" (${loginConcurrency} luồng)…`
      )
      await window.api.checkAllAccounts({
        accountIds: visibleAccounts.map((a) => a.id),
        concurrency: loginConcurrency
      })
      setBusyAction(null)
      setFeedback(`Đã kiểm tra xong ${visibleAccounts.length} tài khoản trong "${selectedPoolObj?.name}"!`)
      return
    }
    setFeedback(`Đang kiểm tra trạng thái toàn bộ tài khoản Dola (${loginConcurrency} luồng song song)…`)
    await window.api.checkAllAccounts({ concurrency: loginConcurrency })
    setBusyAction(null)
    setFeedback('Đã kiểm tra xong toàn bộ tài khoản!')
  }

  const handleRecycleAll = async () => {
    setBusyAction('recycle-all')
    if (selectedPoolId !== ALL_POOLS && visibleAccounts.length > 0) {
      setFeedback(
        `Đang làm mới lượt (${loginConcurrency} luồng) cho các tài khoản trong "${selectedPoolObj?.name}"…`
      )
      const res = await window.api.recycleAllExhausted({
        accountIds: visibleAccounts.map((a) => a.id),
        concurrency: loginConcurrency
      })
      setBusyAction(null)
      setFeedback(res?.message || `Đã làm mới lượt xong cho kho "${selectedPoolObj?.name}"!`)
      return
    }
    setFeedback(
      `Đang làm mới lượt (${loginConcurrency} luồng song song) cho các tài khoản đã hết lượt…`
    )
    const res = await window.api.recycleAllExhausted({ concurrency: loginConcurrency })
    setBusyAction(null)
    setFeedback(res.message)
  }

  const handlePullAllVideos = async () => {
    setBusyAction('pull-all')
    setFeedback('Đang quét và kéo các video mới từ toàn bộ tài khoản về Kho video…')
    const res = await window.api.pullVideosFromAllAccounts()
    setBusyAction(null)
    setFeedback(res.message)
  }

  const renderStatusBadge = (acc: AccountProfile) => {
    switch (acc.status) {
      case 'ready':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-vira-accent/20 text-vira-accent">
            <CheckCircle2 className="w-3.5 h-3.5" /> Sẵn sàng
          </span>
        )
      case 'quota_exhausted':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-500/20 text-amber-300">
            <AlertTriangle className="w-3.5 h-3.5" /> Hết lượt hôm nay
          </span>
        )
      case 'recycling':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-purple-500/20 text-purple-300">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Đang làm mới lượt…
          </span>
        )
      case 'checking':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-blue-500/20 text-blue-300">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Đang kiểm tra…
          </span>
        )
      case 'expired':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-rose-500/10 text-rose-300">
            <XCircle className="w-3.5 h-3.5" /> Hết phiên
          </span>
        )
      case 'error':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-rose-500/10 text-rose-300">
            <XCircle className="w-3.5 h-3.5" /> Lỗi
          </span>
        )
      default:
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-white/10 text-vira-muted">
            Chưa kiểm
          </span>
        )
    }
  }

  return (
    <div className="h-full overflow-y-auto p-6 space-y-5">
      {/* 1. HEADER */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold flex items-center gap-2">
            <Users className="w-6 h-6 text-vira-accent" />
            Quản lý Kho Tài khoản Dola / Via Facebook ({visibleAccounts.length}/{accounts.length})
          </h1>
          <p className="text-xs text-vira-muted mt-1">
            Gom các lô Via Facebook / Google vào từng{' '}
            <span className="text-vira-accent font-medium">Kho Tài Khoản (Pools)</span>, hỗ trợ đăng nhập song song{' '}
            <span className="text-vira-accent font-semibold">3–5 luồng cùng lúc</span> và tự động điền 2FA / vượt cổng tuổi 18+.
          </p>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl bg-vira-panel border border-vira-border text-xs">
            <span className="text-vira-muted">Luồng Login:</span>
            {[1, 3, 4, 5].map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => handleSetLoginConcurrency(n)}
                className={`px-2 py-0.5 rounded-lg text-xs font-bold transition ${
                  loginConcurrency === n
                    ? 'bg-vira-accent text-[#0b1220]'
                    : 'bg-vira-card text-vira-muted hover:text-white'
                }`}
              >
                {n} luồng
              </button>
            ))}
          </div>

          <button
            onClick={handleLoginAllVisibleFb}
            disabled={busyAction !== null}
            className="px-3.5 py-2 rounded-xl bg-blue-500/20 border border-blue-400/60 text-blue-300 hover:bg-blue-500 hover:text-white text-xs font-bold flex items-center gap-1.5 transition"
          >
            {busyAction === 'login-all-fb' ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Globe className="w-4 h-4" />
            )}
            Đăng nhập FB ({loginConcurrency} luồng)
          </button>

          <button
            onClick={handleCheckAll}
            disabled={busyAction !== null}
            className="px-3.5 py-2 rounded-xl bg-vira-card border border-vira-border hover:border-vira-accent text-xs font-semibold flex items-center gap-1.5"
          >
            <RefreshCw className={`w-4 h-4 ${busyAction === 'check-all' ? 'animate-spin' : ''}`} />
            {selectedPoolId === ALL_POOLS ? 'Kiểm tra tất cả' : `Kiểm tra kho (${visibleAccounts.length})`}
          </button>

          <button
            onClick={handleDeleteExpired}
            disabled={busyAction !== null || expiredVisible.length === 0}
            title="Xoá tất cả tài khoản đang ở trạng thái Hết phiên (trong kho đang xem)"
            className="px-3.5 py-2 rounded-xl bg-rose-500/15 border border-rose-400/40 text-rose-300 hover:bg-rose-500/30 text-xs font-semibold flex items-center gap-1.5 disabled:opacity-40"
          >
            <Trash2 className="w-4 h-4" />
            Xoá nick hết phiên ({expiredVisible.length})
          </button>

          <button
            onClick={handleRecycleAll}
            disabled={busyAction !== null}
            className="px-3.5 py-2 rounded-xl bg-vira-accent/20 border border-vira-accent text-vira-accent hover:bg-vira-accent hover:text-[#0b1220] text-xs font-bold flex items-center gap-1.5 transition"
          >
            <Sparkles className="w-4 h-4" />
            {selectedPoolId === ALL_POOLS ? 'Làm mới lượt (Recycle tất cả)' : 'Làm mới lượt kho này'}
          </button>

          <button
            onClick={handleImportJsonFile}
            disabled={busyAction !== null}
            className="px-3.5 py-2 rounded-xl bg-emerald-500/20 border border-emerald-400/60 text-emerald-300 hover:bg-emerald-500 hover:text-[#0b1220] text-xs font-bold flex items-center gap-1.5 transition"
          >
            {busyAction === 'import-json' ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <FolderPlus className="w-4 h-4" />
            )}
            Nhập File JSON (seedance-accounts)
          </button>

          <button
            onClick={handlePullAllVideos}
            disabled={busyAction !== null}
            className="px-3.5 py-2 rounded-xl bg-vira-card border border-vira-border hover:border-vira-accent text-xs font-semibold flex items-center gap-1.5"
          >
            <Download className="w-4 h-4" />
            Kéo video từ các acc về Kho
          </button>
        </div>
      </div>

      {/* 2. ACCOUNT POOLS (KHO TÀI KHOẢN) BAR */}
      <div className="space-y-2">
        <div className="flex items-center gap-1.5 flex-wrap bg-vira-panel border border-vira-border rounded-xl p-1.5">
          <button
            onClick={() => handleSelectPoolTab(ALL_POOLS)}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 ${
              selectedPoolId === ALL_POOLS
                ? 'bg-vira-card text-vira-accent'
                : 'text-vira-muted hover:text-white hover:bg-vira-card'
            }`}
          >
            Tất cả kho
            <span className="px-1.5 rounded-full bg-vira-accent/15 text-vira-accent text-[10px] font-bold">
              {accounts.length}
            </span>
          </button>

          {accountPools.map((pool) => {
            const total = countInPool(pool.id)
            const ready = readyCountInPool(pool.id)
            return (
              <button
                key={pool.id}
                onClick={() => handleSelectPoolTab(pool.id)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 whitespace-nowrap ${
                  selectedPoolId === pool.id
                    ? 'bg-vira-card text-vira-accent border border-vira-accent/40'
                    : 'text-vira-muted hover:text-white hover:bg-vira-card'
                }`}
              >
                <Folder className="w-3.5 h-3.5" />
                {pool.name}
                <span className="px-1.5 rounded-full bg-vira-bg text-[10px]">
                  <span className="text-vira-accent font-bold">{ready}</span>/{total}
                </span>
              </button>
            )
          })}

          <button
            onClick={() => {
              setCreatingPool((v) => !v)
              setRenamePoolId(null)
              setShowAutoSplit(false)
            }}
            className="px-3 py-1.5 rounded-lg text-xs font-semibold text-vira-accent hover:bg-vira-accent/10 border border-dashed border-vira-accent/50 flex items-center gap-1"
          >
            <Plus className="w-3.5 h-3.5" /> Tạo kho tài khoản
          </button>

          <button
            onClick={() => {
              setShowAutoSplit((v) => !v)
              setCreatingPool(false)
              setRenamePoolId(null)
            }}
            className="px-3 py-1.5 rounded-lg text-xs font-semibold text-amber-300 hover:bg-amber-500/10 border border-dashed border-amber-400/50 flex items-center gap-1"
          >
            <Layers className="w-3.5 h-3.5" /> Chia lô via tự động
          </button>

          {/* Context actions for selected Kho Tài Khoản */}
          {selectedPoolObj && (
            <div className="flex items-center gap-1 ml-auto pl-2 border-l border-vira-border">
              <button
                onClick={() => {
                  setRenamePoolId(selectedPoolObj.id)
                  setRenamePoolValue(selectedPoolObj.name)
                  setCreatingPool(false)
                  setShowAutoSplit(false)
                }}
                title="Đổi tên kho tài khoản này"
                className="h-7 px-2.5 rounded-lg bg-vira-card hover:text-vira-accent text-[11px] flex items-center gap-1"
              >
                <Pencil className="w-3 h-3" /> Đổi tên
              </button>
              {accountPools.length > 1 && (
                <button
                  onClick={() => handleDeletePool(selectedPoolObj)}
                  title="Xoá kho tài khoản này (giữ nguyên các via bên trong)"
                  className="h-7 px-2.5 rounded-lg bg-vira-card hover:text-rose-300 text-[11px] flex items-center gap-1"
                >
                  <Trash2 className="w-3 h-3" /> Xoá kho
                </button>
              )}
            </div>
          )}
        </div>

        {/* Inline Create Pool Form */}
        {creatingPool && (
          <div className="flex items-center gap-2 bg-vira-panel border border-vira-border rounded-xl p-2.5">
            <FolderPlus className="w-4 h-4 text-vira-accent shrink-0" />
            <input
              autoFocus
              value={newPoolName}
              onChange={(e) => setNewPoolName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreatePool()
                if (e.key === 'Escape') setCreatingPool(false)
              }}
              placeholder="Tên kho tài khoản mới (VD: Lô Via FB #1, Kho Dự Án TikTok)…"
              className="flex-1 h-8 px-3 rounded-lg bg-[#0b1220] border border-vira-border text-xs text-white focus:outline-none focus:border-vira-accent"
            />
            <button
              onClick={handleCreatePool}
              className="h-8 px-3.5 rounded-lg bg-vira-accent text-[#0b1220] font-bold text-xs"
            >
              Tạo kho
            </button>
            <button
              onClick={() => setCreatingPool(false)}
              className="h-8 px-2.5 rounded-lg bg-vira-card text-vira-muted text-xs hover:text-white"
            >
              Huỷ
            </button>
          </div>
        )}

        {/* Inline Rename Pool Form */}
        {renamePoolId && (
          <div className="flex items-center gap-2 bg-vira-panel border border-vira-border rounded-xl p-2.5">
            <Pencil className="w-4 h-4 text-vira-accent shrink-0" />
            <input
              autoFocus
              value={renamePoolValue}
              onChange={(e) => setRenamePoolValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleRenamePool()
                if (e.key === 'Escape') setRenamePoolId(null)
              }}
              placeholder="Tên mới cho kho tài khoản…"
              className="flex-1 h-8 px-3 rounded-lg bg-[#0b1220] border border-vira-border text-xs text-white focus:outline-none focus:border-vira-accent"
            />
            <button
              onClick={handleRenamePool}
              className="h-8 px-3.5 rounded-lg bg-vira-accent text-[#0b1220] font-bold text-xs"
            >
              Lưu tên
            </button>
            <button
              onClick={() => setRenamePoolId(null)}
              className="h-8 px-2.5 rounded-lg bg-vira-card text-vira-muted text-xs hover:text-white"
            >
              Huỷ
            </button>
          </div>
        )}

        {/* Inline Auto-Split Batch Via into Pools */}
        {showAutoSplit && (
          <div className="flex items-center justify-between flex-wrap gap-3 bg-vira-panel border border-amber-400/40 rounded-xl p-3">
            <div className="flex items-center gap-2 text-xs">
              <Layers className="w-4 h-4 text-amber-300 shrink-0" />
              <span className="text-white font-semibold">Chia lô Via tự động thành nhiều Kho:</span>
              <span className="text-vira-muted">
                {selectedAccIds.length > 0
                  ? `Đang áp dụng cho ${selectedAccIds.length} acc đã tích chọn`
                  : selectedPoolId !== ALL_POOLS
                    ? `Đang áp dụng cho ${visibleAccounts.length} acc trong kho này`
                    : `Đang áp dụng cho toàn bộ ${accounts.length} acc`}
              </span>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <input
                type="text"
                value={splitPrefix}
                onChange={(e) => setSplitPrefix(e.target.value)}
                placeholder="Tiền tố tên kho (VD: Kho Via)"
                className="h-8 w-36 px-2.5 rounded-lg bg-[#0b1220] border border-vira-border text-xs text-white focus:outline-none focus:border-vira-accent"
              />
              <select
                value={splitSize}
                onChange={(e) => setSplitSize(Number(e.target.value))}
                className="h-8 px-2.5 rounded-lg bg-[#0b1220] border border-vira-border text-xs text-white focus:outline-none focus:border-vira-accent"
              >
                <option value={3}>3 via / 1 kho</option>
                <option value={5}>5 via / 1 kho</option>
                <option value={10}>10 via / 1 kho</option>
                <option value={15}>15 via / 1 kho</option>
                <option value={20}>20 via / 1 kho</option>
                <option value={30}>30 via / 1 kho</option>
              </select>
              <button
                onClick={handleAutoSplitPools}
                className="h-8 px-3.5 rounded-lg bg-amber-400 text-[#0b1220] font-bold text-xs hover:bg-amber-300 transition"
              >
                Chia kho ngay
              </button>
              <button
                onClick={() => setShowAutoSplit(false)}
                className="h-8 px-2.5 rounded-lg bg-vira-card text-vira-muted text-xs hover:text-white"
              >
                Đóng
              </button>
            </div>
          </div>
        )}
      </div>

      {feedback && (
        <div className="p-3 rounded-xl bg-vira-accent/15 border border-vira-accent text-xs text-vira-accent font-medium">
          {feedback}
        </div>
      )}

      {/* 3. ADD ACCOUNT CARD */}
      <div className="bg-vira-panel border border-vira-border rounded-2xl p-4 space-y-4">
        <div className="flex items-center justify-between gap-2 border-b border-vira-border pb-3 flex-wrap">
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={() => setActiveTab('facebook')}
              className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition ${
                activeTab === 'facebook'
                  ? 'bg-vira-accent text-[#0b1220]'
                  : 'bg-vira-card text-vira-muted hover:text-white'
              }`}
            >
              <Cookie className="w-4 h-4" /> Thêm lô Cookie Facebook (UID|Pass|Cookie)
            </button>

            <button
              onClick={() => setActiveTab('cookie')}
              className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition ${
                activeTab === 'cookie'
                  ? 'bg-vira-accent text-[#0b1220]'
                  : 'bg-vira-card text-vira-muted hover:text-white'
              }`}
            >
              <Cookie className="w-4 h-4" /> Thêm bằng Cookie Dola
            </button>

            <button
              onClick={() => setActiveTab('google')}
              className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition ${
                activeTab === 'google'
                  ? 'bg-vira-accent text-[#0b1220]'
                  : 'bg-vira-card text-vira-muted hover:text-white'
              }`}
            >
              <KeyRound className="w-4 h-4" /> Thêm lô Google (Email|Pass)
            </button>

            <button
              onClick={() => setActiveTab('manual')}
              className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition ${
                activeTab === 'manual'
                  ? 'bg-vira-accent text-[#0b1220]'
                  : 'bg-vira-card text-vira-muted hover:text-white'
              }`}
            >
              <Globe className="w-4 h-4" /> Mở trình duyệt đăng nhập tay
            </button>
          </div>

          {/* Target Pool selector when importing */}
          <div className="flex items-center gap-2 text-xs">
            <span className="text-vira-muted whitespace-nowrap">Nạp vào kho:</span>
            <select
              value={effectiveImportPoolId}
              onChange={(e) => {
                setTargetImportPoolId(e.target.value)
                if (selectedPoolId !== ALL_POOLS) {
                  setSelectedPoolId(e.target.value)
                }
              }}
              className="bg-[#0b1220] border border-vira-border rounded-lg px-2.5 py-1.5 text-xs text-vira-accent font-semibold focus:outline-none focus:border-vira-accent"
            >
              {accountPools.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({countInPool(p.id)} acc)
                </option>
              ))}
            </select>
          </div>
        </div>

        {activeTab === 'facebook' && (
          <div className="space-y-3">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <p className="text-xs text-vira-muted">
                Dán danh sách Via / Cookie Facebook mua theo lô (mỗi dòng 1 nick) theo định dạng:{' '}
                <code className="text-vira-accent">
                  UID|Pass|c_user=...; xs=...; datr=...|EAAG...|email|
                </code>{' '}
                hoặc chỉ chuỗi <code className="text-vira-accent">c_user=...; xs=...</code>. Tool sẽ nạp thẳng vào kho đang chọn, tự bơm cookie vào{' '}
                <code className="text-white">.facebook.com</code>, mở Dola bấm Facebook OAuth & vượt cổng tuổi 18+.
              </p>
            </div>

            <textarea
              rows={4}
              value={fbBatchLines}
              onChange={(e) => setFbBatchLines(e.target.value)}
              placeholder={
                'UID|Pass|c_user=...; xs=...; datr=...;|EAAA...|email|'
              }
              className="w-full bg-[#0b1220] border border-vira-border rounded-lg p-2.5 text-xs font-mono focus:outline-none focus:border-vira-accent"
            />

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-center">
              <div>
                <label className="text-xs text-vira-muted block mb-1">Gán Proxy / Key xoay (Tuỳ chọn)</label>
                <select
                  value={selectedProxyId}
                  onChange={(e) => setSelectedProxyId(e.target.value)}
                  className="w-full bg-[#0b1220] border border-vira-border rounded-lg px-3 py-2 text-xs focus:outline-none focus:border-vira-accent"
                >
                  <option value="">Mạng trực tiếp (Không dùng proxy)</option>
                  {rotatingProxies.map((r) => (
                    <option key={`rot:${r.id}`} value={`rot:${r.id}`}>
                      [Key xoay] {r.name} ({r.provider.toUpperCase()})
                    </option>
                  ))}
                  {proxies.map((p) => (
                    <option key={p.id} value={p.id}>
                      [{p.protocol.toUpperCase()}] {p.host}:{p.port}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1.5 md:col-span-2 flex flex-col justify-end">
                <div className="flex items-center justify-between flex-wrap gap-3">
                  <div className="space-y-1">
                    <label className="flex items-center gap-2 text-xs text-vira-muted cursor-pointer">
                      <input
                        type="checkbox"
                        checked={autoLoginFb}
                        onChange={(e) => setAutoLoginFb(e.target.checked)}
                        className="rounded accent-[#2dd4bf]"
                      />
                      Tự động mở Dola đăng nhập bằng Facebook OAuth & xác nhận 18+ ngay
                    </label>
                    <label className="flex items-center gap-2 text-xs text-vira-muted cursor-pointer">
                      <input
                        type="checkbox"
                        checked={showFbWindow}
                        onChange={(e) => setShowFbWindow(e.target.checked)}
                        className="rounded accent-[#2dd4bf]"
                      />
                      Hiện cửa sổ trình duyệt khi đăng nhập (để quan sát trực tiếp)
                    </label>
                  </div>

                  <button
                    onClick={handleAddFacebookBatch}
                    disabled={busyAction !== null}
                    className="px-4 py-2.5 rounded-xl bg-vira-accent text-[#0b1220] font-bold text-xs flex items-center gap-1.5 shadow-lg"
                  >
                    {busyAction === 'add-fb' ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Plus className="w-4 h-4" />
                    )}
                    Nạp Cookie FB & Đăng nhập ({loginConcurrency} luồng)
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'cookie' && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-vira-muted block mb-1">Tên gợi nhớ tài khoản</label>
                <input
                  type="text"
                  value={cookieName}
                  onChange={(e) => setCookieName(e.target.value)}
                  placeholder="VD: Dola Pro #1"
                  className="w-full bg-[#0b1220] border border-vira-border rounded-lg px-3 py-2 text-xs focus:outline-none focus:border-vira-accent"
                />
              </div>
              <div>
                <label className="text-xs text-vira-muted block mb-1">Gán Proxy / Key xoay (Tuỳ chọn)</label>
                <select
                  value={selectedProxyId}
                  onChange={(e) => setSelectedProxyId(e.target.value)}
                  className="w-full bg-[#0b1220] border border-vira-border rounded-lg px-3 py-2 text-xs focus:outline-none focus:border-vira-accent"
                >
                  <option value="">Mạng trực tiếp (Không dùng proxy)</option>
                  {rotatingProxies.map((r) => (
                    <option key={`rot:${r.id}`} value={`rot:${r.id}`}>
                      [Key xoay] {r.name} ({r.provider.toUpperCase()})
                    </option>
                  ))}
                  {proxies.map((p) => (
                    <option key={p.id} value={p.id}>
                      [{p.protocol.toUpperCase()}] {p.host}:{p.port}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div>
              <label className="text-xs text-vira-muted block mb-1">
                Cookie Dola hoặc JSON nick (dán cả file seedance-accounts để nhập nhiều nick một lần · hỗ trợ Header `k=v; k2=v2`, Cookie-Editor, Netscape)
              </label>
              <textarea
                rows={6}
                value={cookieRaw}
                onChange={(e) => setCookieRaw(e.target.value)}
                placeholder={'sid_guard=...; sessionid=...; sid_tt=...\nhoặc dán JSON: { "loai": "seedance-accounts", "tai_khoan": [ ... ] }'}
                className="w-full bg-[#0b1220] border border-vira-border rounded-lg p-2.5 text-xs font-mono focus:outline-none focus:border-vira-accent"
              />
            </div>

            <button
              onClick={handleAddCookie}
              disabled={busyAction !== null}
              className="px-4 py-2 rounded-xl bg-vira-accent text-[#0b1220] font-bold text-xs flex items-center gap-1.5"
            >
              <Plus className="w-4 h-4" /> Thêm & Kiểm tra Cookie
            </button>
          </div>
        )}

        {activeTab === 'google' && (
          <div className="space-y-3">
            <p className="text-xs text-vira-muted">
              Nhập mỗi dòng 1 tài khoản Google theo định dạng <code className="text-vira-accent">email|mật_khẩu</code> hoặc{' '}
              <code className="text-vira-accent">email:mật_khẩu</code>. Tài khoản có Email/Pass sẽ tự động xoá & tạo mới được Dola khi bấm{' '}
              <strong className="text-white">Làm mới lượt (Recycle)</strong>.
            </p>
            <textarea
              rows={4}
              value={googleBatchLines}
              onChange={(e) => setGoogleBatchLines(e.target.value)}
              placeholder={'example1@gmail.com|MatKhau123\nexample2@gmail.com|MatKhau456'}
              className="w-full bg-[#0b1220] border border-vira-border rounded-lg p-2.5 text-xs font-mono focus:outline-none focus:border-vira-accent"
            />
            <div className="flex items-center justify-between">
              <label className="flex items-center gap-2 text-xs text-vira-muted cursor-pointer">
                <input
                  type="checkbox"
                  checked={autoLoginGoogle}
                  onChange={(e) => setAutoLoginGoogle(e.target.checked)}
                  className="rounded accent-[#2dd4bf]"
                />
                Tự động chạy trình duyệt ẩn đăng nhập Dola & vượt cổng tuổi 18+ ngay sau khi thêm
              </label>
              <button
                onClick={handleAddGoogleBatch}
                disabled={busyAction !== null}
                className="px-4 py-2 rounded-xl bg-vira-accent text-[#0b1220] font-bold text-xs flex items-center gap-1.5"
              >
                <Plus className="w-4 h-4" /> Nhập lô tài khoản Google
              </button>
            </div>
          </div>
        )}

        {activeTab === 'manual' && (
          <div className="flex items-end gap-3">
            <div className="flex-1">
              <label className="text-xs text-vira-muted block mb-1">
                Tên hồ sơ trình duyệt mới
              </label>
              <input
                type="text"
                value={manualName}
                onChange={(e) => setManualName(e.target.value)}
                placeholder="VD: Acc Google/Apple đăng nhập tay #1"
                className="w-full bg-[#0b1220] border border-vira-border rounded-lg px-3 py-2 text-xs focus:outline-none focus:border-vira-accent"
              />
            </div>
            <button
              onClick={handleCreateManual}
              disabled={busyAction !== null}
              className="px-4 py-2 rounded-xl bg-vira-accent text-[#0b1220] font-bold text-xs flex items-center gap-1.5"
            >
              <Globe className="w-4 h-4" /> Tạo hồ sơ & Mở trình duyệt Dola
            </button>
          </div>
        )}
      </div>

      {/* 4. BULK ACTION BAR WHEN ACCOUNTS ARE SELECTED */}
      {selectedAccIds.length > 0 && (
        <div className="flex items-center justify-between flex-wrap gap-3 bg-vira-card border border-vira-accent/50 rounded-xl px-4 py-2.5 text-xs">
          <div className="flex items-center gap-2">
            <span className="px-2 py-0.5 rounded-full bg-vira-accent text-[#0b1220] font-bold">
              Đã chọn {selectedAccIds.length} acc
            </span>
            <button
              onClick={() => setSelectedAccIds([])}
              className="text-vira-muted hover:text-white underline"
            >
              Bỏ chọn
            </button>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <div className="flex items-center gap-1.5">
              <ArrowRightLeft className="w-3.5 h-3.5 text-vira-accent" />
              <span className="text-vira-muted">Chuyển sang kho:</span>
              <select
                value={bulkTargetPoolId}
                onChange={(e) => setBulkTargetPoolId(e.target.value)}
                className="bg-[#0b1220] border border-vira-border rounded-lg px-2.5 py-1 text-xs text-white focus:outline-none focus:border-vira-accent"
              >
                {accountPools.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <button
                onClick={handleBulkAssignPool}
                className="px-3 py-1 rounded-lg bg-vira-accent text-[#0b1220] font-bold"
              >
                Chuyển kho
              </button>
            </div>

            <button
              onClick={handleBulkLoginFb}
              disabled={busyAction !== null}
              className="px-3 py-1 rounded-lg bg-blue-500/20 border border-blue-400/50 text-blue-300 hover:bg-blue-500 hover:text-white font-semibold"
            >
              Đăng nhập FB ({selectedAccIds.length} acc · {loginConcurrency} luồng)
            </button>

            <button
              onClick={handleBulkDelete}
              className="px-3 py-1 rounded-lg bg-rose-500/15 border border-rose-400/40 text-rose-300 hover:bg-rose-500/30 font-semibold"
            >
              Xoá ({selectedAccIds.length})
            </button>
          </div>
        </div>
      )}

      {/* 5. ACCOUNTS TABLE */}
      <div className="bg-vira-panel border border-vira-border rounded-2xl overflow-hidden">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-vira-border bg-[#0b1220] text-[11px] uppercase tracking-wider text-vira-muted">
              <th className="py-3 px-3 w-8">
                <input
                  type="checkbox"
                  checked={
                    visibleAccounts.length > 0 &&
                    visibleAccounts.every((a) => selectedAccIds.includes(a.id))
                  }
                  onChange={toggleSelectAllVisible}
                  title="Chọn tất cả tài khoản đang hiển thị"
                  className="rounded accent-[#2dd4bf] w-4 h-4 cursor-pointer"
                />
              </th>
              <th className="py-3 px-3">Bật</th>
              <th className="py-3 px-4">Tài khoản</th>
              <th className="py-3 px-3">Kho tài khoản</th>
              <th className="py-3 px-3">Loại</th>
              <th className="py-3 px-3">Proxy gắn kèm</th>
              <th className="py-3 px-3">Trạng thái</th>
              <th className="py-3 px-3">Đã tạo hôm nay</th>
              <th className="py-3 px-4 text-right">Thao tác</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-vira-border text-xs">
            {visibleAccounts.length === 0 ? (
              <tr>
                <td colSpan={9} className="py-12 text-center text-vira-muted">
                  {selectedPoolId === ALL_POOLS
                    ? 'Chưa có tài khoản Dola nào. Hãy thêm tài khoản ở khung phía trên để bắt đầu.'
                    : `Chưa có tài khoản nào trong "${selectedPoolObj?.name}". Bạn có thể nạp lô via mới vào kho này hoặc chuyển acc từ kho khác sang.`}
                </td>
              </tr>
            ) : (
              visibleAccounts.map((acc) => (
                <tr key={acc.id} className="hover:bg-vira-card/60 transition">
                  <td className="py-3 px-3">
                    <input
                      type="checkbox"
                      checked={selectedAccIds.includes(acc.id)}
                      onChange={() => toggleSelectOne(acc.id)}
                      className="rounded accent-[#2dd4bf] w-4 h-4 cursor-pointer"
                    />
                  </td>
                  <td className="py-3 px-3">
                    <input
                      type="checkbox"
                      checked={acc.enabled}
                      onChange={(e) =>
                        window.api.updateAccount(acc.id, { enabled: e.target.checked })
                      }
                      className="rounded accent-[#2dd4bf] w-4 h-4 cursor-pointer"
                    />
                  </td>
                  <td className="py-3 px-4">
                    <div className="font-bold text-white">{acc.name}</div>
                    {acc.fbUid && (
                      <div className="text-[11px] text-blue-400">FB UID: {acc.fbUid}</div>
                    )}
                    {acc.email && (
                      <div className="text-[11px] text-vira-muted truncate max-w-[22rem]" title={acc.email}>
                        {acc.email}
                      </div>
                    )}
                    {acc.statusMessage && (
                      <div className="text-[11px] text-vira-muted mt-0.5 line-clamp-1">
                        {acc.statusMessage}
                      </div>
                    )}
                  </td>
                  <td className="py-3 px-3">
                    <select
                      value={poolOfAccount(acc)}
                      onChange={(e) =>
                        window.api.updateAccount(acc.id, { poolId: e.target.value })
                      }
                      className="bg-[#0b1220] border border-vira-border rounded-lg px-2 py-1 text-xs text-vira-accent font-medium focus:outline-none focus:border-vira-accent max-w-[150px]"
                    >
                      {accountPools.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="py-3 px-3">
                    <span className="px-2 py-0.5 rounded bg-[#0b1220] border border-vira-border text-[11px] uppercase">
                      {acc.sourceType}
                    </span>
                  </td>
                  <td className="py-3 px-3">
                    <select
                      value={acc.proxyId || ''}
                      onChange={(e) =>
                        window.api.updateAccount(acc.id, {
                          proxyId: e.target.value || undefined
                        })
                      }
                      className="bg-[#0b1220] border border-vira-border rounded-lg px-2 py-1 text-xs focus:outline-none focus:border-vira-accent max-w-[175px]"
                    >
                      <option value="">Trực tiếp (Direct)</option>
                      {rotatingProxies.map((r) => (
                        <option key={`rot:${r.id}`} value={`rot:${r.id}`}>
                          [Xoay] {r.name}
                        </option>
                      ))}
                      {proxies.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.host}:{p.port}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="py-3 px-3">{renderStatusBadge(acc)}</td>
                  <td className="py-3 px-3">
                    <span className="font-bold text-vira-accent">{acc.videosToday || 0}</span> video
                    <span className="text-vira-muted ml-1">(Tổng: {acc.totalVideos || 0})</span>
                  </td>
                  <td className="py-3 px-4 text-right">
                    <div className="inline-flex items-center gap-1.5">
                      <button
                        onClick={() => window.api.checkAccount(acc.id)}
                        title="Kiểm tra phiên đăng nhập"
                        className="px-2.5 py-1.5 rounded-lg bg-[#0b1220] border border-vira-border hover:border-vira-accent text-vira-muted hover:text-white"
                      >
                        Kiểm tra
                      </button>

                      <button
                        onClick={async () => {
                          setFeedback(`Đang làm mới lượt cho tài khoản ${acc.name}…`)
                          const r = await window.api.recycleAccount(acc.id)
                          setFeedback(r.message)
                        }}
                        title="Xoá tài khoản Dola cũ & đăng nhập lại để lấy đầy lượt tạo video mới"
                        className="px-2.5 py-1.5 rounded-lg bg-vira-accent/15 border border-vira-accent/50 hover:bg-vira-accent hover:text-[#0b1220] text-vira-accent font-semibold transition"
                      >
                        Làm mới lượt
                      </button>

                      {acc.sourceType === 'facebook' && (acc.fbCookie || acc.password) && (
                        <button
                          onClick={async () => {
                            setFeedback(`Đang mở Dola & tự động đăng nhập Facebook cho ${acc.name}…`)
                            const r = await window.api.loginFacebookAccount(acc.id, true)
                            setFeedback(r.message)
                          }}
                          title="Bơm lại Cookie FB & tự bấm nút Facebook OAuth trên Dola"
                          className="px-2.5 py-1.5 rounded-lg bg-blue-500/20 border border-blue-400/50 hover:bg-blue-500 hover:text-white text-blue-300 font-semibold transition"
                        >
                          Đăng nhập FB
                        </button>
                      )}

                      {acc.sourceType === 'google' && acc.email && (
                        <button
                          onClick={() => window.api.loginGoogleAccount(acc.id)}
                          title="Tự động điền lại Google Email/Pass"
                          className="px-2.5 py-1.5 rounded-lg bg-[#0b1220] border border-vira-border hover:border-vira-accent text-vira-muted hover:text-white"
                        >
                          Đăng nhập lại
                        </button>
                      )}

                      <button
                        onClick={() => window.api.openAccountBrowser(acc.id)}
                        title="Mở cửa sổ trình duyệt của tài khoản này"
                        className="p-1.5 rounded-lg bg-[#0b1220] border border-vira-border hover:border-vira-accent text-vira-muted hover:text-white"
                      >
                        <Globe className="w-3.5 h-3.5" />
                      </button>

                      <button
                        onClick={() => window.api.deleteAccount(acc.id)}
                        title="Xoá tài khoản"
                        className="p-1.5 rounded-lg bg-rose-500/10 text-rose-300 hover:bg-rose-500/20"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

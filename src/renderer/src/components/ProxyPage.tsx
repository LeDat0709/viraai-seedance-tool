import React, { useState } from 'react'
import {
  Shield,
  Plus,
  RefreshCw,
  Trash2,
  Link2,
  CheckCircle2,
  XCircle,
  Loader2,
  Key,
  CloudDownload,
  Layers
} from 'lucide-react'
import {
  AccountPoolEntry,
  ProxyEntry,
  RotatingProxyEntry,
  RotatingProxyProvider
} from '../../../shared/types'

interface ProxyPageProps {
  proxies: ProxyEntry[]
  rotatingProxies: RotatingProxyEntry[]
  accountPools?: AccountPoolEntry[]
}

const TOPPROXY_PROVINCES: Array<{ value: string; label: string }> = [
  { value: '0', label: '0. Ngẫu nhiên (Random)' },
  { value: '3', label: '3. Hà Nội' },
  { value: '6', label: '6. Hồ Chí Minh' },
  { value: '16', label: '16. Đà Nẵng' },
  { value: '25', label: '25. Hải Phòng' },
  { value: '26', label: '26. Quảng Ninh' },
  { value: '1', label: '1. Phú Thọ' },
  { value: '2', label: '2. Tuyên Quang' },
  { value: '4', label: '4. Hải Dương' },
  { value: '5', label: '5. Bắc Giang' },
  { value: '7', label: '7. Tây Ninh' },
  { value: '8', label: '8. Đồng Nai' },
  { value: '9', label: '9. Vũng Tàu' },
  { value: '10', label: '10. Bình Dương' },
  { value: '11', label: '11. Nghệ An' },
  { value: '12', label: '12. Hà Tĩnh' },
  { value: '13', label: '13. Quảng Bình' },
  { value: '14', label: '14. Quảng Trị' },
  { value: '15', label: '15. Huế' },
  { value: '17', label: '17. Vĩnh Phúc' },
  { value: '18', label: '18. Yên Bái' },
  { value: '19', label: '19. Lào Cai' },
  { value: '20', label: '20. Lạng Sơn' },
  { value: '21', label: '21. Thái Nguyên' },
  { value: '22', label: '22. Hà Nam' },
  { value: '23', label: '23. Nam Định' },
  { value: '24', label: '24. Thái Bình' },
  { value: '27', label: '27. Cà Mau' },
  { value: '28', label: '28. Kiên Giang' },
  { value: '29', label: '29. Bạc Liêu' },
  { value: '30', label: '30. Sóc Trăng' },
  { value: '31', label: '31. Hậu Giang' }
]

export const ProxyPage: React.FC<ProxyPageProps> = ({
  proxies,
  rotatingProxies,
  accountPools = []
}) => {
  const [rawStaticLines, setRawStaticLines] = useState('')
  const [staticProtocol, setStaticProtocol] = useState<'http' | 'socks5'>('http')

  const [rotName, setRotName] = useState('')
  const [rotProvider, setRotProvider] = useState<RotatingProxyProvider>('topproxy')
  const [rotKeysText, setRotKeysText] = useState('')
  const [rotProtocol, setRotProtocol] = useState<'http' | 'socks5'>('http')
  const [rotNhamang, setRotNhamang] = useState<string>('Random')
  const [rotTinhthanh, setRotTinhthanh] = useState<string>('0')
  const [addingRot, setAddingRot] = useState(false)

  // TopProxy.vn Master Account Sync
  const [topProxyMasterKey, setTopProxyMasterKey] = useState('')
  const [syncStaticType, setSyncStaticType] = useState<string>('all')
  const [syncingTopProxy, setSyncingTopProxy] = useState(false)

  // Pool-aware pairing
  const [pairPoolId, setPairPoolId] = useState<string>('all')
  const [feedback, setFeedback] = useState<string | null>(null)

  const handleAddStaticBatch = async () => {
    if (!rawStaticLines.trim()) return
    const res = await window.api.addProxiesBatch(rawStaticLines, staticProtocol)
    setRawStaticLines('')
    setFeedback(`Đã thêm ${res.added} proxy tĩnh (${res.skipped} dòng trùng/bỏ qua).`)
  }

  const handleAddRotatingBatch = async () => {
    if (!rotKeysText.trim() || addingRot) return
    setAddingRot(true)
    try {
      const res = await window.api.addRotatingProxiesBatch({
        rawKeys: rotKeysText,
        provider: rotProvider,
        protocol: rotProtocol,
        namePrefix: rotName.trim() || undefined,
        nhamang: rotNhamang,
        tinhthanh: rotTinhthanh
      })
      setRotName('')
      setRotKeysText('')
      setFeedback(
        `Đã thêm và lấy IP cho ${res.added} key xoay (${res.skipped} key trùng đã bỏ qua)!`
      )
    } finally {
      setAddingRot(false)
    }
  }

  const handleSyncTopProxyAccount = async () => {
    if (!topProxyMasterKey.trim() || syncingTopProxy) return
    setSyncingTopProxy(true)
    try {
      const res = await window.api.syncTopProxyAccount({
        accountApiKey: topProxyMasterKey.trim(),
        protocol: rotProtocol,
        nhamang: rotNhamang,
        tinhthanh: rotTinhthanh,
        syncRotating: true,
        syncStaticType: syncStaticType || undefined
      })
      setFeedback(res.message)
    } finally {
      setSyncingTopProxy(false)
    }
  }

  const handleAutoPair = async (mode: '1_to_1' | '1_per_pool') => {
    const res = await window.api.autoPairProxies({
      poolId: pairPoolId,
      mode
    })
    setFeedback(res.message)
  }

  return (
    <div className="h-full overflow-y-auto p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold flex items-center gap-2">
            <Shield className="w-6 h-6 text-vira-accent" />
            Quản lý Proxy Tĩnh &amp; Key Proxy Xoay (TopProxy.vn / TMProxy / Kiot / WW)
          </h1>
          <p className="text-xs text-vira-muted mt-1">
            Hỗ trợ trực tiếp API Xoay <span className="text-vira-accent font-mono">proxyxoay.shop/api/get.php</span> &amp; đồng bộ tài khoản <span className="text-vira-accent font-mono">topproxy.vn</span>, gán cố định theo từng Kho Via để chống văng phiên.
          </p>
        </div>

        <div className="flex items-center flex-wrap gap-2">
          <button
            onClick={() => window.api.rotateAllProxyKeys(false)}
            className="px-3 py-2 rounded-xl bg-vira-card border border-vira-border hover:border-vira-accent text-xs font-semibold flex items-center gap-1.5"
            title="Kiểm tra & cập nhật IP hiện tại của toàn bộ Key xoay"
          >
            <RefreshCw className="w-3.5 h-3.5 text-vira-accent" /> Kiểm tra tất cả Key xoay
          </button>

          <button
            onClick={() => window.api.checkAllProxies()}
            className="px-3 py-2 rounded-xl bg-vira-card border border-vira-border hover:border-vira-accent text-xs font-semibold flex items-center gap-1.5"
          >
            <RefreshCw className="w-3.5 h-3.5" /> Kiểm tra Proxy tĩnh
          </button>

          {accountPools.length > 0 && (
            <select
              value={pairPoolId}
              onChange={(e) => setPairPoolId(e.target.value)}
              className="bg-[#0b1220] border border-vira-border rounded-xl px-2.5 py-2 text-xs text-white focus:outline-none focus:border-vira-accent"
            >
              <option value="all">Áp dụng: Tất cả Kho</option>
              {accountPools.map((p) => (
                <option key={p.id} value={p.id}>
                  Kho: {p.name}
                </option>
              ))}
            </select>
          )}

          <button
            onClick={() => handleAutoPair('1_per_pool')}
            className="px-3.5 py-2 rounded-xl bg-emerald-500/20 border border-emerald-500/40 text-emerald-200 hover:bg-emerald-500/30 font-bold text-xs flex items-center gap-1.5"
            title="Mỗi Kho Tài Khoản dùng chung 1 Proxy/Key xoay cố định (Khuyên dùng cho Kho Via 3-5 nick)"
          >
            <Layers className="w-4 h-4" /> Gán 1 Proxy / 1 Kho Via
          </button>

          <button
            onClick={() => handleAutoPair('1_to_1')}
            className="px-3.5 py-2 rounded-xl bg-vira-accent text-[#0b1220] font-bold text-xs flex items-center gap-1.5"
          >
            <Link2 className="w-4 h-4" /> Ghép 1-1 vào từng Tài khoản
          </button>
        </div>
      </div>

      {feedback && (
        <div className="p-3 rounded-xl bg-vira-accent/15 border border-vira-accent text-xs text-vira-accent font-medium flex items-center justify-between">
          <span>{feedback}</span>
          <button
            onClick={() => setFeedback(null)}
            className="text-[11px] underline opacity-80 hover:opacity-100"
          >
            Đóng
          </button>
        </div>
      )}

      {/* TOPPROXY.VN QUICK SYNC BANNER */}
      <div className="bg-vira-panel border border-vira-accent/40 rounded-2xl p-4 space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <CloudDownload className="w-4 h-4 text-vira-accent" />
            <span className="text-xs font-bold text-white">
              Đồng bộ tự động từ tài khoản TopProxy.vn (Lấy toàn bộ Key xoay &amp; Proxy tĩnh còn hạn)
            </span>
          </div>
          <span className="text-[11px] text-vira-muted font-mono">
            API: topproxy.vn/proxyxoay/apigetkeyxoay.php &amp; apiv2/listproxy.php
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-12 gap-2.5">
          <input
            type="text"
            value={topProxyMasterKey}
            onChange={(e) => setTopProxyMasterKey(e.target.value)}
            placeholder="Nhập API Key tài khoản TopProxy.vn (key=[key] dùng để mua/lấy danh sách key xoay)..."
            className="md:col-span-6 bg-[#0b1220] border border-vira-border rounded-lg px-3 py-2 text-xs font-mono focus:outline-none focus:border-vira-accent"
          />
          <select
            value={syncStaticType}
            onChange={(e) => setSyncStaticType(e.target.value)}
            className="md:col-span-3 bg-[#0b1220] border border-vira-border rounded-lg px-2.5 py-2 text-xs"
          >
            <option value="all">Lấy cả Key Xoay + Tất cả Proxy Tĩnh</option>
            <option value="">Chỉ lấy Key Xoay (apigetkeyxoay)</option>
            <option value="4Gvinaphone">Kèm Proxy 4G Vinaphone</option>
            <option value="Viettel">Kèm Proxy Tĩnh Viettel</option>
            <option value="FPT">Kèm Proxy Tĩnh FPT</option>
            <option value="VNPT">Kèm Proxy Tĩnh VNPT</option>
            <option value="US">Kèm Proxy Tĩnh US</option>
          </select>
          <button
            onClick={handleSyncTopProxyAccount}
            disabled={syncingTopProxy || !topProxyMasterKey.trim()}
            className="md:col-span-3 px-4 py-2 rounded-lg bg-vira-accent text-[#0b1220] font-bold text-xs flex items-center justify-center gap-1.5 disabled:opacity-50"
          >
            {syncingTopProxy ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <CloudDownload className="w-4 h-4" />
            )}
            Đồng bộ TopProxy.vn
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* LEFT: ROTATING PROXY KEYS */}
        <div className="bg-vira-panel border border-vira-border rounded-2xl p-4 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold flex items-center gap-2 text-vira-accent">
              <Key className="w-4 h-4" /> Key Proxy Xoay ({rotatingProxies.length})
            </h2>
            {rotatingProxies.length > 0 && (
              <button
                onClick={() => window.api.rotateAllProxyKeys(true)}
                className="px-2.5 py-1 rounded-lg bg-[#0b1220] border border-vira-border hover:border-vira-accent text-[11px] flex items-center gap-1 text-vira-accent"
              >
                <RefreshCw className="w-3 h-3" /> Xoay IP toàn bộ
              </button>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
            <input
              type="text"
              value={rotName}
              onChange={(e) => setRotName(e.target.value)}
              placeholder="Tiền tố tên (VD: TopProxy)"
              className="bg-[#0b1220] border border-vira-border rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:border-vira-accent"
            />
            <select
              value={rotProvider}
              onChange={(e) => setRotProvider(e.target.value as RotatingProxyProvider)}
              className="bg-[#0b1220] border border-vira-border rounded-lg px-2.5 py-1.5 text-xs focus:outline-none focus:border-vira-accent font-semibold text-vira-accent"
            >
              <option value="topproxy">TopProxy.vn (proxyxoay.shop)</option>
              <option value="tmproxy">TMProxy.com</option>
              <option value="kiotproxy">KiotProxy.com</option>
              <option value="wwproxy">WWProxy.com</option>
              <option value="tinsoft">TinsoftProxy</option>
              <option value="custom">API URL tuỳ chỉnh</option>
            </select>
            <select
              value={rotProtocol}
              onChange={(e) => setRotProtocol(e.target.value as 'http' | 'socks5')}
              className="bg-[#0b1220] border border-vira-border rounded-lg px-2.5 py-1.5 text-xs"
            >
              <option value="http">Giao thức: HTTP (proxyhttp)</option>
              <option value="socks5">Giao thức: SOCKS5 (proxysocks5)</option>
            </select>
          </div>

          {/* TopProxy specific parameters: nhamang & tinhthanh */}
          {rotProvider === 'topproxy' && (
            <div className="grid grid-cols-2 gap-2.5 p-2.5 rounded-xl bg-[#0b1220]/70 border border-vira-border">
              <div className="space-y-1">
                <label className="text-[11px] text-vira-muted block">
                  Nhà mạng (<span className="font-mono text-vira-accent">nhamang</span>)
                </label>
                <select
                  value={rotNhamang}
                  onChange={(e) => setRotNhamang(e.target.value)}
                  className="w-full bg-[#0b1220] border border-vira-border rounded-lg px-2.5 py-1.5 text-xs"
                >
                  <option value="Random">Random (Tất cả nhà mạng)</option>
                  <option value="viettel">Viettel</option>
                  <option value="fpt">FPT</option>
                  <option value="vnpt">VNPT</option>
                </select>
              </div>
              <div className="space-y-1">
                <label className="text-[11px] text-vira-muted block">
                  Tỉnh thành (<span className="font-mono text-vira-accent">tinhthanh</span>)
                </label>
                <select
                  value={rotTinhthanh}
                  onChange={(e) => setRotTinhthanh(e.target.value)}
                  className="w-full bg-[#0b1220] border border-vira-border rounded-lg px-2.5 py-1.5 text-xs"
                >
                  {TOPPROXY_PROVINCES.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}

          <textarea
            rows={3}
            value={rotKeysText}
            onChange={(e) => setRotKeysText(e.target.value)}
            placeholder={
              rotProvider === 'topproxy'
                ? 'Dán mỗi dòng 1 keyxoay TopProxy (VD: rwywzSOvFNZOWDVJJBrQRb)\nhoặc dán nguyên link https://proxyxoay.shop/api/get.php?key=...'
                : 'Dán mỗi dòng 1 API Key xoay (hoặc URL API trả về proxy)...'
            }
            className="w-full bg-[#0b1220] border border-vira-border rounded-lg p-2.5 text-xs font-mono focus:outline-none focus:border-vira-accent"
          />

          <button
            onClick={handleAddRotatingBatch}
            disabled={addingRot || !rotKeysText.trim()}
            className="px-4 py-1.5 rounded-lg bg-vira-accent text-[#0b1220] font-bold text-xs flex items-center gap-1.5 disabled:opacity-50"
          >
            {addingRot ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Plus className="w-3.5 h-3.5" />
            )}
            Thêm Key Xoay &amp; Lấy IP ngay
          </button>

          <div className="space-y-2 max-h-80 overflow-y-auto">
            {rotatingProxies.length === 0 ? (
              <div className="text-center py-8 text-xs text-vira-muted">
                Chưa có key proxy xoay nào. Dán key xoay ở trên hoặc bấm Đồng bộ TopProxy.vn.
              </div>
            ) : (
              rotatingProxies.map((rot) => (
                <div
                  key={rot.id}
                  className="bg-vira-card border border-vira-border rounded-xl p-3 flex items-center justify-between gap-2"
                >
                  <div className="min-w-0">
                    <div className="flex items-center flex-wrap gap-1.5">
                      <span className="text-xs font-bold text-white">{rot.name}</span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#0b1220] border border-vira-border text-vira-muted uppercase">
                        {rot.provider} · {rot.protocol}
                      </span>
                      {rot.currentProxy && (
                        <span className="text-[11px] text-vira-accent font-mono font-semibold">
                          {rot.currentProxy}
                        </span>
                      )}
                      {rot.status === 'active' && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 font-semibold">
                          Sẵn sàng
                        </span>
                      )}
                      {rot.status === 'cooldown' && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 font-semibold">
                          Giữ IP hiện tại
                        </span>
                      )}
                      {(rot.status === 'error' || rot.status === 'expired') && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-rose-500/15 text-rose-300 font-semibold">
                          {rot.status === 'expired' ? 'Hết hạn' : 'Lỗi'}
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] text-vira-muted mt-1 truncate">
                      {rot.statusMessage || `Key: ${rot.apiKey.slice(0, 14)}...`}
                    </p>
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      onClick={() => window.api.rotateProxyKey(rot.id, true)}
                      className="px-2.5 py-1 rounded-lg bg-[#0b1220] border border-vira-border hover:border-vira-accent text-xs flex items-center gap-1"
                    >
                      <RefreshCw
                        className={`w-3 h-3 ${rot.status === 'checking' ? 'animate-spin' : ''}`}
                      />
                      Lấy / Đổi IP
                    </button>
                    <button
                      onClick={() => window.api.deleteRotatingProxy(rot.id)}
                      className="p-1.5 rounded-lg bg-rose-500/10 text-rose-300 hover:bg-rose-500/20"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* RIGHT: STATIC PROXIES */}
        <div className="bg-vira-panel border border-vira-border rounded-2xl p-4 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold flex items-center gap-2 text-vira-accent">
              <Shield className="w-4 h-4" /> Danh sách Proxy Tĩnh ({proxies.length})
            </h2>
            <select
              value={staticProtocol}
              onChange={(e) => setStaticProtocol(e.target.value as 'http' | 'socks5')}
              className="bg-[#0b1220] border border-vira-border rounded-lg px-2.5 py-1 text-xs"
            >
              <option value="http">Mặc định HTTP</option>
              <option value="socks5">Mặc định SOCKS5</option>
            </select>
          </div>

          <textarea
            rows={3}
            value={rawStaticLines}
            onChange={(e) => setRawStaticLines(e.target.value)}
            placeholder={
              'Nhập mỗi dòng 1 proxy:\nhost:port:user:pass\nhoặc host:port:: (định dạng TopProxy)\nhoặc socks5://user:pass@host:port'
            }
            className="w-full bg-[#0b1220] border border-vira-border rounded-lg p-2.5 text-xs font-mono focus:outline-none focus:border-vira-accent"
          />

          <button
            onClick={handleAddStaticBatch}
            className="px-4 py-1.5 rounded-lg bg-vira-accent text-[#0b1220] font-bold text-xs flex items-center gap-1"
          >
            <Plus className="w-3.5 h-3.5" /> Thêm vào danh sách Proxy tĩnh
          </button>

          <div className="space-y-2 max-h-80 overflow-y-auto">
            {proxies.length === 0 ? (
              <div className="text-center py-8 text-xs text-vira-muted">
                Chưa có proxy tĩnh nào trong pool.
              </div>
            ) : (
              proxies.map((px) => (
                <div
                  key={px.id}
                  className="bg-vira-card border border-vira-border rounded-xl p-2.5 flex items-center justify-between gap-2 text-xs"
                >
                  <div className="min-w-0">
                    <div className="flex items-center flex-wrap gap-2">
                      <span className="font-mono font-bold text-white">
                        {px.protocol.toUpperCase()}://{px.host}:{px.port}
                      </span>
                      {px.label && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#0b1220] border border-vira-border text-vira-muted">
                          {px.label}
                        </span>
                      )}
                      {px.status === 'alive' && (
                        <span className="inline-flex items-center gap-1 text-[11px] text-vira-accent">
                          <CheckCircle2 className="w-3.5 h-3.5" /> Sống ({px.latencyMs}ms · IP:{' '}
                          {px.exitIp})
                        </span>
                      )}
                      {px.status === 'dead' && (
                        <span className="inline-flex items-center gap-1 text-[11px] text-rose-300">
                          <XCircle className="w-3.5 h-3.5" /> Chết
                        </span>
                      )}
                      {px.status === 'checking' && (
                        <Loader2 className="w-3.5 h-3.5 text-blue-400 animate-spin" />
                      )}
                    </div>
                    {px.errorMessage && (
                      <div className="text-[11px] text-rose-300 mt-0.5 truncate">
                        {px.errorMessage}
                      </div>
                    )}
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      onClick={() => window.api.checkProxy(px.id)}
                      className="px-2 py-1 rounded bg-[#0b1220] border border-vira-border hover:border-vira-accent text-[11px]"
                    >
                      Kiểm tra
                    </button>
                    <button
                      onClick={() => window.api.deleteProxy(px.id)}
                      className="p-1 rounded bg-rose-500/10 text-rose-300 hover:bg-rose-500/20"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

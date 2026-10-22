import React from 'react'
import {
  Settings as SettingsIcon,
  Folders,
  Bot,
  Clapperboard,
  HardDrive,
  FolderOpen,
  ExternalLink,
  Eye,
  Server
} from 'lucide-react'
import { AppSettings, BatchAllocationMode } from '../../../shared/types'

interface SettingsPageProps {
  settings: AppSettings
}

const TIMEOUTS = [3, 5, 10, 12, 20]

const Toggle: React.FC<{ checked: boolean; onChange: (v: boolean) => void }> = ({
  checked,
  onChange
}) => (
  <label className="relative inline-flex items-center cursor-pointer shrink-0">
    <input
      type="checkbox"
      checked={checked}
      onChange={(e) => onChange(e.target.checked)}
      className="sr-only peer"
    />
    <div className="w-11 h-6 rounded-full bg-vira-border peer-checked:bg-vira-accent transition-colors after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:after:translate-x-full" />
  </label>
)

export const SettingsPage: React.FC<SettingsPageProps> = ({ settings }) => {
  const set = (patch: Partial<AppSettings>) => window.api.updateSettings(patch)

  const handleChooseOutputDir = async () => {
    const dir = await window.api.selectFolder()
    if (dir) set({ outputDir: dir })
  }

  const sectionTitle = 'text-sm font-bold uppercase tracking-tight text-white flex items-center gap-2'
  const card = 'bg-vira-panel border border-vira-border rounded-2xl p-5 space-y-4'
  const rowLabel = 'text-xs font-semibold text-white'
  const rowDesc = 'text-[11px] text-vira-muted'
  const inputCls =
    'w-full h-9 px-3 rounded-lg bg-vira-bg border border-vira-border text-xs text-white focus:outline-none focus:border-vira-accent'
  const selectCls = inputCls + ' appearance-none cursor-pointer pr-8'

  return (
    <div className="h-full overflow-y-auto p-6 space-y-5 max-w-[1200px] mx-auto">
      {/* Header */}
      <div className="flex items-center gap-3 flex-wrap">
        <span className="w-7 h-7 rounded-lg bg-vira-card text-vira-accent flex items-center justify-center">
          <SettingsIcon className="w-4 h-4" />
        </span>
        <h1 className="text-xl font-bold tracking-tight">Cấu hình Hệ thống</h1>
        <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-vira-accent/10 text-vira-accent text-[10px] tracking-wider uppercase font-semibold">
          <span className="w-1.5 h-1.5 rounded-full bg-vira-accent" /> ViraAI Studio
        </span>
        <p className="w-full text-xs text-vira-muted">
          Thiết lập thư mục xuất file, hiển thị trình duyệt tự động, số luồng và tham số điều phối hàng
          đợi. Mọi thay đổi được lưu ngay.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        {/* LEFT: folders + browser/automation */}
        <div className="lg:col-span-7 flex flex-col gap-5">
          {/* Folder */}
          <section className={card}>
            <h2 className={sectionTitle}>
              <Folders className="w-5 h-5 text-vira-accent" /> Thư mục lưu trữ
            </h2>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-white flex items-center justify-between">
                <span>Đường dẫn lưu video mặc định</span>
                <span className="text-[10px] text-vira-muted">dùng cho dự án mặc định</span>
              </label>
              <div className="flex items-center gap-2">
                <div className="relative flex-1">
                  <HardDrive className="w-4 h-4 text-vira-muted absolute left-3 top-1/2 -translate-y-1/2" />
                  <input readOnly value={settings.outputDir} className={inputCls + ' pl-9 font-mono'} />
                </div>
                <button
                  onClick={handleChooseOutputDir}
                  className="h-9 px-3 rounded-lg bg-vira-accent text-[#0b1220] font-bold text-xs flex items-center gap-1"
                >
                  <FolderOpen className="w-4 h-4" /> Duyệt
                </button>
                <button
                  onClick={() => window.api.openPath(settings.outputDir)}
                  title="Mở thư mục"
                  className="w-9 h-9 flex items-center justify-center rounded-lg bg-vira-card border border-vira-border text-vira-muted hover:text-vira-accent"
                >
                  <ExternalLink className="w-4 h-4" />
                </button>
              </div>
            </div>
          </section>

          {/* Browser & automation */}
          <section className={card}>
            <h2 className={sectionTitle}>
              <Bot className="w-5 h-5 text-vira-accent" /> Trình duyệt &amp; Automation
            </h2>

            <div className="flex items-start justify-between gap-4 pb-3 border-b border-vira-border">
              <div className="flex flex-col gap-0.5">
                <span className={rowLabel}>
                  Chế độ HTTP API trực tiếp (Không cần mở Chrome)
                </span>
                <span className={rowDesc}>
                  Gọi thẳng API /chat/completion &amp; /im/chain/single, tự ký AWS4-HMAC-SHA256 upload ảnh ImageX và giải mã AES-128-CBC (qAAB) tải video gốc không logo (~11 Mbps).
                </span>
              </div>
              <Toggle
                checked={settings.useHttpApiMode !== false}
                onChange={(v) => set({ useHttpApiMode: v, ...(v ? { showBrowserDuringGen: false } : {}) })}
              />
            </div>

            <div className="flex items-start justify-between gap-4 pb-3 border-b border-vira-border">
              <div className="flex flex-col gap-0.5">
                <span className={rowLabel}>
                  <Eye className="w-3.5 h-3.5 text-vira-accent inline mr-1" />
                  Hiện cửa sổ trình duyệt khi tạo video
                </span>
                <span className={rowDesc}>
                  Tắt để chạy ngầm, tiết kiệm RAM. Bật khi cần quan sát / gỡ lỗi trực tiếp bằng trình duyệt.
                </span>
              </div>
              <Toggle
                checked={settings.showBrowserDuringGen}
                onChange={(v) => set({ showBrowserDuringGen: v, ...(v ? { useHttpApiMode: false } : {}) })}
              />
            </div>

            <div className="flex flex-col gap-2 pb-3 border-b border-vira-border">
              <div className="flex items-center justify-between">
                <span className={rowLabel}>Số luồng chạy song song tối đa</span>
                <span className="text-sm font-bold text-vira-accent font-mono">
                  {settings.concurrency} luồng
                </span>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-[11px] text-vira-muted">1</span>
                <input
                  type="range"
                  min={1}
                  max={8}
                  value={settings.concurrency}
                  onChange={(e) => set({ concurrency: Number(e.target.value) })}
                  className="w-full h-1.5 rounded-lg bg-vira-border appearance-none cursor-pointer accent-vira-accent"
                />
                <span className="text-[11px] text-vira-muted">8</span>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1">
                <label className={rowLabel}>Thời gian chờ tối đa mỗi video</label>
                <select
                  value={settings.pollTimeoutMinutes}
                  onChange={(e) => set({ pollTimeoutMinutes: Math.max(3, Number(e.target.value) || 12) })}
                  className={selectCls}
                >
                  {TIMEOUTS.map((m) => (
                    <option key={m} value={m}>
                      {m} phút / tác vụ
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <label className={rowLabel}>Chế độ chia lô tài khoản</label>
                <select
                  value={settings.batchAllocationMode}
                  onChange={(e) => set({ batchAllocationMode: e.target.value as BatchAllocationMode })}
                  className={selectCls}
                >
                  <option value="20_per_acc">20 video / 1 tài khoản</option>
                  <option value="10_per_acc">10 video / 1 tài khoản</option>
                  <option value="even_split">Chia đều xoay vòng (không trần)</option>
                </select>
              </div>
            </div>
          </section>
        </div>

        {/* RIGHT: generation params + server */}
        <div className="lg:col-span-5 flex flex-col gap-5">
          <section className={card}>
            <h2 className={sectionTitle}>
              <Clapperboard className="w-5 h-5 text-vira-accent" /> Tham số tạo video
            </h2>

            <div className="flex items-start justify-between gap-4">
              <div className="flex flex-col gap-0.5">
                <span className={rowLabel}>Luôn ưu tiên chế độ Pro (Seedance 2.5)</span>
                <span className={rowDesc}>
                  Chuyển chip Fast sang Pro bằng click chuột thật trước khi gửi lệnh.
                </span>
              </div>
              <Toggle checked={settings.preferProMode} onChange={(v) => set({ preferProMode: v })} />
            </div>

            <div className="flex items-start justify-between gap-4">
              <div className="flex flex-col gap-0.5">
                <span className={rowLabel}>Chế độ chat gửi lệnh (HTTP API)</span>
                <span className={rowDesc}>
                  Nhanh: gọi thẳng công cụ video. Pro: trợ lý Dola tự đọc hướng dẫn, gọi công cụ và tự thử lại khi
                  lỗi tạm thời.
                </span>
              </div>
              <select
                value={settings.httpChatMode === 'pro' ? 'pro' : 'fast'}
                onChange={(e) => set({ httpChatMode: e.target.value as 'fast' | 'pro' })}
                className="bg-vira-bg border border-vira-border rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-vira-accent"
              >
                <option value="fast">Nhanh</option>
                <option value="pro">Pro (agent)</option>
              </select>
            </div>

            <p className="text-[11px] text-vira-muted pt-2 border-t border-vira-border">
              Tỷ lệ khung hình và thời lượng mặc định được đặt riêng cho từng dự án (ở màn Tạo video) và
              lưu theo dự án.
            </p>
          </section>

          <section className={card}>
            <h2 className={sectionTitle}>
              <Server className="w-5 h-5 text-vira-accent" /> Máy chủ Dola
            </h2>
            <div className="space-y-1.5">
              <label className={rowLabel}>Địa chỉ máy chủ Dola</label>
              <input
                value={settings.dolaBaseUrl}
                onChange={(e) => set({ dolaBaseUrl: e.target.value.trim() })}
                className={inputCls + ' font-mono'}
              />
              <p className={rowDesc}>
                Mặc định: https://www.dola.com — chỉ đổi khi Dola dùng tên miền khác.
              </p>
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}

import React, { useRef, useState } from 'react'
import {
  Bug,
  Play,
  Pause,
  Camera,
  RotateCcw,
  Sparkles,
  Send,
  ExternalLink,
  Gauge,
  Zap
} from 'lucide-react'
import { WebCrawlerOptions } from '../utils/web-crawler-spider'

interface WebCrawlerPageProps {
  overlayRunning: boolean
  overlayOptions: Required<WebCrawlerOptions>
  onToggleOverlay: () => void
  onUpdateOverlayOptions: (patch: Partial<WebCrawlerOptions>) => void
}

export const WebCrawlerPage: React.FC<WebCrawlerPageProps> = ({
  overlayRunning,
  overlayOptions,
  onToggleOverlay,
  onUpdateOverlayOptions
}) => {
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const [stagePaused, setStagePaused] = useState(false)
  const [stageFollow, setStageFollow] = useState(true)
  const [stageSpeed, setStageSpeed] = useState<number>(200)
  const [stageDensity, setStageDensity] = useState<'calm' | 'normal' | 'wild'>('normal')
  const [useLocalhost5190, setUseLocalhost5190] = useState(false)
  const [showCustomScript, setShowCustomScript] = useState(false)
  const [customTitle, setCustomTitle] = useState('ViraAI Seedance 2.5 — Cyber Prompt')
  const [customBody, setCustomBody] = useState(
    'Một chú nhện cơ khí phát sáng neon bước đi trên những dòng kịch bản điện ảnh Seedance 2.5. Mỗi bước chân chạm vào từ ngữ làm bùng lên hiệu ứng ánh sáng cyberpunk, tia tơ laser và chữ biến dạng nhịp nhàng theo chuyển động 60fps.'
  )

  const postToStage = (payload: Record<string, unknown>) => {
    try {
      iframeRef.current?.contentWindow?.postMessage(payload, '*')
    } catch {}
  }

  const handleToggleStagePause = () => {
    const next = !stagePaused
    setStagePaused(next)
    postToStage({ type: 'CRAWLER_TOGGLE_PAUSE', paused: next })
  }

  const handleToggleStageFollow = () => {
    const next = !stageFollow
    setStageFollow(next)
    postToStage({ type: 'CRAWLER_TOGGLE_FOLLOW', follow: next })
  }

  const handleChangeSpeed = (sp: number) => {
    setStageSpeed(sp)
    postToStage({ type: 'CRAWLER_SET_SPEED', speed: sp })
  }

  const handleChangeStageDensity = (d: 'calm' | 'normal' | 'wild') => {
    setStageDensity(d)
    postToStage({ type: 'CRAWLER_SET_DENSITY', density: d })
  }

  const handleInjectCustomText = () => {
    if (!customBody.trim()) return
    postToStage({
      type: 'CRAWLER_INJECT_TEXT',
      title: customTitle.trim() || 'ViraAI Seedance Script',
      body: customBody.trim()
    })
    setShowCustomScript(false)
  }

  const handleReloadStage = () => {
    if (iframeRef.current) {
      iframeRef.current.src = useLocalhost5190
        ? 'http://localhost:5190'
        : './web-crawlers/index.html'
      setStagePaused(false)
      setStageFollow(true)
    }
  }

  return (
    <div className="flex flex-col h-full w-full bg-[#0b1220] text-[#e8eef7] overflow-hidden">
      {/* Top Control Header */}
      <div className="shrink-0 bg-[#080e1a] border-b border-vira-border px-4 py-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-vira-accent/15 border border-vira-accent/40 text-vira-accent flex items-center justify-center font-mono font-bold text-xs">
            /[•]\
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="font-extrabold text-sm text-white">
                Web Crawlers Studio — Nhện Cyber IK 60FPS
              </h2>
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-vira-accent/15 text-vira-accent font-semibold border border-vira-accent/30">
                Procedural DOM Spider
              </span>
            </div>
            <p className="text-[11px] text-vira-muted">
              Di chuyển chuột để dụ nhện đuổi theo · Click để chỉ điểm đến · Phím Space: Tạm dừng · Phím F: Khóa/Mở camera
            </p>
          </div>
        </div>

        {/* Right Controls: App Overlay Spider & Stage Controls */}
        <div className="flex flex-wrap items-center gap-2">
          {/* App UI Overlay Toggle */}
          <div className="flex items-center gap-1.5 bg-vira-card border border-vira-border rounded-xl px-2.5 py-1.5">
            <button
              onClick={onToggleOverlay}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-bold transition ${
                overlayRunning
                  ? 'bg-vira-accent text-[#0b1220] shadow-sm'
                  : 'bg-[#0b1220] text-vira-muted hover:text-white border border-vira-border'
              }`}
              title="Thả nhện Cyber bò trực tiếp lên các chữ của giao diện ViraAI Studio (không cản trở chuột/phím)"
            >
              <Bug className="w-3.5 h-3.5" />
              {overlayRunning ? 'Đang thả nhện trên App' : 'Thả nhện lên giao diện App'}
            </button>

            {/* Size S/M/L */}
            <div className="flex items-center gap-0.5 pl-1 border-l border-vira-border">
              {(['S', 'M', 'L'] as const).map((sz) => (
                <button
                  key={sz}
                  onClick={() => onUpdateOverlayOptions({ size: sz })}
                  className={`px-1.5 py-0.5 rounded text-[10px] font-bold transition ${
                    overlayOptions.size === sz
                      ? 'bg-vira-accent/25 text-vira-accent border border-vira-accent/40'
                      : 'text-vira-muted hover:text-white'
                  }`}
                  title={`Kích thước nhện: ${sz}`}
                >
                  {sz}
                </button>
              ))}
            </div>

            {/* Density Calm/Normal/Wild */}
            <div className="flex items-center gap-0.5 pl-1 border-l border-vira-border">
              {(
                [
                  ['calm', 'Dịu'],
                  ['normal', 'Vừa'],
                  ['wild', 'Mạnh']
                ] as const
              ).map(([dKey, dLabel]) => (
                <button
                  key={dKey}
                  onClick={() => onUpdateOverlayOptions({ density: dKey })}
                  className={`px-1.5 py-0.5 rounded text-[10px] font-bold transition ${
                    overlayOptions.density === dKey
                      ? 'bg-vira-accent/25 text-vira-accent border border-vira-accent/40'
                      : 'text-vira-muted hover:text-white'
                  }`}
                  title={`Mức hiệu ứng Glitch: ${dLabel}`}
                >
                  {dLabel}
                </button>
              ))}
            </div>
          </div>

          {/* Stage Controls */}
          <div className="flex items-center gap-1.5 bg-vira-card border border-vira-border rounded-xl px-2.5 py-1.5">
            <button
              onClick={() => setShowCustomScript(!showCustomScript)}
              className={`flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold transition ${
                showCustomScript
                  ? 'bg-vira-accent text-[#0b1220] font-bold'
                  : 'bg-[#0b1220] text-vira-accent hover:bg-vira-accent/15 border border-vira-accent/30'
              }`}
            >
              <Sparkles className="w-3.5 h-3.5" />
              Chèn chữ / Prompt
            </button>

            <button
              onClick={handleToggleStagePause}
              className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-semibold bg-[#0b1220] text-white hover:bg-vira-border/50 border border-vira-border transition"
              title="Tạm dừng / Tiếp tục sân khấu (Space)"
            >
              {stagePaused ? <Play className="w-3.5 h-3.5 text-vira-accent" /> : <Pause className="w-3.5 h-3.5" />}
              {stagePaused ? 'Tiếp tục' : 'Dừng'}
            </button>

            <button
              onClick={handleToggleStageFollow}
              className={`flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-semibold border transition ${
                stageFollow
                  ? 'bg-vira-accent/15 text-vira-accent border-vira-accent/40'
                  : 'bg-[#0b1220] text-vira-muted border-vira-border hover:text-white'
              }`}
              title="Bật/Tắt camera tự cuộn theo nhện (Phím F)"
            >
              <Camera className="w-3.5 h-3.5" />
              Auto-Scroll
            </button>

            <div className="flex items-center gap-1 pl-1 border-l border-vira-border" title="Tốc độ bò">
              <Gauge className="w-3.5 h-3.5 text-vira-muted" />
              {[120, 200, 320].map((sp) => (
                <button
                  key={sp}
                  onClick={() => handleChangeSpeed(sp)}
                  className={`px-1.5 py-0.5 rounded text-[10px] font-bold transition ${
                    stageSpeed === sp
                      ? 'bg-vira-accent text-[#0b1220]'
                      : 'text-vira-muted hover:text-white'
                  }`}
                >
                  {sp === 120 ? '1x' : sp === 200 ? '1.5x' : '2.5x'}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-1 pl-1 border-l border-vira-border" title="Cường độ hiệu ứng sân khấu">
              <Zap className="w-3.5 h-3.5 text-vira-muted" />
              {(['calm', 'normal', 'wild'] as const).map((d) => (
                <button
                  key={d}
                  onClick={() => handleChangeStageDensity(d)}
                  className={`px-1.5 py-0.5 rounded text-[10px] font-bold uppercase transition ${
                    stageDensity === d
                      ? 'bg-vira-accent/25 text-vira-accent border border-vira-accent/40'
                      : 'text-vira-muted hover:text-white'
                  }`}
                >
                  {d}
                </button>
              ))}
            </div>

            <button
              onClick={() => setUseLocalhost5190(!useLocalhost5190)}
              className={`flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-semibold border transition ${
                useLocalhost5190
                  ? 'bg-blue-500/20 text-blue-300 border-blue-400/40'
                  : 'bg-[#0b1220] text-vira-muted border-vira-border hover:text-white'
              }`}
              title="Chuyển giữa bản tích hợp sẵn trong App và server http://localhost:5190"
            >
              <ExternalLink className="w-3 h-3" />
              {useLocalhost5190 ? 'Port 5190' : 'Built-in'}
            </button>

            <button
              onClick={handleReloadStage}
              className="p-1.5 rounded-lg bg-[#0b1220] text-vira-muted hover:text-white border border-vira-border transition"
              title="Tải lại sân khấu"
            >
              <RotateCcw className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* Collapsible Custom Script / Prompt Injector */}
      {showCustomScript && (
        <div className="shrink-0 bg-[#0d1526] border-b border-vira-border px-4 py-3 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-vira-accent flex items-center gap-1.5">
              <Sparkles className="w-3.5 h-3.5" />
              Đưa Kịch bản / Prompt Video của bạn lên Sân khấu để Nhện Cyber bò qua từng từ
            </span>
            <button
              onClick={() => setShowCustomScript(false)}
              className="text-[11px] text-vira-muted hover:text-white"
            >
              Đóng
            </button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
            <input
              type="text"
              value={customTitle}
              onChange={(e) => setCustomTitle(e.target.value)}
              placeholder="Tiêu đề kịch bản / phân cảnh..."
              className="md:col-span-1 bg-[#080e1a] border border-vira-border rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-vira-accent"
            />
            <div className="md:col-span-3 flex gap-2">
              <textarea
                rows={2}
                value={customBody}
                onChange={(e) => setCustomBody(e.target.value)}
                placeholder="Nhập nội dung kịch bản hoặc prompt tạo video của bạn..."
                className="flex-1 bg-[#080e1a] border border-vira-border rounded-xl px-3 py-1.5 text-xs text-white focus:outline-none focus:border-vira-accent resize-none"
              />
              <button
                onClick={handleInjectCustomText}
                className="px-4 py-2 rounded-xl bg-vira-accent text-[#0b1220] font-extrabold text-xs flex items-center gap-1.5 hover:opacity-90 transition shrink-0"
              >
                <Send className="w-3.5 h-3.5" />
                Đưa lên Sân khấu
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Embedded Web Crawler Stage (60 FPS Canvas + DOM Words) */}
      <div className="flex-1 w-full relative bg-black overflow-hidden">
        <iframe
          ref={iframeRef}
          src={useLocalhost5190 ? 'http://localhost:5190' : './web-crawlers/index.html'}
          title="Web Crawlers /[•]\"
          className="w-full h-full border-0"
        />
      </div>
    </div>
  )
}

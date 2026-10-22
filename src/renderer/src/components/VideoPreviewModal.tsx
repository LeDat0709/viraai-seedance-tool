import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  X,
  FolderOpen,
  Play,
  Pause,
  Repeat,
  Volume2,
  VolumeX,
  Maximize2,
  ChevronLeft,
  ChevronRight,
  Gauge
} from 'lucide-react'

export interface PreviewVideo {
  filePath: string
  title: string
  /** Optional metadata shown in the info strip when opened from the library. */
  meta?: {
    ratio?: string
    duration?: number
    sizeBytes?: number
    profileName?: string
    model?: string
    createdAt?: number
  }
}

interface VideoPreviewModalProps {
  video: PreviewVideo
  /** Optional playlist for prev/next navigation (library view). */
  playlist?: PreviewVideo[]
  onClose: () => void
  onNavigate?: (next: PreviewVideo) => void
}

const SPEEDS = [0.5, 1, 1.5, 2] as const
const SEEK_STEP_SEC = 5
const FRAME_STEP_SEC = 1 / 24 // Seedance renders at 24fps

const mediaUrl = (filePath: string): string =>
  `viraai-media://local/${encodeURIComponent(filePath)}?v=${Date.now()}`

const formatTime = (sec: number): string => {
  if (!Number.isFinite(sec)) return '0:00'
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

const formatBytes = (bytes?: number): string =>
  bytes ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : ''

export const VideoPreviewModal: React.FC<VideoPreviewModalProps> = ({
  video,
  playlist,
  onClose,
  onNavigate
}) => {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [playing, setPlaying] = useState(true)
  const [muted, setMuted] = useState(false)
  const [loop, setLoop] = useState(false)
  const [speed, setSpeed] = useState<number>(1)
  const [current, setCurrent] = useState(0)
  const [duration, setDuration] = useState(0)

  const videoSrc = useMemo(
    () => mediaUrl(video.filePath),
    [video.filePath, video.meta?.sizeBytes]
  )

  const index = playlist?.findIndex((v) => v.filePath === video.filePath) ?? -1
  const hasPrev = playlist !== undefined && index > 0
  const hasNext = playlist !== undefined && index >= 0 && index < playlist.length - 1

  const goPrev = useCallback(() => {
    if (hasPrev && onNavigate && playlist) onNavigate(playlist[index - 1])
  }, [hasPrev, onNavigate, playlist, index])

  const goNext = useCallback(() => {
    if (hasNext && onNavigate && playlist) onNavigate(playlist[index + 1])
  }, [hasNext, onNavigate, playlist, index])

  const togglePlay = useCallback(() => {
    const el = videoRef.current
    if (!el) return
    if (el.paused) void el.play().catch(() => {})
    else el.pause()
  }, [])

  const seekBy = useCallback((delta: number) => {
    const el = videoRef.current
    if (!el) return
    el.currentTime = Math.max(0, Math.min(el.duration || 0, el.currentTime + delta))
  }, [])

  const cycleSpeed = useCallback(() => {
    setSpeed((prev) => SPEEDS[(SPEEDS.indexOf(prev as (typeof SPEEDS)[number]) + 1) % SPEEDS.length])
  }, [])

  const enterFullscreen = useCallback(() => {
    void videoRef.current?.requestFullscreen?.().catch(() => {})
  }, [])

  // Apply speed/loop/muted to the element.
  useEffect(() => {
    const el = videoRef.current
    if (el) el.playbackRate = speed
  }, [speed, video.filePath])
  useEffect(() => {
    const el = videoRef.current
    if (el) el.loop = loop
  }, [loop, video.filePath])
  useEffect(() => {
    const el = videoRef.current
    if (el) el.muted = muted
  }, [muted, video.filePath])

  // Keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'Escape':
          onClose()
          break
        case ' ':
          e.preventDefault()
          togglePlay()
          break
        case 'ArrowLeft':
          seekBy(-SEEK_STEP_SEC)
          break
        case 'ArrowRight':
          seekBy(SEEK_STEP_SEC)
          break
        case ',':
          seekBy(-FRAME_STEP_SEC)
          break
        case '.':
          seekBy(FRAME_STEP_SEC)
          break
        case 'f':
        case 'F':
          enterFullscreen()
          break
        case 'm':
        case 'M':
          setMuted((v) => !v)
          break
        case 'l':
        case 'L':
          setLoop((v) => !v)
          break
        case 'j':
        case 'J':
          goPrev()
          break
        case 'k':
        case 'K':
          goNext()
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, togglePlay, seekBy, enterFullscreen, goPrev, goNext])

  const progressPct = duration > 0 ? (current / duration) * 100 : 0

  const onScrub = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = videoRef.current
    if (!el || !duration) return
    const rect = e.currentTarget.getBoundingClientRect()
    el.currentTime = ((e.clientX - rect.left) / rect.width) * duration
  }

  const m = video.meta
  const metaBits = [
    m?.ratio,
    m?.duration ? `${m.duration}s` : undefined,
    m?.model,
    m?.profileName,
    formatBytes(m?.sizeBytes),
    m?.createdAt ? new Date(m.createdAt).toLocaleString('vi-VN') : undefined
  ].filter(Boolean)

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 bg-black/90 backdrop-blur-sm flex items-center justify-center p-4 select-none"
    >
      {/* Prev / Next arrows */}
      {hasPrev && (
        <button
          onClick={(e) => {
            e.stopPropagation()
            goPrev()
          }}
          className="absolute left-4 top-1/2 -translate-y-1/2 w-11 h-11 rounded-full bg-black/60 border border-white/15 text-white/80 hover:text-white hover:bg-black/80 flex items-center justify-center"
          title="Video trước (J)"
        >
          <ChevronLeft className="w-6 h-6" />
        </button>
      )}
      {hasNext && (
        <button
          onClick={(e) => {
            e.stopPropagation()
            goNext()
          }}
          className="absolute right-4 top-1/2 -translate-y-1/2 w-11 h-11 rounded-full bg-black/60 border border-white/15 text-white/80 hover:text-white hover:bg-black/80 flex items-center justify-center"
          title="Video sau (K)"
        >
          <ChevronRight className="w-6 h-6" />
        </button>
      )}

      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-[#111a2e] border border-vira-border rounded-2xl w-full max-w-5xl overflow-hidden shadow-2xl flex flex-col max-h-[92vh]"
      >
        {/* Top bar */}
        <div className="px-4 py-2.5 border-b border-vira-border flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-white truncate">{video.title}</h3>
            {metaBits.length > 0 && (
              <p className="text-[11px] text-vira-muted truncate">{metaBits.join('  ·  ')}</p>
            )}
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              onClick={() => window.api.showItemInFolder(video.filePath)}
              className="px-2.5 py-1.5 rounded-lg bg-vira-card border border-vira-border hover:border-vira-accent text-xs flex items-center gap-1"
              title="Hiện trong thư mục"
            >
              <FolderOpen className="w-3.5 h-3.5" /> Thư mục
            </button>
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg bg-vira-card bg-rose-500/10 text-rose-300 hover:bg-rose-500/20"
              title="Đóng (Esc)"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Video stage */}
        <div className="bg-black flex items-center justify-center flex-1 min-h-0">
          <video
            key={video.filePath}
            ref={videoRef}
            src={videoSrc}
            autoPlay
            playsInline
            className="max-h-[70vh] w-auto max-w-full"
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onTimeUpdate={(e) => setCurrent(e.currentTarget.currentTime)}
            onLoadedMetadata={(e) => {
              setDuration(e.currentTarget.duration)
              e.currentTarget.playbackRate = speed
            }}
            onClick={togglePlay}
          />
        </div>

        {/* Custom control bar */}
        <div className="px-4 py-2.5 border-t border-vira-border space-y-2">
          <div
            onClick={onScrub}
            className="h-1.5 w-full rounded-full bg-white/15 cursor-pointer group"
            title="Tua"
          >
            <div
              className="h-full rounded-full bg-vira-accent relative"
              style={{ width: `${progressPct}%` }}
            >
              <span className="absolute right-0 top-1/2 -translate-y-1/2 w-3 h-3 rounded-full bg-vira-accent opacity-0 group-hover:opacity-100" />
            </div>
          </div>

          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5">
              <button
                onClick={togglePlay}
                className="w-8 h-8 rounded-lg bg-vira-accent text-[#0b1220] flex items-center justify-center"
                title="Phát/Dừng (Space)"
              >
                {playing ? <Pause className="w-4 h-4 fill-current" /> : <Play className="w-4 h-4 fill-current" />}
              </button>
              <button
                onClick={() => setMuted((v) => !v)}
                className={`w-8 h-8 rounded-lg border border-vira-border flex items-center justify-center ${muted ? 'text-rose-300' : 'text-vira-muted hover:text-white'}`}
                title="Tắt/Bật tiếng (M)"
              >
                {muted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
              </button>
              <span className="text-[11px] text-vira-muted tabular-nums ml-1">
                {formatTime(current)} / {formatTime(duration)}
              </span>
            </div>

            <div className="flex items-center gap-1.5">
              <button
                onClick={cycleSpeed}
                className="px-2 h-8 rounded-lg border border-vira-border text-xs text-vira-muted hover:text-white flex items-center gap-1 tabular-nums"
                title="Tốc độ phát"
              >
                <Gauge className="w-3.5 h-3.5" /> {speed}x
              </button>
              <button
                onClick={() => setLoop((v) => !v)}
                className={`w-8 h-8 rounded-lg border flex items-center justify-center ${loop ? 'border-vira-accent text-vira-accent' : 'border-vira-border text-vira-muted hover:text-white'}`}
                title="Lặp (L)"
              >
                <Repeat className="w-4 h-4" />
              </button>
              <button
                onClick={enterFullscreen}
                className="w-8 h-8 rounded-lg border border-vira-border text-vira-muted hover:text-white flex items-center justify-center"
                title="Toàn màn hình (F)"
              >
                <Maximize2 className="w-4 h-4" />
              </button>
            </div>
          </div>

          <p className="text-[10px] text-vira-muted/70">
            Space phát/dừng · ←/→ tua 5s · ,/. từng khung · F toàn màn hình · M tiếng · L lặp
            {playlist ? ' · J/K video trước/sau' : ''} · Esc đóng
          </p>
        </div>
      </div>
    </div>
  )
}

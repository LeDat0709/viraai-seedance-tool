import React, { useMemo, useState } from 'react'
import {
  Film,
  FolderOpen,
  Folder,
  Trash2,
  Play,
  PlayCircle,
  Download,
  Search,
  Plus,
  Pencil,
  FolderPlus,
  LayoutGrid,
  List,
  CloudDownload,
  HardDrive,
  Sparkles
} from 'lucide-react'
import { AccountProfile, AppSettings, ProjectEntry, VideoLibraryItem } from '../../../shared/types'

interface LibraryPageProps {
  videos: VideoLibraryItem[]
  accounts: AccountProfile[]
  projects: ProjectEntry[]
  settings: AppSettings
  onSelectVideoPreview: (filePath: string, title: string) => void
}

const DEFAULT_PROJECT_ID = 'proj-default'
const ALL = 'all'
type SortKey = 'new' | 'old' | 'size' | 'dur'

/** Videos saved before projects, or with a deleted project, fall back to the default project bucket. */
const bucketOf = (video: VideoLibraryItem): string => video.projectId || DEFAULT_PROJECT_ID

const mediaUrl = (filePath: string, sizeBytes?: number): string =>
  `viraai-media://local/${encodeURIComponent(filePath)}${sizeBytes ? `?v=${sizeBytes}` : ''}`

const isWatermarkedVideo = (vid: VideoLibraryItem): boolean => {
  const url = String(vid.videoUrl || '')
  const sz = vid.sizeBytes || 0
  if (sz > 0 && sz < 3_600_000) return true
  if (/lr=unwatermarked|logo_type=unwatermarked/i.test(url) && !String(vid.id || '').startsWith('direct_')) {
    return false
  }
  if (/lr=video_gen_watermark|watermark_dyn|\/tos-[^/]*-ve-/i.test(url)) return true
  if (String(vid.id || '').startsWith('direct_')) return true
  return false
}

const formatBytes = (bytes: number): string => (bytes ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : '')

const timeAgo = (ts: number): string => {
  const mins = Math.floor((Date.now() - ts) / 60000)
  if (mins < 1) return 'vừa xong'
  if (mins < 60) return `${mins}m trước`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h trước`
  return new Date(ts).toLocaleDateString('vi-VN')
}

export const LibraryPage: React.FC<LibraryPageProps> = ({
  videos,
  accounts,
  projects,
  settings,
  onSelectVideoPreview
}) => {
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedAccId, setSelectedAccId] = useState(ALL)
  const [selectedProjectId, setSelectedProjectId] = useState(ALL)
  const [ratioFilter, setRatioFilter] = useState(ALL)
  const [sortBy, setSortBy] = useState<SortKey>('new')
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid')
  const [pulling, setPulling] = useState(false)
  const [upgradingNoLogo, setUpgradingNoLogo] = useState(false)
  const [feedback, setFeedback] = useState<string | null>(null)
  const [creatingProject, setCreatingProject] = useState(false)
  const [newProjectName, setNewProjectName] = useState('')
  const [renameId, setRenameId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')

  const projectName = (id: string): string =>
    projects.find((p) => p.id === id)?.name ||
    (id === DEFAULT_PROJECT_ID ? 'Dự án mặc định' : 'Dự án đã xoá')

  const countInProject = (id: string): number => videos.filter((v) => bucketOf(v) === id).length

  const selectedProject = projects.find((p) => p.id === selectedProjectId)
  const folderToOpen = selectedProject?.outputDir || settings.outputDir

  const handleCreateProject = async () => {
    const name = newProjectName.trim()
    if (!name) return
    const folder = (await window.api.selectFolder()) || settings.outputDir
    const id = `proj-${Date.now()}`
    await window.api.saveProject({
      id,
      name,
      outputDir: folder,
      defaultRatio: '9:16',
      defaultDuration: 10,
      createdAt: Date.now(),
      updatedAt: Date.now()
    })
    setNewProjectName('')
    setCreatingProject(false)
    setSelectedProjectId(id)
  }

  const handleRenameProject = async () => {
    const target = projects.find((p) => p.id === renameId)
    const name = renameValue.trim()
    if (!target || !name) return
    await window.api.saveProject({ ...target, name, updatedAt: Date.now() })
    setRenameId(null)
  }

  const handleDeleteProject = async (p: ProjectEntry) => {
    if (projects.length <= 1) {
      window.alert('Cần ít nhất 1 kho — không thể xoá kho cuối cùng.')
      return
    }
    const ok = window.confirm(
      `Xoá kho "${p.name}"?\nVideo và tệp đã tạo KHÔNG bị xoá (vẫn xem được ở tab "Tất cả").`
    )
    if (!ok) return
    await window.api.deleteProject(p.id)
    if (selectedProjectId === p.id) setSelectedProjectId(ALL)
  }

  const handlePullVideos = async () => {
    setPulling(true)
    setFeedback('Đang quét các cuộc hội thoại Dola để kéo video mới về Kho…')
    const res =
      selectedAccId === ALL
        ? await window.api.pullVideosFromAllAccounts()
        : await window.api.pullVideosFromAccount(selectedAccId)
    setFeedback(res.message)
    setPulling(false)
  }

  const watermarkedCount = useMemo(
    () => videos.filter((v) => isWatermarkedVideo(v)).length,
    [videos]
  )

  const handleUpgradeNoLogo = async () => {
    setUpgradingNoLogo(true)
    setFeedback('Đang lấy luồng VOD gốc Không Logo (lr=unwatermarked) từ Dola cho các video đã tạo…')
    try {
      const res = await window.api.upgradeWatermarkedVideos()
      setFeedback(res.message)
    } catch (err: any) {
      setFeedback(`Lỗi khi nâng cấp bản Không Logo: ${err?.message || String(err)}`)
    } finally {
      setUpgradingNoLogo(false)
    }
  }

  const filtered = useMemo(() => {
    const q = searchQuery.toLowerCase()
    const list = videos.filter((v) => {
      if (selectedProjectId !== ALL && bucketOf(v) !== selectedProjectId) return false
      if (ratioFilter !== ALL && v.ratio !== ratioFilter) return false
      if (q && !v.prompt.toLowerCase().includes(q)) return false
      return true
    })
    const sorters: Record<SortKey, (a: VideoLibraryItem, b: VideoLibraryItem) => number> = {
      new: (a, b) => b.createdAt - a.createdAt,
      old: (a, b) => a.createdAt - b.createdAt,
      size: (a, b) => (b.sizeBytes || 0) - (a.sizeBytes || 0),
      dur: (a, b) => (b.duration || 0) - (a.duration || 0)
    }
    return [...list].sort(sorters[sortBy])
  }, [videos, selectedProjectId, ratioFilter, searchQuery, sortBy])

  const totalBytes = filtered.reduce((s, v) => s + (v.sizeBytes || 0), 0)
  const ratios = Array.from(new Set(videos.map((v) => v.ratio)))

  const selectClass =
    'appearance-none bg-vira-card border border-vira-border text-white text-xs rounded-lg pl-3 pr-8 h-9 focus:outline-none focus:border-vira-accent cursor-pointer'

  return (
    <div className="h-full overflow-y-auto p-6 space-y-4">
      {/* 1. HEADER BAR */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-bold tracking-tight flex items-center gap-2">
            <Film className="w-6 h-6 text-vira-accent" /> Kho Video Đã Tạo
          </h1>
          <span className="px-2 py-0.5 rounded-full bg-vira-card border border-vira-border text-vira-accent text-[11px] font-semibold">
            {filtered.length}
            {selectedProjectId !== ALL ? `/${videos.length}` : ''} video
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <select
              value={selectedAccId}
              onChange={(e) => setSelectedAccId(e.target.value)}
              className={selectClass}
            >
              <option value={ALL}>Tất cả tài khoản ({accounts.length})</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </div>
          <button
            onClick={() => window.api.openPath(folderToOpen)}
            className="h-9 px-3 rounded-lg bg-vira-card border border-vira-border hover:border-vira-accent text-xs font-medium flex items-center gap-1.5"
          >
            <FolderOpen className="w-4 h-4 text-vira-muted" />
            <span className="max-w-[160px] truncate">
              {selectedProject ? selectedProject.name : 'Thư mục video'}
            </span>
          </button>
          <button
            onClick={handleUpgradeNoLogo}
            disabled={upgradingNoLogo}
            title="Quét và thay thế mọi video còn dính watermark bằng luồng VOD gốc Không Logo (lr=unwatermarked) từ Dola"
            className={`h-9 px-3.5 rounded-lg font-bold text-xs flex items-center gap-1.5 disabled:opacity-50 transition-colors ${
              watermarkedCount > 0
                ? 'bg-amber-500 hover:bg-amber-400 text-[#0b1220] shadow-lg shadow-amber-500/20'
                : 'bg-vira-card border border-vira-accent/40 text-vira-accent hover:bg-vira-accent/10'
            }`}
          >
            <Sparkles className="w-4 h-4" />
            {upgradingNoLogo
              ? 'Đang xóa logo nhanh…'
              : watermarkedCount > 0
                ? `✨ Xóa logo hàng loạt (${watermarkedCount} video)`
                : '✨ Xóa logo hàng loạt'}
          </button>
          <button
            onClick={handlePullVideos}
            disabled={pulling}
            className="h-9 px-4 rounded-lg bg-vira-accent text-[#0b1220] font-bold text-xs flex items-center gap-1.5 disabled:opacity-50"
          >
            <CloudDownload className="w-4 h-4" />
            {pulling ? 'Đang kéo…' : 'Kéo video từ tài khoản về'}
          </button>
        </div>
      </div>

      {/* 2. PROJECT (KHO) TABS */}
      <div className="flex items-center gap-1.5 flex-wrap bg-vira-panel border border-vira-border rounded-xl p-1.5">
        <button
          onClick={() => setSelectedProjectId(ALL)}
          className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 ${
            selectedProjectId === ALL
              ? 'bg-vira-card text-vira-accent'
              : 'text-vira-muted hover:text-white hover:bg-vira-card'
          }`}
        >
          Tất cả
          <span className="px-1.5 rounded-full bg-vira-accent/15 text-vira-accent text-[10px] font-bold">
            {videos.length}
          </span>
        </button>
        {projects.map((p) => (
          <button
            key={p.id}
            onClick={() => setSelectedProjectId(p.id)}
            title={p.outputDir}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 whitespace-nowrap ${
              selectedProjectId === p.id
                ? 'bg-vira-card text-vira-accent'
                : 'text-vira-muted hover:text-white hover:bg-vira-card'
            }`}
          >
            <Folder className="w-3.5 h-3.5" />
            {p.name}
            <span className="px-1.5 rounded-full bg-vira-bg text-[10px]">{countInProject(p.id)}</span>
          </button>
        ))}
        <button
          onClick={() => {
            setCreatingProject((v) => !v)
            setRenameId(null)
          }}
          className="px-3 py-1.5 rounded-lg text-xs font-semibold text-vira-accent hover:bg-vira-accent/10 border border-dashed border-vira-accent/50 flex items-center gap-1"
        >
          <Plus className="w-3.5 h-3.5" /> Tạo kho mới
        </button>

        {/* Context actions for the selected kho */}
        {selectedProject && (
          <div className="flex items-center gap-1 ml-auto pl-2 border-l border-vira-border">
            <button
              onClick={() => {
                setRenameId(selectedProject.id)
                setRenameValue(selectedProject.name)
                setCreatingProject(false)
              }}
              title="Đổi tên kho"
              className="p-1.5 rounded-lg text-vira-muted hover:text-white hover:bg-vira-card"
            >
              <Pencil className="w-4 h-4" />
            </button>
            <button
              onClick={() => handleDeleteProject(selectedProject)}
              title="Xoá kho"
              className="p-1.5 rounded-lg bg-rose-500/10 text-rose-300 hover:bg-rose-500/20"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        )}
      </div>

      {creatingProject && (
        <div className="flex items-center gap-2 flex-wrap p-3 rounded-xl bg-vira-card border border-vira-border">
          <input
            autoFocus
            value={newProjectName}
            onChange={(e) => setNewProjectName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleCreateProject()}
            placeholder="Tên kho mới (vd: Kênh TikTok A)…"
            className="flex-1 min-w-[200px] bg-vira-bg border border-vira-border rounded-lg px-3 py-2 text-xs focus:outline-none focus:border-vira-accent"
          />
          <button
            onClick={handleCreateProject}
            disabled={!newProjectName.trim()}
            className="px-3.5 py-2 rounded-lg bg-vira-accent text-[#0b1220] font-bold text-xs flex items-center gap-1.5 disabled:opacity-40"
          >
            <FolderPlus className="w-4 h-4" /> Chọn thư mục &amp; tạo
          </button>
          <button
            onClick={() => setCreatingProject(false)}
            className="px-3 py-2 rounded-lg bg-vira-bg border border-vira-border text-xs text-vira-muted hover:text-white"
          >
            Huỷ
          </button>
        </div>
      )}
      {renameId && selectedProject && renameId === selectedProject.id && (
        <div className="flex items-center gap-2 flex-wrap p-3 rounded-xl bg-vira-card border border-vira-border">
          <input
            autoFocus
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleRenameProject()}
            className="flex-1 min-w-[200px] bg-vira-bg border border-vira-border rounded-lg px-3 py-2 text-xs focus:outline-none focus:border-vira-accent"
          />
          <button
            onClick={handleRenameProject}
            disabled={!renameValue.trim()}
            className="px-3.5 py-2 rounded-lg bg-vira-accent text-[#0b1220] font-bold text-xs disabled:opacity-40"
          >
            Lưu tên
          </button>
          <button
            onClick={() => setRenameId(null)}
            className="px-3 py-2 rounded-lg bg-vira-bg border border-vira-border text-xs text-vira-muted hover:text-white"
          >
            Huỷ
          </button>
        </div>
      )}

      {feedback && (
        <div className="p-3 rounded-xl bg-vira-accent/10 border border-vira-accent/40 text-xs text-vira-accent font-medium">
          {feedback}
        </div>
      )}

      {/* 3. SEARCH / FILTER TOOLBAR */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-2 bg-vira-panel border border-vira-border rounded-xl p-2.5">
        <div className="relative flex-1 min-w-[260px]">
          <Search className="w-4 h-4 text-vira-muted absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Tìm theo nội dung câu lệnh (prompt)…"
            className="w-full h-9 pl-9 pr-3 rounded-lg bg-vira-bg border border-vira-border text-xs focus:outline-none focus:border-vira-accent"
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={ratioFilter}
            onChange={(e) => setRatioFilter(e.target.value)}
            className={selectClass}
          >
            <option value={ALL}>Tất cả tỷ lệ</option>
            {ratios.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as SortKey)}
            className={selectClass}
          >
            <option value="new">Mới nhất trước</option>
            <option value="old">Cũ nhất trước</option>
            <option value="size">Dung lượng lớn nhất</option>
            <option value="dur">Thời lượng dài nhất</option>
          </select>
          <div className="flex items-center bg-vira-bg border border-vira-border p-1 rounded-lg">
            <button
              onClick={() => setViewMode('grid')}
              title="Dạng lưới"
              className={`w-7 h-7 rounded flex items-center justify-center ${
                viewMode === 'grid' ? 'bg-vira-card text-vira-accent' : 'text-vira-muted hover:text-white'
              }`}
            >
              <LayoutGrid className="w-4 h-4" />
            </button>
            <button
              onClick={() => setViewMode('list')}
              title="Dạng danh sách"
              className={`w-7 h-7 rounded flex items-center justify-center ${
                viewMode === 'list' ? 'bg-vira-card text-vira-accent' : 'text-vira-muted hover:text-white'
              }`}
            >
              <List className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      {/* 4. VIDEO GRID / LIST */}
      {filtered.length === 0 ? (
        <div className="py-20 text-center text-vira-muted bg-vira-panel border border-vira-border rounded-2xl">
          <Film className="w-12 h-12 mx-auto mb-3 opacity-35" />
          <p className="text-sm font-medium text-white/80">
            {selectedProjectId === ALL
              ? 'Chưa có video nào trong Kho'
              : `Dự án "${projectName(selectedProjectId)}" chưa có video nào`}
          </p>
          <p className="text-xs mt-1">
            Video hoàn tất ở mục Tạo dự án hoặc bấm &ldquo;Kéo video từ tài khoản về&rdquo; sẽ hiện ở đây.
          </p>
        </div>
      ) : viewMode === 'grid' ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {filtered.map((vid, idx) => (
            <div
              key={vid.id}
              className="group flex flex-col rounded-2xl bg-vira-panel border border-vira-border hover:border-vira-accent/50 overflow-hidden transition-colors"
            >
              <div
                onClick={() => onSelectVideoPreview(vid.localFile, vid.prompt)}
                className="relative w-full aspect-[9/16] bg-vira-bg overflow-hidden cursor-pointer flex items-center justify-center"
              >
                {idx < 12 ? (
                  <video
                    src={mediaUrl(vid.localFile, vid.sizeBytes)}
                    className="w-full h-full object-cover"
                    preload="metadata"
                    muted
                    onMouseEnter={(e) => e.currentTarget.play().catch(() => {})}
                    onMouseLeave={(e) => {
                      e.currentTarget.pause()
                      e.currentTarget.currentTime = 0
                    }}
                  />
                ) : (
                  <div className="w-full h-full flex flex-col items-center justify-center gap-2 bg-vira-card/60 text-vira-accent">
                    <Play className="w-10 h-10 fill-current" />
                    <span className="text-xs font-bold text-white">Bấm để phát MP4</span>
                  </div>
                )}
                <div className="absolute top-2.5 left-2.5 px-2 py-0.5 rounded-full bg-black/70 backdrop-blur text-vira-accent text-[10px] font-semibold flex items-center gap-1 max-w-[60%] truncate">
                  <span className="w-1.5 h-1.5 rounded-full bg-vira-accent" />
                  {projectName(bucketOf(vid))}
                </div>
                {isWatermarkedVideo(vid) ? (
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      handleUpgradeNoLogo()
                    }}
                    title="Bấm để tải lại bản gốc Không Logo từ Dola"
                    className="absolute top-2.5 right-2.5 px-2 py-0.5 rounded-full bg-amber-500/90 hover:bg-amber-400 text-[#0b1220] text-[10px] font-bold flex items-center gap-1 shadow"
                  >
                    <Sparkles className="w-3 h-3" /> Xóa logo
                  </button>
                ) : (
                  <div className="absolute top-2.5 right-2.5 px-2 py-0.5 rounded-full bg-emerald-500/85 backdrop-blur text-[#0b1220] text-[10px] font-bold flex items-center gap-1">
                    ✨ Không Logo
                  </div>
                )}
                <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                  <div className="w-12 h-12 rounded-full bg-vira-accent/90 text-[#0b1220] flex items-center justify-center shadow-lg">
                    <Play className="w-6 h-6 fill-current ml-0.5" />
                  </div>
                </div>
                <div className="absolute bottom-2.5 inset-x-2.5 flex items-center justify-between px-2 py-1 rounded-lg bg-black/70 backdrop-blur text-[10px] font-mono text-white">
                  <span>
                    {vid.ratio} · {vid.duration}s
                  </span>
                  <span className="text-vira-accent font-semibold">{formatBytes(vid.sizeBytes)}</span>
                </div>
              </div>

              <div className="p-3 flex-1 flex flex-col justify-between gap-2">
                <div>
                  <div className="flex items-center justify-between text-[11px] mb-1">
                    <span className="text-white font-medium truncate max-w-[60%]">{vid.profileName}</span>
                    <span className="text-vira-muted">{timeAgo(vid.createdAt)}</span>
                  </div>
                  <div className="text-[10px] text-vira-accent mb-1.5">{vid.model}</div>
                  <p className="text-xs text-white/85 line-clamp-2 leading-relaxed">{vid.prompt}</p>
                </div>
                <div className="flex items-center justify-between pt-2 border-t border-vira-border">
                  <button
                    onClick={() => onSelectVideoPreview(vid.localFile, vid.prompt)}
                    className="flex items-center gap-1 text-vira-accent hover:underline text-xs font-medium"
                  >
                    <PlayCircle className="w-4 h-4" /> Xem nhanh
                  </button>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => window.api.showItemInFolder(vid.localFile)}
                      title="Mở thư mục lưu"
                      className="p-1.5 rounded-lg text-vira-muted hover:text-white hover:bg-vira-card"
                    >
                      <FolderOpen className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => window.api.openPath(vid.localFile)}
                      title="Mở / tải video"
                      className="p-1.5 rounded-lg text-vira-muted hover:text-vira-accent hover:bg-vira-card"
                    >
                      <Download className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => window.api.deleteVideo(vid.id, false)}
                      title="Xoá khỏi Kho"
                      className="p-1.5 rounded-lg bg-rose-500/10 text-rose-300 hover:bg-rose-500/20"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {filtered.map((vid, idx) => (
            <div
              key={vid.id}
              className="flex items-center gap-3 p-2.5 rounded-xl bg-vira-panel border border-vira-border hover:border-vira-accent/50 transition-colors"
            >
              <div
                onClick={() => onSelectVideoPreview(vid.localFile, vid.prompt)}
                className="relative w-12 h-16 rounded-lg overflow-hidden bg-vira-bg shrink-0 cursor-pointer flex items-center justify-center"
              >
                {idx < 12 ? (
                  <video src={mediaUrl(vid.localFile, vid.sizeBytes)} className="w-full h-full object-cover" preload="metadata" muted />
                ) : (
                  <Play className="w-5 h-5 text-vira-accent fill-current" />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 text-[11px]">
                  <span className="text-white font-medium truncate">{vid.profileName}</span>
                  <span className="text-vira-muted">·</span>
                  <span className="text-vira-accent">{projectName(bucketOf(vid))}</span>
                  <span className="text-vira-muted">
                    · {vid.ratio} · {vid.duration}s · {formatBytes(vid.sizeBytes)}
                  </span>
                </div>
                <p className="text-xs text-white/80 line-clamp-1 mt-0.5">{vid.prompt}</p>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button
                  onClick={() => onSelectVideoPreview(vid.localFile, vid.prompt)}
                  className="px-2.5 h-7 rounded-lg bg-vira-accent text-[#0b1220] text-[11px] font-bold flex items-center gap-1"
                >
                  <Play className="w-3.5 h-3.5 fill-current" /> Xem
                </button>
                <button
                  onClick={() => window.api.showItemInFolder(vid.localFile)}
                  className="p-1.5 rounded-lg text-vira-muted hover:text-white hover:bg-vira-card"
                >
                  <FolderOpen className="w-4 h-4" />
                </button>
                <button
                  onClick={() => window.api.deleteVideo(vid.id, false)}
                  className="p-1.5 rounded-lg bg-rose-500/10 text-rose-300 hover:bg-rose-500/20"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 5. BOTTOM STATUS BAR */}
      <div className="flex flex-col md:flex-row items-center justify-between gap-2 px-4 py-2.5 rounded-xl bg-vira-panel border border-vira-border text-[11px] font-mono text-vira-muted">
        <span>
          Hiển thị <span className="text-vira-accent font-semibold">{filtered.length}</span> / {videos.length}{' '}
          video
        </span>
        <span className="flex items-center gap-1.5">
          <HardDrive className="w-3.5 h-3.5 text-vira-accent" />
          Dung lượng: <strong className="text-white">{formatBytes(totalBytes)}</strong>
          <span className="hidden lg:inline text-vira-muted/70 truncate max-w-[280px]">· {folderToOpen}</span>
        </span>
      </div>
    </div>
  )
}

import React, { useEffect, useState } from 'react'
import { Sparkles, Users, Shield, Film, Settings, UserCheck, Bug, Activity } from 'lucide-react'
import {
  AccountPoolEntry,
  AccountProfile,
  AppSettings,
  CharacterEntry,
  ProjectEntry,
  ProxyEntry,
  RotatingProxyEntry,
  VideoLibraryItem,
  VideoTask
} from '../../shared/types'
import { CreatePanel } from './components/CreatePanel'
import { AccountsPage } from './components/AccountsPage'
import { ProxyPage } from './components/ProxyPage'
import { LibraryPage } from './components/LibraryPage'
import { SettingsPage } from './components/SettingsPage'
import { CharactersModal } from './components/CharactersModal'
import { VideoPreviewModal } from './components/VideoPreviewModal'
import { WebCrawlerPage } from './components/WebCrawlerPage'
import { ConnectionFlowGraph } from './components/ConnectionFlowGraph'
import { ensureWebCrawlerInitialized, WebCrawlerOptions } from './utils/web-crawler-spider'

type NavTab = 'create' | 'flow' | 'accounts' | 'proxies' | 'library' | 'crawler' | 'settings'

/**
 * Every state push carries all slices; keep the old reference when a slice didn't change so React (and
 * any useMemo keyed on it) skips the work. Most pushes only touch tasks/accounts, not videos or settings.
 */
const keepIfSame =
  <T,>(next: T) =>
  (prev: T): T =>
    JSON.stringify(prev) === JSON.stringify(next) ? prev : next

export const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<NavTab>('create')
  const [showCharactersModal, setShowCharactersModal] = useState(false)
  const [previewVideo, setPreviewVideo] = useState<{
    filePath: string
    title: string
  } | null>(null)

  const [settings, setSettings] = useState<AppSettings>({
    dolaBaseUrl: 'https://www.dola.com',
    outputDir: '',
    concurrency: 2,
    batchAllocationMode: '20_per_acc',
    autoRecycleOnQuota: true,
    preferProMode: true,
    showBrowserDuringGen: false,
    pollTimeoutMinutes: 12,
    autoRemoveWatermark: true,
    activeProjectId: 'proj-default',
    activePoolId: 'all'
  })
  const [projects, setProjects] = useState<ProjectEntry[]>([])
  const [accountPools, setAccountPools] = useState<AccountPoolEntry[]>([])
  const [accounts, setAccounts] = useState<AccountProfile[]>([])
  const [proxies, setProxies] = useState<ProxyEntry[]>([])
  const [rotatingProxies, setRotatingProxies] = useState<RotatingProxyEntry[]>([])
  const [characters, setCharacters] = useState<CharacterEntry[]>([])
  const [tasks, setTasks] = useState<VideoTask[]>([])
  const [videos, setVideos] = useState<VideoLibraryItem[]>([])
  const [queuePaused, setQueuePaused] = useState(false)
  const [crawlerOverlayRunning, setCrawlerOverlayRunning] = useState(false)
  const [crawlerOverlayOptions, setCrawlerOverlayOptions] = useState<Required<WebCrawlerOptions>>({
    autoRead: false,
    size: 'M',
    density: 'calm'
  })

  useEffect(() => {
    ensureWebCrawlerInitialized()
  }, [])

  const handleToggleCrawlerOverlay = () => {
    const api = ensureWebCrawlerInitialized()
    if (api.running) {
      api.stop()
      setCrawlerOverlayRunning(false)
    } else {
      api.start(crawlerOverlayOptions)
      setCrawlerOverlayRunning(true)
    }
  }

  const handleUpdateCrawlerOverlayOptions = (patch: Partial<WebCrawlerOptions>) => {
    const next = { ...crawlerOverlayOptions, ...patch }
    setCrawlerOverlayOptions(next)
    const api = ensureWebCrawlerInitialized()
    api.set(next)
  }

  useEffect(() => {
    window.api.getState().then((data) => {
      if (!data) return
      setSettings(data.settings)
      setProjects(data.projects || [])
      setAccountPools(data.accountPools || [])
      setAccounts(data.accounts || [])
      setProxies(data.proxies || [])
      setRotatingProxies(data.rotatingProxies || [])
      setCharacters(data.characters || [])
      setTasks(data.tasks || [])
      setVideos(data.videos || [])
    })

    const unsubscribe = window.api.onStateUpdated((data) => {
      if (!data) return
      setSettings(keepIfSame(data.settings))
      setProjects(keepIfSame(data.projects || []))
      setAccountPools(keepIfSame(data.accountPools || []))
      setAccounts(keepIfSame(data.accounts || []))
      setProxies(keepIfSame(data.proxies || []))
      setRotatingProxies(keepIfSame(data.rotatingProxies || []))
      setCharacters(keepIfSame(data.characters || []))
      setTasks(keepIfSame(data.tasks || []))
      setVideos(keepIfSame(data.videos || []))
      if (typeof data.queuePaused === 'boolean') {
        setQueuePaused(data.queuePaused)
      }
    })

    return () => {
      unsubscribe()
    }
  }, [])

  const runningCount = tasks.filter((t) =>
    ['preparing', 'uploading', 'submitting', 'polling', 'downloading'].includes(t.status)
  ).length
  const readyAccCount = accounts.filter((a) => a.enabled && a.status === 'ready').length

  return (
    <div className="flex h-screen w-screen bg-[#0b1220] text-[#e8eef7] overflow-hidden select-none">
      {/* LEFT SIDEBAR */}
      <aside className="w-60 shrink-0 bg-[#080e1a] border-r border-vira-border flex flex-col justify-between p-3">
        <div className="space-y-4">
          {/* Brand Logo */}
          <div className="flex items-center gap-2.5 px-2.5 py-2">
            <div className="w-9 h-9 rounded-xl bg-vira-accent text-[#0b1220] flex items-center justify-center font-black text-lg shadow-md">
              V
            </div>
            <div>
              <div className="font-extrabold text-sm tracking-tight text-white flex items-center gap-1.5">
                ViraAI Studio
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-vira-accent/20 text-vira-accent font-bold">
                  PRO
                </span>
              </div>
              <div className="text-[11px] text-vira-muted">Seedance 2.5 Automation</div>
            </div>
          </div>

          {/* Navigation Links */}
          <nav className="space-y-1">
            <button
              onClick={() => setActiveTab('create')}
              className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-xs font-semibold transition ${
                activeTab === 'create'
                  ? 'bg-vira-accent text-[#0b1220] font-bold shadow-sm'
                  : 'text-vira-muted hover:text-white hover:bg-vira-card'
              }`}
            >
              <span className="flex items-center gap-2.5">
                <Sparkles className="w-4 h-4" /> Tạo dự án Video
              </span>
              {runningCount > 0 && (
                <span
                  className={`px-1.5 py-0.5 rounded-full text-[10px] font-bold ${
                    activeTab === 'create'
                      ? 'bg-[#0b1220] text-vira-accent'
                      : 'bg-vira-accent text-[#0b1220]'
                  }`}
                >
                  {runningCount}
                </span>
              )}
            </button>

            <button
              onClick={() => setActiveTab('flow')}
              className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-xs font-semibold transition ${
                activeTab === 'flow'
                  ? 'bg-vira-accent text-[#0b1220] font-bold shadow-sm'
                  : 'text-vira-muted hover:text-white hover:bg-vira-card'
              }`}
            >
              <span className="flex items-center gap-2.5">
                <Activity className="w-4 h-4 text-[#eac54f]" /> Luồng kết nối
              </span>
              <span
                className={`text-[10px] font-extrabold px-1.5 py-0.5 rounded flex items-center gap-1 ${
                  activeTab === 'flow'
                    ? 'bg-[#0b1220] text-[#eac54f]'
                    : 'bg-[#19160e] border border-[#3a3019] text-[#eac54f]'
                }`}
              >
                <span className="w-1.5 h-1.5 rounded-full bg-[#eac54f] animate-pulse" />
                LIVE
              </span>
            </button>

            <button
              onClick={() => setShowCharactersModal(true)}
              className="w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-xs font-semibold text-vira-muted hover:text-white hover:bg-vira-card transition"
            >
              <span className="flex items-center gap-2.5">
                <UserCheck className="w-4 h-4 text-vira-accent" /> Kho nhân vật (@tag)
              </span>
              <span className="text-[11px] px-1.5 py-0.5 rounded bg-vira-card border border-vira-border">
                {characters.length}
              </span>
            </button>

            <button
              onClick={() => setActiveTab('accounts')}
              className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-xs font-semibold transition ${
                activeTab === 'accounts'
                  ? 'bg-vira-accent text-[#0b1220] font-bold shadow-sm'
                  : 'text-vira-muted hover:text-white hover:bg-vira-card'
              }`}
            >
              <span className="flex items-center gap-2.5">
                <Users className="w-4 h-4" /> Quản lý Tài khoản
              </span>
              <span
                className={`text-[11px] px-1.5 py-0.5 rounded ${
                  activeTab === 'accounts'
                    ? 'bg-[#0b1220]/20 text-[#0b1220]'
                    : 'bg-vira-card border border-vira-border text-vira-accent'
                }`}
              >
                {readyAccCount}/{accounts.length}
              </span>
            </button>

            <button
              onClick={() => setActiveTab('proxies')}
              className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-xs font-semibold transition ${
                activeTab === 'proxies'
                  ? 'bg-vira-accent text-[#0b1220] font-bold shadow-sm'
                  : 'text-vira-muted hover:text-white hover:bg-vira-card'
              }`}
            >
              <span className="flex items-center gap-2.5">
                <Shield className="w-4 h-4" /> Quản lý Proxy
              </span>
              <span
                className={`text-[11px] px-1.5 py-0.5 rounded ${
                  activeTab === 'proxies'
                    ? 'bg-[#0b1220]/20 text-[#0b1220]'
                    : 'bg-vira-card border border-vira-border'
                }`}
              >
                {proxies.length + rotatingProxies.length}
              </span>
            </button>

            <button
              onClick={() => setActiveTab('library')}
              className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-xs font-semibold transition ${
                activeTab === 'library'
                  ? 'bg-vira-accent text-[#0b1220] font-bold shadow-sm'
                  : 'text-vira-muted hover:text-white hover:bg-vira-card'
              }`}
            >
              <span className="flex items-center gap-2.5">
                <Film className="w-4 h-4" /> Kho Video
              </span>
              <span
                className={`text-[11px] px-1.5 py-0.5 rounded ${
                  activeTab === 'library'
                    ? 'bg-[#0b1220]/20 text-[#0b1220]'
                    : 'bg-vira-card border border-vira-border'
                }`}
              >
                {videos.length}
              </span>
            </button>

            <button
              onClick={() => setActiveTab('crawler')}
              className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-xs font-semibold transition ${
                activeTab === 'crawler'
                  ? 'bg-vira-accent text-[#0b1220] font-bold shadow-sm'
                  : 'text-vira-muted hover:text-white hover:bg-vira-card'
              }`}
            >
              <span className="flex items-center gap-2.5">
                <Bug className="w-4 h-4" /> Web Crawler /[•]\
              </span>
              <span
                className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${
                  activeTab === 'crawler'
                    ? 'bg-[#0b1220]/20 text-[#0b1220] font-bold'
                    : 'bg-vira-card border border-vira-border text-vira-accent'
                }`}
              >
                60fps
              </span>
            </button>

            <button
              onClick={() => setActiveTab('settings')}
              className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-xs font-semibold transition ${
                activeTab === 'settings'
                  ? 'bg-vira-accent text-[#0b1220] font-bold shadow-sm'
                  : 'text-vira-muted hover:text-white hover:bg-vira-card'
              }`}
            >
              <span className="flex items-center gap-2.5">
                <Settings className="w-4 h-4" /> Cấu hình
              </span>
            </button>
          </nav>
        </div>

        {/* Footer + Quick Cyber Spider Overlay Widget */}
        <div className="space-y-2">
          <div className="bg-vira-card border border-vira-border rounded-xl p-2.5 space-y-2 text-xs">
            <div className="flex items-center justify-between gap-1">
              <span className="font-bold text-white flex items-center gap-1.5 text-[11px]">
                <Bug className="w-3.5 h-3.5 text-vira-accent" />
                Nhện Cyber /[•]\
              </span>
              <button
                onClick={handleToggleCrawlerOverlay}
                className={`px-2 py-0.5 rounded-lg text-[10px] font-extrabold transition ${
                  crawlerOverlayRunning
                    ? 'bg-vira-accent text-[#0b1220] shadow-sm'
                    : 'bg-[#0b1220] text-vira-muted hover:text-white border border-vira-border'
                }`}
              >
                {crawlerOverlayRunning ? 'ĐANG BẬT' : 'THẢ NHỆN'}
              </button>
            </div>
            {crawlerOverlayRunning && (
              <div className="flex items-center justify-between gap-1 pt-1 border-t border-vira-border/60">
                <div className="flex items-center gap-0.5">
                  {(['S', 'M', 'L'] as const).map((sz) => (
                    <button
                      key={sz}
                      onClick={() => handleUpdateCrawlerOverlayOptions({ size: sz })}
                      className={`px-1.5 py-0.5 rounded text-[10px] font-bold transition ${
                        crawlerOverlayOptions.size === sz
                          ? 'bg-vira-accent/25 text-vira-accent border border-vira-accent/40'
                          : 'text-vira-muted hover:text-white'
                      }`}
                    >
                      {sz}
                    </button>
                  ))}
                </div>
                <div className="flex items-center gap-0.5">
                  {(
                    [
                      ['calm', 'Dịu'],
                      ['normal', 'Vừa'],
                      ['wild', 'Mạnh']
                    ] as const
                  ).map(([dKey, dLabel]) => (
                    <button
                      key={dKey}
                      onClick={() => handleUpdateCrawlerOverlayOptions({ density: dKey })}
                      className={`px-1.5 py-0.5 rounded text-[10px] font-bold transition ${
                        crawlerOverlayOptions.density === dKey
                          ? 'bg-vira-accent/25 text-vira-accent border border-vira-accent/40'
                          : 'text-vira-muted hover:text-white'
                      }`}
                    >
                      {dLabel}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="bg-vira-card border border-vira-border rounded-xl p-3 space-y-1.5 text-xs">
            <div className="flex items-center justify-between">
              <span className="text-vira-muted">Số luồng:</span>
              <span className="text-vira-accent font-bold">{settings.concurrency || 2} luồng</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-vira-muted">Tự làm mới lượt:</span>
              <span className="text-white font-semibold">
                {settings.autoRecycleOnQuota ? 'Đang BẬT' : 'Đang TẮT'}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-vira-muted">Bản quyền:</span>
              <span className="text-vira-accent font-semibold">Unlocked (Vĩnh viễn)</span>
            </div>
          </div>
        </div>
      </aside>

      {/* MAIN CONTENT VIEW */}
      <main className="flex-1 h-full overflow-hidden">
        {activeTab === 'create' && (
          <CreatePanel
            settings={settings}
            projects={projects}
            accountPools={accountPools}
            accounts={accounts}
            proxies={proxies}
            rotatingProxies={rotatingProxies}
            characters={characters}
            tasks={tasks}
            videos={videos}
            queuePaused={queuePaused}
            onOpenCharactersModal={() => setShowCharactersModal(true)}
            onOpenAccounts={() => setActiveTab('accounts')}
            onSelectVideoPreview={(filePath, title) => setPreviewVideo({ filePath, title })}
          />
        )}

        {activeTab === 'flow' && (
          <div className="h-full overflow-y-auto p-5 bg-[#070605]">
            <ConnectionFlowGraph
              accounts={accounts}
              tasks={tasks}
              accountPools={accountPools}
              activePoolId={settings.activePoolId}
            />
          </div>
        )}

        {activeTab === 'accounts' && (
          <AccountsPage
            settings={settings}
            accountPools={accountPools}
            accounts={accounts}
            proxies={proxies}
            rotatingProxies={rotatingProxies}
          />
        )}

        {activeTab === 'proxies' && (
          <ProxyPage
            proxies={proxies}
            rotatingProxies={rotatingProxies}
            accountPools={accountPools}
          />
        )}

        {activeTab === 'library' && (
          <LibraryPage
            videos={videos}
            accounts={accounts}
            projects={projects}
            settings={settings}
            onSelectVideoPreview={(filePath, title) => setPreviewVideo({ filePath, title })}
          />
        )}

        {activeTab === 'crawler' && (
          <WebCrawlerPage
            overlayRunning={crawlerOverlayRunning}
            overlayOptions={crawlerOverlayOptions}
            onToggleOverlay={handleToggleCrawlerOverlay}
            onUpdateOverlayOptions={handleUpdateCrawlerOverlayOptions}
          />
        )}

        {activeTab === 'settings' && <SettingsPage settings={settings} />}
      </main>

      {/* CHARACTERS MODAL */}
      {showCharactersModal && (
        <CharactersModal
          characters={characters}
          onClose={() => setShowCharactersModal(false)}
        />
      )}

      {/* VIDEO PREVIEW MODAL */}
      {previewVideo && (
        <VideoPreviewModal video={previewVideo} onClose={() => setPreviewVideo(null)} />
      )}
    </div>
  )
}

export default App

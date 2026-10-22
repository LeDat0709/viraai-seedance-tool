import React from 'react'
import { AlertCircle, Ban, Bug, CheckCircle2, FolderOpen, Loader2, Play, RotateCcw, Shield, Sparkles, Square, Trash2 } from 'lucide-react'
import { VideoTask } from '../../../shared/types'
import {
  TASK_STEPS,
  cleanProgressText,
  errorLabelOf,
  failureKindOf,
  findPromptRisk,
  stepIndexOf
} from './queue-display'
import { spiderCrawlAndClickRetry, spiderRewriteViolatedPrompt } from '../utils/web-crawler-spider'

const RUNNING_STATUSES = ['queued', 'preparing', 'uploading', 'submitting', 'polling', 'downloading']
const mediaUrl = (filePath: string, cacheKey?: number): string =>
  `viraai-media://local/${encodeURIComponent(filePath)}${cacheKey ? `?v=${cacheKey}` : ''}`

const isWatermarkedTask = (task: VideoTask): boolean => {
  const vid = String(task.videoId || '')
  const url = String(task.videoUrl || '')
  const sz = task.fileSizeBytes || 0
  if (sz > 0 && sz < 3_600_000) return true
  if (/lr=unwatermarked|logo_type=unwatermarked/i.test(url) && !vid.startsWith('direct_')) return false
  if (/lr=video_gen_watermark|watermark_dyn|\/tos-[^/]*-ve-/i.test(url)) return true
  if (vid.startsWith('direct_')) return true
  return false
}

type TaskState = 'done' | 'failed' | 'running'

interface QueueViewProps {
  tasks: VideoTask[]
  onPreview: (filePath: string, title: string) => void
  resolveProxyLabel?: (task: VideoTask) => string | undefined
  onUpgradeNoLogo?: () => void
  upgradingNoLogo?: boolean
}

const stateOf = (task: VideoTask): TaskState =>
  task.status === 'completed'
    ? 'done'
    : task.status === 'failed' || task.status === 'cancelled'
      ? 'failed'
      : 'running'

const modelLabel = (task: VideoTask): string =>
  task.model === 'seedance_v2.5' ? 'Seedance 2.5 Pro' : 'Seedance 2.0 Fast'

const noteOf = (task: VideoTask): string =>
  cleanProgressText(task.errorMessage || task.progressText) ||
  (task.status === 'completed' ? 'Đã tải video thành công' : '')

/** Step bar shown in the thumbnail area while a task runs: Chuẩn bị → Gửi lệnh → Đang dựng → Tải về. */
function StepProgress({ task }: { task: VideoTask }): React.JSX.Element {
  const current = stepIndexOf(task.status)
  return (
    <div className="w-full px-3 flex flex-col items-center gap-2">
      <Loader2 className="w-6 h-6 text-vira-accent animate-spin" />
      <span className="text-[11px] font-semibold text-white">
        {current < 0 ? 'Đang chờ lượt chạy' : TASK_STEPS[current]}
      </span>
      <div className="w-full flex gap-1">
        {TASK_STEPS.map((step, i) => (
          <span
            key={step}
            title={step}
            className={`h-1 flex-1 rounded-full ${
              i < current ? 'bg-vira-accent' : i === current ? 'bg-vira-accent animate-pulse' : 'bg-vira-border'
            }`}
          />
        ))}
      </div>
    </div>
  )
}

const actionBtn =
  'inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-vira-accent/15 text-vira-accent text-[11px] font-semibold hover:bg-vira-accent/25 disabled:opacity-50'

/** Fix button for a failed task, chosen by why it failed: collect the video, edit the prompt, or run again. */
export function FailureActions({ task }: { task: VideoTask }): React.JSX.Element {
  const [isEditing, setIsEditing] = React.useState(false)
  const [draft, setDraft] = React.useState(task.prompt)
  const [isBusy, setIsBusy] = React.useState(false)
  const kind = failureKindOf(task)

  const run = async (action: () => Promise<{ ok: boolean; message: string }>): Promise<void> => {
    setIsBusy(true)
    try {
      const res = await action()
      if (!res.ok) window.alert(res.message)
      else setIsEditing(false)
    } finally {
      setIsBusy(false)
    }
  }

  const handleSpiderAutoFixAndRetry = (): void => {
    const { rewrittenPrompt } = spiderRewriteViolatedPrompt(
      task.prompt,
      task.duration,
      task.errorMessage,
      1
    )
    setDraft(rewrittenPrompt)
    setIsBusy(true)
    spiderCrawlAndClickRetry(
      task.id,
      async () => {
        try {
          const res = await window.api.editPromptAndRetry(task.id, rewrittenPrompt)
          if (!res.ok) window.alert(res.message)
          else setIsEditing(false)
        } finally {
          setIsBusy(false)
        }
      },
      750
    )
  }

  if (isEditing) {
    return (
      <div className="w-full flex flex-col gap-1.5">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={5}
          className="w-full bg-vira-bg border border-vira-border rounded-lg p-2 text-[11px] text-white focus:outline-none focus:border-vira-accent"
        />
        {findPromptRisk(draft) && <span className="text-[10px] text-amber-400 text-left">{findPromptRisk(draft)}</span>}
        <div className="flex gap-1.5 flex-wrap justify-center">
          <button
            type="button"
            disabled={isBusy}
            onClick={() => {
              const { rewrittenPrompt } = spiderRewriteViolatedPrompt(
                draft,
                task.duration,
                task.errorMessage,
                1
              )
              setDraft(rewrittenPrompt)
            }}
            className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-[#5cc8ff]/15 border border-[#5cc8ff]/35 text-[#5cc8ff] text-[11px] font-semibold hover:bg-[#5cc8ff]/25 disabled:opacity-50"
          >
            <Bug className="w-3.5 h-3.5" /> Nhện tự sửa
          </button>
          <button
            disabled={isBusy}
            data-spider-retry-task={task.id}
            onClick={() => run(() => window.api.editPromptAndRetry(task.id, draft))}
            className={actionBtn}
          >
            <RotateCcw className="w-3.5 h-3.5" /> Lưu & chạy lại
          </button>
          <button onClick={() => setIsEditing(false)} className="px-2 text-[11px] text-vira-muted hover:text-white">
            Huỷ
          </button>
        </div>
      </div>
    )
  }

  if (kind === 'recover') {
    return (
      <button
        disabled={isBusy}
        data-spider-retry-task={task.id}
        onClick={() => run(() => window.api.recoverTask(task.id))}
        className={actionBtn}
      >
        <RotateCcw className="w-3.5 h-3.5" /> Lấy lại video
      </button>
    )
  }
  if (kind === 'edit') {
    return (
      <div className="flex items-center gap-1.5 flex-wrap justify-end">
        <button
          disabled={isBusy}
          data-spider-retry-task={task.id}
          onClick={handleSpiderAutoFixAndRetry}
          title="Con Nhện AI tự động viết lại prompt khử vi phạm và nhấn Chạy lại"
          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-[#5cc8ff]/15 border border-[#5cc8ff]/35 text-[#5cc8ff] text-[11px] font-semibold hover:bg-[#5cc8ff]/25 disabled:opacity-50"
        >
          <Bug className="w-3.5 h-3.5" /> Nhện sửa & Thử lại
        </button>
        <button onClick={() => setIsEditing(true)} className={actionBtn}>
          <RotateCcw className="w-3.5 h-3.5" /> Sửa tay
        </button>
      </div>
    )
  }
  return (
    <button
      data-spider-retry-task={task.id}
      onClick={() => window.api.retryTask(task.id)}
      className={actionBtn}
    >
      <RotateCcw className="w-3.5 h-3.5" /> Chạy lại (nick khác)
    </button>
  )
}

function StatusBadge({ task }: { task: VideoTask }): React.JSX.Element {
  const state = stateOf(task)
  const isWaitingInQueue = task.status === 'queued'
  const tone =
    state === 'failed'
      ? 'bg-rose-500/10 text-rose-300'
      : state === 'done' && task.errorMessage
        ? 'bg-amber-400/10 text-amber-400'
        : isWaitingInQueue
          ? 'bg-slate-500/15 text-vira-muted border border-vira-border'
          : 'bg-vira-accent/10 text-vira-accent'
  return (
    <span className={`px-2 py-0.5 rounded-full text-[11px] font-semibold inline-flex items-center gap-1 whitespace-nowrap ${tone}`}>
      {state === 'done' ? (
        <CheckCircle2 className="w-3.5 h-3.5" />
      ) : state === 'failed' ? (
        <Ban className="w-3.5 h-3.5" />
      ) : isWaitingInQueue ? (
        <span className="w-2 h-2 rounded-full bg-amber-400/80" />
      ) : (
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
      )}
      {state === 'done'
        ? 'Sẵn sàng'
        : state === 'failed'
          ? 'Thất bại'
          : isWaitingInQueue
            ? 'Đang chờ'
            : 'Đang xử lý'}
    </span>
  )
}

function TaskActions({ task, onPreview }: { task: VideoTask } & Pick<QueueViewProps, 'onPreview'>): React.JSX.Element {
  const state = stateOf(task)
  const iconBtn = 'w-7 h-7 flex items-center justify-center rounded-lg'
  return (
    <div className="flex items-center gap-1">
      {state === 'done' && task.localFile && (
        <>
          <button
            onClick={() => onPreview(task.localFile!, `Video #${task.sequenceNumber}`)}
            title="Xem video"
            className={`${iconBtn} hover:bg-vira-card text-vira-accent`}
          >
            <Play className="w-4 h-4 fill-current" />
          </button>
          <button
            onClick={() => window.api.showItemInFolder(task.localFile!)}
            title="Mở thư mục"
            className={`${iconBtn} hover:bg-vira-card text-vira-muted hover:text-white`}
          >
            <FolderOpen className="w-4 h-4" />
          </button>
        </>
      )}
      {state === 'failed' && (
        <button
          onClick={() => window.api.retryTask(task.id)}
          title="Thử lại"
          className={`${iconBtn} hover:bg-vira-card text-vira-muted hover:text-vira-accent`}
        >
          <RotateCcw className="w-4 h-4" />
        </button>
      )}
      {state === 'running' && RUNNING_STATUSES.includes(task.status) ? (
        <button
          onClick={() => window.api.cancelTask(task.id)}
          title="Dừng tác vụ"
          className={`${iconBtn} hover:bg-vira-card text-vira-muted hover:text-rose-300`}
        >
          <Square className="w-4 h-4" />
        </button>
      ) : (
        <button
          onClick={() => window.api.deleteTask(task.id)}
          title="Xoá tác vụ"
          className={`${iconBtn} bg-rose-500/10 text-rose-300 hover:bg-rose-500/20`}
        >
          <Trash2 className="w-4 h-4" />
        </button>
      )}
    </div>
  )
}

export function QueueGrid({ tasks, onPreview, resolveProxyLabel, onUpgradeNoLogo, upgradingNoLogo }: QueueViewProps): React.JSX.Element {
  return (
    <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(170px,1fr))]">
      {tasks.map((task, idx) => {
        const state = stateOf(task)
        const proxyLabel = resolveProxyLabel ? resolveProxyLabel(task) : task.assignedProxyLabel
        const hasWatermark = state === 'done' && isWatermarkedTask(task)
        const shouldMountVideoTag = state === 'done' && Boolean(task.localFile) && idx < 12
        return (
          <div
            key={task.id}
            data-task-id={task.id}
            className="group flex flex-col rounded-2xl bg-vira-panel border border-vira-border hover:border-vira-accent/50 overflow-hidden"
          >
            <div
              className="relative w-full bg-vira-bg overflow-hidden flex items-center justify-center"
              style={{ aspectRatio: task.ratio.replace(':', ' / ') }}
            >
              {shouldMountVideoTag ? (
                <video
                  src={mediaUrl(task.localFile!, task.fileSizeBytes || task.updatedAt)}
                  className="w-full h-full object-cover cursor-pointer"
                  preload="metadata"
                  muted
                  onClick={() => onPreview(task.localFile!, `Video #${task.sequenceNumber}`)}
                  onMouseEnter={(e) => e.currentTarget.play().catch(() => {})}
                  onMouseLeave={(e) => {
                    e.currentTarget.pause()
                    e.currentTarget.currentTime = 0
                  }}
                />
              ) : state === 'done' && task.localFile ? (
                <button
                  type="button"
                  onClick={() => onPreview(task.localFile!, `Video #${task.sequenceNumber}`)}
                  className="w-full h-full flex flex-col items-center justify-center gap-1.5 bg-vira-card/60 hover:bg-vira-card text-vira-accent transition-colors"
                  title="Bấm để phát video"
                >
                  <Play className="w-8 h-8 fill-current" />
                  <span className="text-[11px] font-bold text-white">Xem Video #{task.sequenceNumber}</span>
                </button>
              ) : state === 'failed' ? (
                <div className="w-full px-3 flex flex-col items-center gap-2 text-center" title={task.errorMessage}>
                  <AlertCircle className="w-7 h-7 text-rose-300" />
                  <span className="text-[12px] font-semibold text-rose-300">{errorLabelOf(task)}</span>
                  <FailureActions task={task} />
                </div>
              ) : (
                <StepProgress task={task} />
              )}
              <span className="absolute top-2 left-2 px-1.5 py-0.5 rounded-md bg-black/70 text-[10px] font-bold text-white">
                #{task.sequenceNumber}
              </span>
              {state === 'done' && (
                hasWatermark ? (
                  <button
                    type="button"
                    disabled={upgradingNoLogo}
                    onClick={(e) => {
                      e.stopPropagation()
                      onUpgradeNoLogo?.()
                    }}
                    className="absolute top-2 right-2 px-1.5 py-0.5 rounded-md bg-amber-500 hover:bg-amber-400 text-[#0b1220] text-[9px] font-extrabold flex items-center gap-0.5 shadow"
                    title="Bấm để tải lại bản gốc Không Logo (lr=unwatermarked)"
                  >
                    <Sparkles className="w-2.5 h-2.5" /> Xóa logo
                  </button>
                ) : (
                  <span className="absolute top-2 right-2 px-1.5 py-0.5 rounded-md bg-emerald-500/85 text-[#0b1220] text-[9px] font-extrabold">
                    ✨ Không Logo
                  </span>
                )
              )}
              <span className="absolute bottom-2 left-2 px-1.5 py-0.5 rounded-md bg-black/70 text-[10px] font-mono text-white">
                {task.ratio} · {task.duration}s
              </span>
            </div>
            <div className="p-2.5 flex-1 flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-1">
                <StatusBadge task={task} />
                <TaskActions task={task} onPreview={onPreview} />
              </div>
              <p className="text-[12px] leading-snug text-white line-clamp-2" title={task.prompt}>
                {task.prompt}
              </p>
              {(task.assignedAccountName || proxyLabel) && (
                <span
                  className="inline-flex items-center gap-1 text-[10px] text-vira-muted truncate"
                  title={`Acc: ${task.assignedAccountName || '—'}\nProxy: ${proxyLabel || '—'}`}
                >
                  {proxyLabel && <Shield className="w-3 h-3 shrink-0 text-emerald-300" />}
                  <span className="truncate">{task.assignedAccountName || proxyLabel}</span>
                </span>
              )}
              <p
                className={`text-[11px] line-clamp-2 ${state === 'failed' ? 'text-rose-300' : 'text-vira-muted'}`}
                title={noteOf(task)}
              >
                {noteOf(task)}
              </p>
            </div>
          </div>
        )
      })}
    </div>
  )
}

export function QueueTable({ tasks, onPreview, resolveProxyLabel }: QueueViewProps): React.JSX.Element {
  const th = 'px-3 py-2 font-semibold text-vira-muted text-[11px] uppercase tracking-wide whitespace-nowrap'
  return (
    <div className="rounded-2xl border border-vira-border bg-vira-panel overflow-hidden">
      <table className="w-full table-fixed text-left border-collapse text-xs">
        <colgroup>
          <col className="w-12" />
          <col className="w-28" />
          <col className="w-24" />
          <col className="w-32" />
          <col className="w-36" />
          <col className="w-40" />
          <col />
          <col />
          <col className="w-28" />
        </colgroup>
        <thead className="border-b border-vira-border">
          <tr>
            <th className={th}>#</th>
            <th className={th}>Trạng thái</th>
            <th className={th}>Thông số</th>
            <th className={th}>Model</th>
            <th className={th}>Tài khoản</th>
            <th className={th}>Proxy áp dụng</th>
            <th className={th}>Câu lệnh</th>
            <th className={th}>Ghi chú</th>
            <th className={th}></th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((task) => {
            const proxyLabel = resolveProxyLabel ? resolveProxyLabel(task) : task.assignedProxyLabel
            return (
              <tr key={task.id} data-task-id={task.id} className="border-b border-vira-border last:border-0 hover:bg-vira-card/40">
                <td className="px-3 py-2 font-bold text-white">{task.sequenceNumber}</td>
                <td className="px-3 py-2">
                  <StatusBadge task={task} />
                </td>
                <td className="px-3 py-2 font-mono text-white whitespace-nowrap">
                  {task.ratio} · {task.duration}s
                </td>
                <td className="px-3 py-2 text-vira-accent whitespace-nowrap">{modelLabel(task)}</td>
                <td className="px-3 py-2 text-vira-muted truncate" title={task.assignedAccountName}>
                  {task.assignedAccountName || '—'}
                </td>
                <td className="px-3 py-2 truncate" title={proxyLabel || 'Chưa gắn proxy'}>
                  {proxyLabel ? (
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/25 text-[10px] font-medium text-emerald-300 max-w-full truncate">
                      <Shield className="w-3 h-3 shrink-0" />
                      <span className="truncate">{proxyLabel}</span>
                    </span>
                  ) : (
                    <span className="text-vira-muted">—</span>
                  )}
                </td>
                <td className="px-3 py-2 text-vira-muted truncate" title={task.prompt}>
                  {task.prompt}
                </td>
                <td
                  className={`px-3 py-2 truncate ${stateOf(task) === 'failed' ? 'text-rose-300' : 'text-vira-muted'}`}
                  title={noteOf(task)}
                >
                  {noteOf(task)}
                </td>
                <td className="px-3 py-2">
                  <TaskActions task={task} onPreview={onPreview} />
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}


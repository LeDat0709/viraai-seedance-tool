import React, { useState } from 'react'
import { Users, Plus, Trash2, Upload, X, Check } from 'lucide-react'
import { CharacterEntry, CharacterImage } from '../../../shared/types'

interface CharactersModalProps {
  characters: CharacterEntry[]
  onClose: () => void
}

const IMAGE_ROLES = ['Chính diện', 'Góc nghiêng', 'Toàn thân', 'Trang phục', 'Biểu cảm']

export const CharactersModal: React.FC<CharactersModalProps> = ({ characters, onClose }) => {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [tag, setTag] = useState('')
  const [description, setDescription] = useState('')
  const [images, setImages] = useState<CharacterImage[]>([])

  const resetForm = () => {
    setEditingId(null)
    setName('')
    setTag('')
    setDescription('')
    setImages([])
  }

  const startEdit = (char: CharacterEntry) => {
    setEditingId(char.id)
    setName(char.name)
    setTag(char.tag)
    setDescription(char.description)
    setImages(char.images || [])
  }

  const handlePickCharImages = async () => {
    const paths = await window.api.selectImages(true)
    if (!paths || paths.length === 0) return
    setImages((prev) => {
      const next = [...prev]
      for (const p of paths) {
        if (!next.some((x) => x.path === p) && next.length < 5) {
          next.push({
            path: p,
            role: IMAGE_ROLES[next.length % IMAGE_ROLES.length]
          })
        }
      }
      return next
    })
  }

  const handleSave = async () => {
    if (!name.trim() || !tag.trim()) return
    const cleanTag = tag
      .replace(/^@+/, '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '_')

    const entry: CharacterEntry = {
      id: editingId || `char-${Date.now()}`,
      name: name.trim(),
      tag: cleanTag,
      description: description.trim(),
      images,
      createdAt: Date.now()
    }
    await window.api.upsertCharacter(entry)
    resetForm()
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-6">
      <div className="bg-vira-panel border border-vira-border rounded-2xl w-full max-w-4xl max-h-[88vh] flex flex-col overflow-hidden shadow-2xl">
        {/* Header */}
        <div className="p-4 border-b border-vira-border flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Users className="w-5 h-5 text-vira-accent" />
            <h2 className="text-base font-bold">
              Kho Nhân Vật Đồng Nhất (@tag) — Giữ nguyên khuôn mặt & trang phục xuyên suốt các cảnh
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg bg-vira-card border border-vira-border text-vira-muted hover:text-white"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 grid grid-cols-1 md:grid-cols-2 gap-5">
          {/* Form */}
          <div className="bg-vira-card border border-vira-border rounded-xl p-4 space-y-3">
            <h3 className="text-xs font-bold uppercase tracking-wider text-vira-accent">
              {editingId ? 'Chỉnh sửa nhân vật' : 'Tạo nhân vật @tag mới'}
            </h3>

            <div className="grid grid-cols-2 gap-2.5">
              <div>
                <label className="text-xs text-vira-muted block mb-1">Tên nhân vật</label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value)
                    if (!editingId && !tag) {
                      setTag(
                        e.target.value
                          .toLowerCase()
                          .normalize('NFD')
                          .replace(/[\u0300-\u036f]/g, '')
                          .replace(/[^a-z0-9]+/g, '_')
                          .replace(/^_+|_+$/g, '')
                      )
                    }
                  }}
                  placeholder="VD: Thám tử Minh"
                  className="w-full bg-[#0b1220] border border-vira-border rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:border-vira-accent"
                />
              </div>
              <div>
                <label className="text-xs text-vira-muted block mb-1">Mã gọi nhanh (@tag)</label>
                <div className="flex items-center bg-[#0b1220] border border-vira-border rounded-lg px-2.5 py-1.5">
                  <span className="text-vira-accent font-bold text-xs mr-1">@</span>
                  <input
                    type="text"
                    value={tag}
                    onChange={(e) => setTag(e.target.value)}
                    placeholder="minh"
                    className="w-full bg-transparent text-xs focus:outline-none font-mono"
                  />
                </div>
              </div>
            </div>

            <div>
              <label className="text-xs text-vira-muted block mb-1">
                Mô tả cố định ngoại hình & trang phục (Tự động ghép vào prompt khi gõ @tag)
              </label>
              <textarea
                rows={3}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="VD: Nam 28 tuổi, tóc ngắn gọn gàng, mặc áo khoác trench coat màu nâu sẫm, đeo kính gọng bạc..."
                className="w-full bg-[#0b1220] border border-vira-border rounded-lg p-2.5 text-xs focus:outline-none focus:border-vira-accent"
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-xs text-vira-muted">
                  Ảnh mẫu nhân vật ({images.length}/5)
                </label>
                <button
                  onClick={handlePickCharImages}
                  className="text-xs flex items-center gap-1 px-2.5 py-1 rounded-lg bg-vira-accent/15 text-vira-accent hover:bg-vira-accent/25 font-medium"
                >
                  <Upload className="w-3.5 h-3.5" /> Thêm ảnh mẫu
                </button>
              </div>

              <div className="space-y-1.5">
                {images.map((img, idx) => (
                  <div
                    key={`${img.path}-${idx}`}
                    className="flex items-center gap-2 bg-[#0b1220] border border-vira-border rounded-lg p-1.5"
                  >
                    <img
                      src={`viraai-media://local/${encodeURIComponent(img.path)}`}
                      alt=""
                      className="w-10 h-10 rounded object-cover"
                    />
                    <select
                      value={img.role}
                      onChange={(e) => {
                        const next = [...images]
                        next[idx] = { ...next[idx], role: e.target.value }
                        setImages(next)
                      }}
                      className="flex-1 bg-vira-panel border border-vira-border rounded px-2 py-1 text-xs"
                    >
                      {IMAGE_ROLES.map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </select>
                    <button
                      onClick={() => setImages(images.filter((_, i) => i !== idx))}
                      className="p-1 text-rose-300 hover:text-rose-200"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            </div>

            <div className="flex items-center gap-2 pt-2">
              <button
                onClick={handleSave}
                className="flex-1 py-2 rounded-xl bg-vira-accent text-[#0b1220] font-bold text-xs flex items-center justify-center gap-1.5"
              >
                <Check className="w-4 h-4" />
                {editingId ? 'Lưu cập nhật' : 'Lưu nhân vật vào Kho'}
              </button>
              {editingId && (
                <button
                  onClick={resetForm}
                  className="px-3 py-2 rounded-xl bg-[#0b1220] border border-vira-border text-xs"
                >
                  Huỷ
                </button>
              )}
            </div>
          </div>

          {/* Character List */}
          <div className="space-y-2.5 max-h-[62vh] overflow-y-auto pr-1">
            {characters.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-center text-vira-muted p-8 border border-dashed border-vira-border rounded-xl">
                <Users className="w-8 h-8 mb-2 opacity-40" />
                <p className="text-xs">
                  Chưa có nhân vật nào. Hãy tạo nhân vật bên trái để dùng cú pháp{' '}
                  <code className="text-vira-accent">@tag</code> trong khung câu lệnh!
                </p>
              </div>
            ) : (
              characters.map((c) => (
                <div
                  key={c.id}
                  onClick={() => startEdit(c)}
                  className="bg-vira-card border border-vira-border hover:border-vira-accent rounded-xl p-3 cursor-pointer transition flex items-start justify-between gap-3"
                >
                  <div className="flex items-start gap-3 min-w-0">
                    {c.images[0] ? (
                      <img
                        src={`viraai-media://local/${encodeURIComponent(c.images[0].path)}`}
                        alt={c.name}
                        className="w-12 h-12 rounded-lg object-cover shrink-0 border border-vira-border"
                      />
                    ) : (
                      <div className="w-12 h-12 rounded-lg bg-[#0b1220] border border-vira-border flex items-center justify-center text-vira-accent font-bold text-xs shrink-0">
                        @{c.tag.slice(0, 3)}
                      </div>
                    )}
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-bold text-white">{c.name}</span>
                        <span className="text-xs font-mono px-1.5 py-0.5 rounded bg-vira-accent/15 text-vira-accent font-semibold">
                          @{c.tag}
                        </span>
                        <span className="text-[11px] text-vira-muted">
                          {c.images.length} ảnh mẫu
                        </span>
                      </div>
                      <p className="text-xs text-vira-muted line-clamp-2 mt-1">
                        {c.description || 'Chưa có mô tả ngoại hình'}
                      </p>
                    </div>
                  </div>

                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      window.api.deleteCharacter(c.id)
                    }}
                    className="p-1.5 rounded-lg bg-rose-500/10 text-rose-300 hover:bg-rose-500/20 shrink-0"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

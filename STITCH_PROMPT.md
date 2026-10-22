# Google Stitch — System Prompt cho ViraAI Seedance Studio

> Dán khối dưới vào Google Stitch (stitch.withgoogle.com). Có thể dán cả bài để tạo design system + nhiều màn, hoặc tách từng "SCREEN" để tạo lẻ từng màn.

---

## 1) Dán khối này trước để khoá DESIGN SYSTEM

```
You are designing a professional desktop app UI called "ViraAI Seedance Studio" — a batch AI video-generation automation tool. Design it as a polished, modern, dark "pro automation dashboard" (think Linear × Vercel × a video studio). Clean, dense-but-breathable, confident. NOT playful, NOT consumer-cute.

DESIGN SYSTEM (use exactly):
- Theme: dark only.
- Colors:
  - Background (app): #08120c (near-black, cool green-black)
  - Panel surface: #0b140d
  - Card surface: #0f1b12 with 1px border #1c2a20
  - Border: rgba(255,255,255,0.06)–#1c2a20
  - Primary accent (lime-green): #8cf05a  → primary buttons, active nav, highlights, progress bars
  - Primary accent text-on-accent: #08120c (dark text on green)
  - Text primary: #e6f5ea
  - Text muted: #7d9488
  - Status: success/ready = #8cf05a, warning/short = #f5b84a (amber), error/blocked = #f2616b (red), info = #5aa9f0 (blue)
- Typography: Inter. Sizes small & tight — titles 18–20px bold, body 12–13px, labels 11px uppercase tracking-wide for section headers.
- Radius: cards rounded-2xl (16px), buttons/inputs rounded-xl (12px), chips rounded-lg (10px).
- Spacing: 12–16px gaps, generous but efficient. 24px page padding.
- Buttons: primary = solid lime #8cf05a with dark text, bold. secondary = transparent with 1px border, muted text, hover → white text + accent border. danger = transparent, hover → red text + red border. All have an icon on the left.
- Badges: pill, 10–11px, with a small dot: green "Sẵn sàng", amber "Thiếu giây", red "Lỗi"/"Hết lượt", blue "Đang chạy".
- Interactions: subtle hover lift on cards, 150ms transitions, clear focus ring in accent, empty states with a centered icon + hint text.
- Language: Vietnamese UI labels.
```

## 2) SCREEN — Tạo dự án Video (màn chính)

```
Design the main "Tạo dự án Video" screen. Two-column layout inside the main area (left a fixed 60px icon sidebar is separate).

LEFT CONFIG PANEL (width ~460px, scrollable):
- "Dự án hiện tại": a dropdown of projects + "＋ Dự án mới" link + folder icon button.
- "MÔ HÌNH VIDEO AI (DOLA / CICI)" section with a right-aligned badge "6/8 acc sẵn sàng". Two big selectable model cards side by side: "Seedance 2.5 Pro — Chất lượng cao · 5s–30s" (selected, accent border + glow) and "Seedance 2.0 Fast — Tốc độ nhanh · 5s–15s". Below them two tabs: "Văn bản → Video" (active) and "Ảnh tham chiếu (0/10)".
- "DANH SÁCH CÂU LỆNH" section: header with "Kho @nhân_vật (0)" and "Nhập .txt" buttons; a large multiline textarea with placeholder; a checkbox "Tách mỗi dòng thành 1 video riêng".
- "THỜI LƯỢNG VIDEO": 4 chips 5/10/15/30 giây (one selected = accent).
- "TỶ LỆ KHUNG HÌNH": a 3×2 grid of ratio chips 9:16 (Dọc TikTok/Shorts), 16:9 (Ngang YouTube), 21:9 (Điện ảnh), 4:3, 1:1, 3:4 — each chip shows ratio big + sublabel small.
- "Cách chia lô tài khoản" dropdown (20 video/1 tài khoản, 10/1, Chia đều xoay vòng) and "Số luồng chạy song song" dropdown, and a toggle "Tự động Làm mới lượt (Recycle) khi hết quota".
- A full-width primary button "✨ Tạo Video Seedance 2.5 Pro".

RIGHT QUEUE PANEL (fills rest):
- Header: "Hàng đợi tạo Video (10)" + filter tabs [Tất cả | Đang chạy | Hoàn tất | Lỗi] + action buttons [⏸ Tạm dừng] [↻ Chạy lại các mục lỗi] [🗑 Dọn mục đã xong].
- A vertical list of task cards. Each card: left a 9:16 video thumbnail (or a colored placeholder with an error/clock icon), then: title "VIDEO #9" + small meta chips (9:16 · 10s, "Seedance 2.5 Pro", "Acc: Rokek Huwa"), a 2-line prompt, and a status line colored by state:
  - success (green check): "Đã tải video bản gốc thành công"
  - error (red): "Dola từ chối tạo video (vi phạm chính sách)"
  - busy (amber): "Dola Pro đang quá tải — sẽ tự chạy lại lúc 09:46"
  Right side action buttons: [▶ Xem] (green) for done, [↻ Thử lại] for errors, plus small icon buttons (cắt cảnh, mở thư mục, xoá).
```

## 3) SCREEN — Kho Video (thư viện)

```
Design the "Kho Video" (video library) screen.
- Header: "Kho Video Đã Tạo (13)" + a row of actions: account dropdown, "Kéo video từ tài khoản về" (primary), and "Mở thư mục: <tên kho>".
- A row of project "kho" tabs: [Tất cả (13)] then one chip per project with its count, plus a dashed "＋ Tạo kho mới" chip, and when a project is selected show "✏️ Đổi tên" and "🗑 Xoá kho".
- A search input "Tìm theo nội dung câu lệnh".
- A responsive grid (2–4 cols) of video cards: 9:16 thumbnail that plays on hover, a bottom-left badge "9:16 · 30s · 4.2 MB", a top-left project label chip (accent), and below: account name + time, a 2-line prompt, and footer icon buttons (mở thư mục, xoá).
- Empty state: centered film icon + "Dự án X chưa có video nào".
```

## 4) SCREEN — Trình xem video (modal, chuyên nghiệp)

```
Design a cinema-style video preview modal over a dark blurred backdrop.
- Centered card (max ~1000px) with: a top bar (video title + a small metadata line "9:16 · 30s · Seedance 2.5 Pro · 4.2MB · thời gian", and buttons [📁 Thư mục] [✕ Đóng]).
- A large black video stage.
- A custom control bar: a thin accent progress/scrub bar; left group = play/pause (accent circle), mute, time "0:12 / 0:30"; right group = speed button "1x", loop toggle, fullscreen.
- Left & right floating round arrows for previous/next video.
- A tiny hint line: "Space phát/dừng · ←/→ tua 5s · ,/. từng khung · F toàn màn hình · M tiếng · L lặp · Esc đóng".
```

## 5) SCREEN — Quản lý Tài khoản

```
Design the "Quản lý Tài khoản" screen as a data table dashboard (focus on layout/polish).
- Header "Quản lý Tài khoản (8)" + top actions [Kiểm tra tất cả] [Làm mới lượt] [Kéo video về].
- A table with columns: Bật (toggle switch), Tài khoản (name + sub id + sub status line), Loại (badge), Proxy gắn kèm (dropdown), Trạng thái (pill badge: green "Sẵn sàng" / red "Lỗi" / amber "Hết lượt"), Đã tạo hôm nay ("3/20 video" with a tiny progress bar vs the cap), Thao tác (icon buttons).
- Row hover highlight. Keep it dense and legible.
```

## 6) SCREEN — Cấu hình (Settings)

```
Design a clean settings screen: grouped cards with a label + description + control on the right (toggles, dropdowns, a folder path field with "Chọn"/"Mở" buttons). Groups: Thư mục lưu, Hiển thị trình duyệt khi tạo, Thời gian chờ (phút)… Keep it minimal, lots of breathing room.
```

## 7) Component sheet (tuỳ chọn, để Stitch thống nhất)

```
Also produce a components sheet: primary/secondary/danger buttons, status badges (success/warning/error/info with dot), a task card (3 states), a nav item with count badge, a selectable model card, a ratio chip, a toggle switch, a dropdown, an empty state. All in the dark lime-green design system above.
```

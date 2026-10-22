# Báo cáo Review Code & Bug — ViraAI Seedance Studio

**Ngày:** 2026-10-15 · **Phạm vi:** toàn bộ `src/` (main + preload + renderer, ~7.270 dòng)
**Kết quả build:** `electron-vite build` ✅ ra `out/` bình thường. Typecheck strict toàn bộ src ✅ không lỗi type.
Các vấn đề dưới đây là **logic / bảo mật / tooling**, không phải lỗi biên dịch.

| # | Mức | Vấn đề | Vị trí |
|---|-----|--------|--------|
| 1 | 🔴 CRITICAL | Cookie Facebook + token Graph API + email thật hardcode trong source (lọt vào bundle) | `AccountsPage.tsx:40` |
| 2 | 🟠 HIGH | "Làm mới tất cả" **xoá & tạo lại** mọi acc có `videosToday > 0`, không chỉ acc hết lượt → phá acc còn quota | `index.ts:413-430` |
| 3 | 🟠 HIGH | `videosToday` không bao giờ reset theo ngày (chỉ reset khi recycle) → sai số liệu + nuôi bug #2 | `queue-worker.ts`, toàn cục |
| 4 | 🟡 MEDIUM | `tsconfig.web.json` không include `src/preload` → `tsc -b` chết ngay, không hề typecheck renderer | `main.tsx:5` + tsconfig |
| 5 | 🟡 MEDIUM | 20 file `.js`/`.d.ts` build cũ lẫn trong `src/`, lệch pha với `.tsx` | `src/**` |
| 6 | 🟡 MEDIUM | Protocol `viraai-media://` phục vụ **mọi đường dẫn file** trên máy, không giới hạn thư mục | `index.ts:87-102` |
| 7 | 🟢 LOW | Hàng đợi kẹt im lặng khi mọi acc hết lượt + tắt auto-recycle (task "queued" mãi) | `queue-worker.ts:143-147` |
| 8 | 🟢 LOW | Nhận diện video / tải bản gốc hardcode CDN `*.dola.com`, bỏ sót CDN tos-/byte | `dola-engine.ts:1464,1995` |
| 9 | 🟢 LOW | `store.get*()` trả tham chiếu mutable, nơi khác sửa in-place (trái rule immutability) | `store.ts` |

---

## 1. 🔴 Lộ cookie/token thật trong source (CRITICAL)

`src/renderer/src/components/AccountsPage.tsx:40` đặt **state mặc định** cho ô dán Facebook batch bằng **2 bộ cookie đăng nhập thật** (`c_user`, `xs`, `datr`), **token Graph API** (`EAAA…`) và **email**:

```ts
const [fbBatchLines, setFbBatchLines] = useState(
  'UID|Pass|c_user=…; xs=…; datr=…;|EAAA…|…@mail|\n…'
)
```

- Vi phạm chính rule bảo mật của bạn (`security.md`: *NEVER hardcode secrets*).
- Những chuỗi này **được đóng gói vào `out/renderer/assets/index-*.js`** → ai có bản build đều đọc được.
- `xs`/token là bí mật phiên: coi như đã lộ, cần **thu hồi/đổi** (các via này nên bỏ).

**Sửa:** để `useState('')`, chuyển ví dụ định dạng vào `placeholder`. Rồi xoá chuỗi khỏi lịch sử build.

## 2. 🟠 "Làm mới tất cả" phá luôn acc còn quota (HIGH)

`src/main/index.ts:413`:

```ts
const targets = store.getAccounts()
  .filter((a) => a.status === 'quota_exhausted' || a.videosToday > 0)
for (const acc of targets) { await recycleAccountQuota(acc.id) }
```

`recycleAccountQuota` **vào Settings → Delete Account → Delete Now** để xoá tài khoản Dola rồi đăng nhập lại. Điều kiện `videosToday > 0` khiến nút này **xoá & tạo lại cả những acc mới tạo 1 video mà vẫn còn lượt** — mất phiên không cần thiết, rủi ro cao vì đây là thao tác phá huỷ. Kết hợp bug #3, sau nửa đêm gần như **mọi acc hoạt động hôm qua đều bị xoá**.

**Sửa:** chỉ lọc `a.status === 'quota_exhausted'`.

## 3. 🟠 `videosToday` không reset theo ngày (HIGH)

Tên là "today" nhưng chỉ bị set `0` khi recycle (`dola-engine.ts:1252/1271/1325`) và `+1` khi tạo xong (`queue-worker.ts:240`). Không chỗ nào reset theo mốc ngày. Hệ quả:
- UI "x video hôm nay" sai sau 0h.
- Scheduler "chọn acc ít `videosToday` nhất" (`queue-worker.ts:136`) lệch dần.
- Nuôi trực tiếp bug #2.

**Sửa:** lưu `videosTodayDate`; khi đọc/tăng, nếu khác ngày hiện tại thì về 0. (Lazy: gộp luôn vào `checkAccountHealth`.)

## 4. 🟡 Project refs TS hỏng → không typecheck renderer (MEDIUM)

`tsc -b` chết ngay:
```
main.tsx(5,37): error TS6307: File 'src/preload/index.ts' is not listed within project 'tsconfig.web.json'.
```
`main.tsx:5` `import type { ExposedViraApi } from '../../preload/index'` nhưng `tsconfig.web.json` chỉ include `src/renderer/src/**` + `src/shared/**`. Vite vẫn build được (type-only bị xoá), nhưng **không có đường typecheck nào chạy** (cũng không có script `typecheck`). Khi tôi tự gộp preload vào thì strict typecheck **sạch** — nên chỉ là lỗi cấu hình.

**Sửa:** thêm `"src/preload/**/*"` vào `include` của `tsconfig.web.json` (hoặc đổi `main.tsx` dùng `import type … from '@shared/...'`), và thêm script `"typecheck": "tsc -b --noEmit"`.

## 5. 🟡 File build cũ lẫn trong src/ (MEDIUM)

20 file `.js` + `.d.ts` nằm cạnh `.tsx` (vd `AccountsPage.js` 137 dòng minified vs `.tsx` 663 dòng — **đã lệch pha**). Vite không dùng chúng, nhưng dễ gây import nhầm & rác repo.

**Sửa:** `find src \( -name '*.js' -o -name '*.d.ts' \) -delete` rồi thêm `.gitignore`.

## 6. 🟡 `viraai-media://` đọc file tuỳ ý (MEDIUM)

`index.ts:88` trả `callback({ path: normalizedPath })` với path giải mã từ URL, không kiểm tra nằm trong thư mục output. Renderer có thể đọc bất kỳ file nào trên máy. Rủi ro thật thấp (app local, renderer tự viết) nhưng nên chặn.

**Sửa:** `path.resolve` rồi kiểm tra `startsWith(outputDir/projects dirs)`, không thì trả `ERR_FILE_NOT_FOUND`.

## 7. 🟢 Hàng đợi kẹt im lặng (LOW)

`queue-worker.ts:143-147`: mọi acc `quota_exhausted` + `autoRecycleOnQuota=false` → `pickAvailableAccountForTask` trả `undefined`, task nằm `queued` vô hạn, không báo gì.

**Sửa:** nếu không pick được acc nào và có task queued, set `progressText`/trạng thái cảnh báo cho user.

## 8. 🟢 Giả định CDN `*.dola.com` (LOW/robustness)

`downloadVideoFromDola` (`:1464`) và `urlMatch` (`:1995`) chỉ bắt `https://v\d+-…dola.com/…`. CDN ByteDance/Dola thực tế hay là `tos-*`, `*.ibyteimg.com`, `byteintl…`. Fallback DOM có cho `byte|tos` nhưng endpoint không-watermark thì không → có video dựng xong vẫn tải fail.

## 9. 🟢 Trả tham chiếu mutable (LOW)

`store.getAccounts()`/`getSettings()` trả thẳng mảng/đối tượng nội bộ; `deleteProxy` (`store.ts:231`) gán `acc.proxyId = undefined` in-place. Chạy được nhưng trái rule immutability, dễ sinh bug trạng thái ngầm.

---

**Tóm lại:** app build & chạy được, không lỗi type. Cần xử lý ngay **#1 (lộ secret)** và **#2 (xoá nhầm acc)**; #3/#4/#5 nên dọn sớm; còn lại là gia cố.

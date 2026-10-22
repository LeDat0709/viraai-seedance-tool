# ViraAI Seedance 2.5 Studio (Cross-Platform Unlocked Edition)

Công cụ tạo video AI hàng loạt qua **Dola / Cici (`Seedance 2.5 Pro`)** được xây dựng mới hoàn toàn bằng **Electron + React + TypeScript + Tailwind CSS**, hoạt động đa nền tảng trên cả **macOS** và **Windows** (đã loại bỏ hoàn toàn khoá bản quyền HWID / WebSocket từ xa).

---

## Tính năng chính

1. **Tạo Video Hàng Loạt qua Dola (`Seedance 2.5 Pro` & `Seedance 2.0 Fast`)**:
   - Hỗ trợ **Văn bản → Video** và **Ảnh tham chiếu → Video** (đính kèm tối đa 10 ảnh JPG/PNG/WEBP qua Chrome DevTools Protocol `DOM.setFileInputFiles`).
   - Hỗ trợ thời lượng **5s, 10s, 15s, 30s nguyên khối** (tự động chèn khối lệnh hệ thống ép Dola giữ nguyên 30 giây không cắt nhỏ) và tỷ lệ khung hình **9:16, 16:9, 21:9, 4:3, 1:1, 3:4**.
   - Tự động chuyển chế độ chat từ **Fast** sang **Pro** bằng cú click chuột toạ độ thật (`sendInputEvent`).
   - Tải video **bản gốc không logo** trực tiếp từ API `/creativity/resource/get_without_watermark?device_platform=web`.

2. **Tự động Làm mới lượt / Recycle Tài khoản (`lamMoiLuot`)**:
   - Khi tài khoản chạm giới hạn tạo video trong ngày (`reached the daily limit`), công cụ tự động xoá tài khoản Dola cũ (`Settings → Account → Delete Account → Delete Now`), xoá cookie phiên cũ và đăng nhập lại bằng cùng tài khoản Google (kèm tự động bấm vượt cổng xác nhận tuổi **18+ Confirm your age**) để nhận ngay lượt tạo video mới.

3. **Quản lý Tài khoản Dola Đa Luồng (`Account Pool`)**:
   - Thêm tài khoản bằng **Cookie** (kiểm tra tự động các cookie lõi `sid_guard`, `sessionid`, `sid_tt`).
   - Thêm hàng loạt bằng **Google Email|Mật khẩu** (tự động điền đăng nhập + vượt cổng 18+, tự hiện cửa sổ nếu gặp Captcha/2FA).
   - Mở trình duyệt riêng biệt cho từng tài khoản (`persist:dola-<id>`).

4. **Kho Nhân Vật Đồng Nhất (`@tag`)**:
   - Lưu tên, mã `@tag`, mô tả ngoại hình cố định và tối đa 5 ảnh mẫu theo góc chụp (`Chính diện`, `Góc nghiêng`, `Toàn thân`...).
   - Khi gõ `@tag` trong khung câu lệnh, hệ thống hiển thị gợi ý tự động và ghép mô tả + đính kèm ảnh mẫu của nhân vật vào lệnh tạo video.

5. **Quản lý Proxy Tĩnh & Key Proxy Xoay**:
   - Hỗ trợ Proxy tĩnh `HTTP` / `SOCKS5` (`host:port:user:pass`) và Key Proxy Xoay (`TMProxy`, `KiotProxy`, `WWProxy`, `Tinsoft`, `Custom URL`).
   - Tự động ghép 1-1 vào các tài khoản đang bật.

6. **Kho Video & Trích khung hình cuối nối cảnh**:
   - Xem trực tiếp video trong ứng dụng qua giao thức `viraai-media://`.
   - Nút **"Kéo video từ tài khoản về"** giúp quét lại lịch sử hội thoại Dola để tải các video đã render xong mà không tốn thêm credit.
   - Nút **Trích khung hình cuối** (qua `ffmpeg`) để nối tiếp cảnh quay liền mạch.

---

## Hướng dẫn Chạy & Đóng gói

### 1. Cài đặt thư viện
```bash
pnpm install
# hoặc: npm install
```

### 2. Chạy ở chế độ Phát triển (Development)
```bash
pnpm dev
# hoặc: npm run dev
```

### 3. Biên dịch & Đóng gói bản cài đặt (.dmg cho macOS / .exe cho Windows)
```bash
# Kiểm tra build ra thư mục out/
pnpm build

# Đóng gói cho macOS (.dmg / .zip)
pnpm dist:mac

# Đóng gói cho Windows (.exe NSIS)
pnpm dist:win
```

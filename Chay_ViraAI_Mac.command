#!/bin/zsh
cd "$(dirname "$0")"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if command -v fnm >/dev/null 2>&1; then
  eval "$(fnm env)"
fi
# Đóng triệt để tiến trình ViraAI cũ (nếu đang mở) để không bị chạy trùng 2 tiến trình
pkill -9 -f "viraai-seedance-tool/node_modules/.*Electron.app/Contents/MacOS/Electron" 2>/dev/null || true
sleep 1
# Ẩn các mẫu log noise vô hại của Chromium/Electron trên macOS, giữ nguyên log thật.
NOISE='sysctlbyname for kern.hv_vmm_present|host_get_exception_ports|Unsupported pixel format: -1|invalid referrer|ssl_client_socket_impl'
# "electron ." (không phải ./out/main/index.js) để dữ liệu luôn ở ~/Library/Application Support/viraai-seedance-studio
unset ELECTRON_RUN_AS_NODE
./node_modules/.bin/electron . 2> >(grep --line-buffered -vE "$NOISE" >&2)

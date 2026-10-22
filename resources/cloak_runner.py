#!/usr/bin/env python3
"""CloakBrowser + Patchright Anti-Detect Runner for ViraAI Seedance Studio.

Replaces Electron BrowserWindow for Dola authentication (Facebook OAuth, Google OAuth,
interactive browser sessions, and session verification) using the C++-patched CloakBrowser
Chromium kernel (`~/.cloakbrowser/...`).

Key anti-detect invariants (proven in dola-render-gateway):
1. Fixed C++ fingerprint seed per account: `--fingerprint=<seed>` where
   seed = 10000 + int(sha256(account_key), 16) % 90000.
2. Native platform flag: `--fingerprint-platform=macos` (on Darwin) or `windows`.
3. Timezone via binary flag (`--fingerprint-timezone=Asia/Ho_Chi_Minh`), NEVER via
   Playwright `timezone_id` (which calls CDP `Emulation.setTimezoneOverride`).
4. WebRTC leak protection via binary flag (`--force-webrtc-ip-handling-policy=disable_non_proxied_udp`),
   NEVER via JS `Object.defineProperty` tampering.
5. Local TCP Proxy Relay (`127.0.0.1:<port>`) for authenticated proxies so Chromium never
   prompts for credentials or conflicts with request routing.
6. MV3 DNR `logout_guard` extension + `context.route(/\/passport\/[^/]+\/logout/)` so
   ByteDance Shark can never wipe `sessionid`.
7. Real CDP mouse clicks (`page.mouse.click(x, y)`) on Dola's Facebook OAuth icon,
   automatic 18+ age-gate confirmation, `msToken` capture (`cookie` + `watch_mstoken` + `xmst`),
   and far-future cookie pinning (`_FAR_FUTURE`).
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import glob
import hashlib
import hmac
import json
import os
import platform
import re
import signal
import struct
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple
from urllib.parse import parse_qs, unquote, urlsplit

from patchright.async_api import async_playwright

DOLA_LOGOUT_RE = re.compile(r"/passport/[^/]+/logout")
_FAKE_LOGOUT_OK = '{"code":0,"message":"success","data":{}}'
PASSPORT_INFO_PATH = "/passport/account/info/v2/?aid=495671"
_FAR_FUTURE = int(time.time()) + 5 * 365 * 86400

LAUNCH_ARGS = [
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
]

_SESSION_COOKIE_NAMES = (
    "sessionid",
    "sessionid_ss",
    "sid_tt",
    "sid_guard",
    "uid_tt",
    "uid_tt_ss",
    "ssid_ucp_v1",
    "passport_csrf_token",
    "msToken",
    "_web_id",
    "ttwid",
    "odin_tt",
)

CONTINUE_LABELS = (
    "Continue as",
    "Tiếp tục dưới tên",
    "Tiếp tục với tư cách",
    "Tiếp tục",
    "続行",
    "Continue",
    "同意して続行",
    "Reconnect",
)

_THIRTYSEC_HIJACK_JS = r"""
(() => {
  if (window.__dola30Hijack) return; window.__dola30Hijack = true;
  const of = window.fetch;
  const m = (u, p) => (typeof u === 'string' ? u : (u && u.url) || '').includes(p);

  const patchSkillPack = (obj) => {
    try {
      const meta = obj && obj.data && obj.data.video_generation && obj.data.video_generation.meta;
      if (!meta) return obj;
      for (const opt of (meta.option_list || [])) {
        if (opt.value === 'duration' || /duration|时长|時間|長さ/i.test(opt.show_name || '')) {
          const opts = opt.options = opt.options || [];
          if (!opts.some(o => String(o.value) === '30'))
            opts.push({ show_name: '30s', value: '30', is_default: false, sub_display: '' });
        }
      }
      const cap = meta.model_capability || {};
      for (const k of Object.keys(cap)) {
        const d = (cap[k].supported_durations || []).map(String);
        if (!d.includes('30')) d.push('30');
        cap[k].supported_durations = d;
      }
    } catch (e) {}
    return obj;
  };

  const isDur = (label, key, options) => key === 'video-duration' || key === 'duration'
    || /时长|時間|長さ|duration/i.test(label || '')
    || (options.some(o => String((o && (o.option_key || o.value)) || '') === '5')
        && options.some(o => String((o && (o.option_key || o.value)) || '') === '10'));
  const patchAB = (v) => {
    if (!v || typeof v !== 'object') return v;
    if (Array.isArray(v)) { v.forEach(patchAB); return v; }
    const options = Array.isArray(v.option_list) ? v.option_list : [];
    const label = String(v.label || v.display_text || v.show_name || '');
    const key = String(v.key || v.value || '');
    if (options.length && isDur(label, key, options)) {
      if (!options.some(o => String((o && (o.option_key || o.value)) || '') === '30')) {
        const ti = options.findIndex(o => String((o && (o.option_key || o.value)) || '') === '10');
        const maxId = options.reduce((mx, o) => Number.isFinite(Number(o && o.id)) ? Math.max(mx, Number(o && o.id)) : mx, 0);
        options.splice(ti >= 0 ? ti + 1 : options.length, 0, { id: maxId + 1, display_text: '30s', message_text: '', option_key: '30' });
      }
    }
    for (const k of Object.keys(v)) {
      const c = v[k];
      if (typeof c === 'string' && (c.includes('"option_key"') || c.includes('"video-duration"') || c.includes('duration'))) {
        try { const j = JSON.parse(c); patchAB(j); v[k] = JSON.stringify(j); } catch (e) {}
      } else { patchAB(c); }
    }
    return v;
  };

  const patchText = (url, text) => {
    try {
      const j = JSON.parse(text);
      return JSON.stringify(m(url, 'skill/pack') ? patchSkillPack(j) : patchAB(j));
    } catch (e) { return text; }
  };
  const isCfgUrl = (u) => m(u, 'skill/pack') || m(u, 'get_item_conf') || m(u, 'slot/action_bar');
  const nativeLike = (fn, goc) => {
    try { Object.defineProperty(fn, 'toString', { value: () => goc.toString(), writable: true, configurable: true }); }
    catch (e) {}
    return fn;
  };
  const xs = new WeakMap();
  const XP = XMLHttpRequest.prototype;
  const xOpen = XP.open;
  XP.open = nativeLike(function (method, url) { xs.set(this, { url: String(url) }); return xOpen.apply(this, arguments); }, xOpen);
  for (const name of ['responseText', 'response']) {
    const d = Object.getOwnPropertyDescriptor(XP, name);
    if (!d || !d.get) continue;
    const get = nativeLike(function () {
      const v = d.get.call(this);
      const st = xs.get(this);
      if (this.readyState !== 4 || typeof v !== 'string' || (this.responseType && this.responseType !== 'text')
          || !st || !isCfgUrl(st.url)) return v;
      if (st.src !== v) { st.src = v; st.out = patchText(st.url, v); }
      return st.out;
    }, d.get);
    Object.defineProperty(XP, name, { configurable: true, enumerable: d.enumerable, get });
  }

  window.fetch = async function (input, init) {
    const r = await of.apply(this, arguments);
    try {
      if (m(input, 'samantha/skill/pack') || m(input, 'skill/pack')) {
        const j = await r.clone().json();
        return new Response(JSON.stringify(patchSkillPack(j)), { status: r.status, statusText: r.statusText, headers: r.headers });
      }
      if (m(input, 'action_bar_v3/get_item_conf') || m(input, 'get_item_conf') || m(input, 'slot/action_bar')) {
        const j = await r.clone().json();
        return new Response(JSON.stringify(patchAB(j)), { status: r.status, statusText: r.statusText, headers: r.headers });
      }
    } catch (e) {}
    return r;
  };
})();
"""

_FB_ICON_XY_JS = """() => {
  const dlg = document.querySelector('.semi-modal-wrap, [role="dialog"]') || document.body;
  if (!dlg) return null;
  const vis = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 4 || r.height <= 4) return false;
    const st = getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none' && Number(st.opacity) > 0.01;
  };
  const center = (el) => {
    const r = el.getBoundingClientRect();
    return (r.width && r.height) ? {x: r.left + r.width / 2, y: r.top + r.height / 2} : null;
  };
  const p = dlg.querySelector('svg path[d^="M12 2C6.203 2 1.5 6.73"], svg path[fill="#0068FF" i], svg path[fill="#1877F2" i]');
  if (p && vis(p.closest('svg') || p)) return center(p.closest('svg') || p);
  const pgv = [...dlg.querySelectorAll('.button-PgvIWh')].filter(vis);
  if (pgv.length >= 2) {
    pgv.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
    return center(pgv[Math.floor(pgv.length / 2)]);
  }
  const icons = [...dlg.querySelectorAll('svg')].filter((sv) => {
    if (!vis(sv)) return false;
    const r = sv.getBoundingClientRect();
    return r.width >= 16 && r.width <= 44 && Math.abs(r.width - r.height) <= 8;
  }).sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
  return icons.length === 3 ? center(icons[1]) : null;
}"""


def emit_json(payload: Dict[str, Any]) -> None:
    """Writes a single JSON line to stdout for Node.js IPC."""
    try:
        sys.stdout.write("__CLOAK_EVENT__" + json.dumps(payload, ensure_ascii=False) + "\n")
        sys.stdout.flush()
    except Exception:
        pass


def emit_step(msg: str) -> None:
    emit_json({"type": "step", "message": msg})


# ── Local TCP Proxy Relay (127.0.0.1) ─────────────────────────────────────────
_relay_loop_instance: Optional[asyncio.AbstractEventLoop] = None
_relay_lock = threading.Lock()
_relays: Dict[Tuple[str, int, str, str], int] = {}
_PIPE_CHUNK = 64 * 1024


def _with_proxy_auth(head: bytes, auth: str) -> bytes:
    lines = head.rstrip(b"\r\n").split(b"\r\n")
    is_connect = lines[0].upper().startswith(b"CONNECT ")
    drop = (
        {b"proxy-authorization"}
        if is_connect
        else {b"proxy-authorization", b"proxy-connection", b"connection"}
    )
    kept = [ln for ln in lines[1:] if ln.split(b":", 1)[0].strip().lower() not in drop]
    extra = [b"Proxy-Authorization: " + auth.encode()]
    if not is_connect:
        extra.append(b"Connection: close")
    return b"\r\n".join([lines[0], *kept, *extra]) + b"\r\n\r\n"


async def _pipe_streams(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    try:
        while data := await reader.read(_PIPE_CHUNK):
            writer.write(data)
            await writer.drain()
    except (ConnectionError, OSError):
        pass
    finally:
        try:
            writer.close()
        except Exception:
            pass


async def _start_relay_server(host: str, port: int, user: str, password: str) -> int:
    auth = "Basic " + base64.b64encode(f"{user}:{password}".encode()).decode()

    async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        up_writer = None
        try:
            head = await reader.readuntil(b"\r\n\r\n")
            up_reader, up_writer = await asyncio.open_connection(host, port)
            up_writer.write(_with_proxy_auth(head, auth))
            await up_writer.drain()
            await asyncio.gather(_pipe_streams(reader, up_writer), _pipe_streams(up_reader, writer))
        except Exception:
            pass
        finally:
            for w in (writer, up_writer):
                if w:
                    try:
                        w.close()
                    except Exception:
                        pass

    server = await asyncio.start_server(handle, "127.0.0.1", 0)
    return server.sockets[0].getsockname()[1]


def _get_relay_loop() -> asyncio.AbstractEventLoop:
    global _relay_loop_instance
    if _relay_loop_instance is None:
        _relay_loop_instance = asyncio.new_event_loop()
        threading.Thread(target=_relay_loop_instance.run_forever, name="cloak-proxy-relay", daemon=True).start()
    return _relay_loop_instance


def parse_proxy_string(raw: Optional[str]) -> Optional[Dict[str, str]]:
    if not raw or not raw.strip():
        return None
    s = raw.strip()
    scheme = "http"
    if "://" in s:
        scheme, s = s.split("://", 1)
    user = pw = None
    if "@" in s:
        cred, s = s.rsplit("@", 1)
        if ":" in cred:
            user, pw = cred.split(":", 1)
        else:
            user = cred
    parts = s.split(":")
    if len(parts) == 4 and user is None:
        host, port, user, pw = parts
    elif len(parts) >= 2:
        host, port = parts[0], parts[1]
    else:
        return None
    if not host.strip() or not port.strip().isdigit():
        return None
    out: Dict[str, str] = {"server": f"{scheme}://{host.strip()}:{port.strip()}"}
    if user:
        out["username"] = user
    if pw:
        out["password"] = pw
    return out


def to_local_relay_proxy(cfg: Optional[Dict[str, str]]) -> Optional[Dict[str, str]]:
    if not cfg or not cfg.get("username"):
        return cfg
    u = urlsplit(cfg["server"])
    if (u.scheme or "http").lower() != "http" or not u.hostname or not u.port:
        return cfg
    key = (u.hostname, u.port, cfg["username"], cfg.get("password") or "")
    with _relay_lock:
        port = _relays.get(key)
        if port is None:
            port = asyncio.run_coroutine_threadsafe(_start_relay_server(*key), _get_relay_loop()).result(10)
            _relays[key] = port
    return {"server": f"http://127.0.0.1:{port}"}


# ── CloakBrowser Binary & Profile Management ──────────────────────────────────
def resolve_cloak_binary() -> str:
    override = os.environ.get("CLOAKBROWSER_BINARY_PATH", "").strip()
    if override and Path(override).exists():
        return override

    cache_dir = Path(os.environ.get("CLOAKBROWSER_CACHE_DIR") or (Path.home() / ".cloakbrowser"))
    if cache_dir.exists():
        if platform.system() == "Darwin":
            candidates = sorted(
                cache_dir.glob("chromium-*/Chromium.app/Contents/MacOS/Chromium"),
                reverse=True,
            )
        elif platform.system() == "Windows":
            candidates = sorted(cache_dir.glob("chromium-*/chrome.exe"), reverse=True)
        else:
            candidates = sorted(cache_dir.glob("chromium-*/chrome"), reverse=True)
        for c in candidates:
            if c.exists():
                return str(c)

    from cloakbrowser.download import ensure_binary
    return ensure_binary()


def assert_profile_free(profile_dir: Path) -> None:
    if sys.platform == "win32":
        wlock = profile_dir / "lockfile"
        if not wlock.exists():
            return
        try:
            with open(wlock, "r+b"):
                pass
        except PermissionError:
            return
        except OSError:
            return
        for f in ("lockfile", "SingletonLock", "SingletonCookie", "SingletonSocket"):
            try:
                (profile_dir / f).unlink(missing_ok=True)
            except Exception:
                pass
        return

    lock = profile_dir / "SingletonLock"
    if not lock.is_symlink():
        return
    try:
        pid_text = os.readlink(lock).rsplit("-", 1)[-1]
    except OSError:
        return

    def _clean() -> None:
        for f in ("SingletonLock", "SingletonCookie", "SingletonSocket"):
            try:
                (profile_dir / f).unlink(missing_ok=True)
            except Exception:
                pass

    if not pid_text.isdigit():
        _clean()
        return
    pid = int(pid_text)
    try:
        os.kill(pid, 0)
    except (ProcessLookupError, PermissionError):
        _clean()
        return

    holds = False
    try:
        cmd = subprocess.run(
            ["ps", "-p", str(pid), "-o", "command="],
            capture_output=True,
            text=True,
            timeout=4,
        ).stdout
        holds = str(profile_dir) in cmd or f"user-data-dir={profile_dir}" in cmd
    except Exception:
        holds = False
    if holds:
        try:
            os.kill(pid, 9)
        except Exception:
            pass
        time.sleep(0.5)
        _clean()
        return
    _clean()


def compute_cloak_seed(account_key: str) -> int:
    return 10000 + int(hashlib.sha256(account_key.encode()).hexdigest(), 16) % 90000


def totp_code(secret: str) -> str:
    clean = re.sub(r"[^A-Z2-7]", "", (secret or "").upper())
    if len(clean) < 8:
        return ""
    pad = (-len(clean)) % 8
    key = base64.b32decode(clean + "=" * pad, casefold=True)
    counter = struct.pack(">Q", int(time.time()) // 30)
    mac = hmac.new(key, counter, hashlib.sha1).digest()
    offset = mac[-1] & 0x0F
    binary = struct.unpack(">I", mac[offset : offset + 4])[0] & 0x7FFFFFFF
    return f"{binary % 1_000_000:06d}"


def cookie_value(cookies: List[Dict[str, Any]], name: str) -> str:
    return next((str(c["value"]) for c in cookies if c.get("name") == name and c.get("value")), "")


def parse_cookie_header_to_list(raw: str, default_domain: str) -> List[Dict[str, Any]]:
    raw = (raw or "").strip()
    if not raw:
        return []
    if raw.startswith("[") and raw.endswith("]"):
        try:
            items = json.loads(raw)
            out = []
            for it in items:
                if isinstance(it, dict) and it.get("name") and it.get("value"):
                    out.append(
                        {
                            "name": str(it["name"]).strip(),
                            "value": str(it["value"]).strip(),
                            "domain": it.get("domain") or default_domain,
                            "path": it.get("path") or "/",
                            "secure": True,
                            "httpOnly": bool(it.get("httpOnly", False)),
                            "sameSite": "Lax",
                            "expires": _FAR_FUTURE,
                        }
                    )
            if out:
                return out
        except Exception:
            pass

    semi = raw.replace("\n", ";").replace("\r", ";")
    out = []
    for part in semi.split(";"):
        part = part.strip()
        if not part or "=" not in part:
            continue
        k, v = part.split("=", 1)
        name = k.strip()
        val = v.strip().strip('"')
        if not name or not val:
            continue
        if "facebook.com" in default_domain and "%" in val:
            try:
                val = unquote(val)
            except Exception:
                pass
        is_http_only = name.lower() in ("xs", "datr", "fr", "sb", "c_user", "sessionid", "sessionid_ss", "sid_tt", "sid_guard")
        out.append(
            {
                "name": name,
                "value": val,
                "domain": default_domain,
                "path": "/",
                "secure": True,
                "httpOnly": is_http_only,
                "sameSite": "Lax",
                "expires": _FAR_FUTURE,
            }
        )
    return out


def _is_dola_url(url: str) -> bool:
    host = urlsplit(url).hostname or ""
    return host == "dola.com" or host.endswith(".dola.com")


def _mstoken_from_url(url: str) -> str:
    if not _is_dola_url(url):
        return ""
    return (parse_qs(urlsplit(url).query).get("msToken") or [""])[0]


def watch_mstoken(context) -> List[str]:
    seen: List[str] = []

    def _on_request(request):
        try:
            tok = _mstoken_from_url(request.url)
            if tok:
                seen.append(tok)
        except Exception:
            pass

    context.on("request", _on_request)
    return seen


async def _page_mstoken(context) -> str:
    for p in context.pages:
        if not _is_dola_url(p.url):
            continue
        try:
            tok = await p.evaluate("() => localStorage.getItem('xmst') || ''")
            if tok:
                return str(tok)
        except Exception:
            continue
    return ""


async def _page_web_id(context) -> str:
    for p in context.pages:
        if not _is_dola_url(p.url):
            continue
        try:
            wid = await p.evaluate(
                """() => {
                  try {
                    const s = JSON.parse(localStorage.getItem('samantha_web_web_id') || 'null');
                    if (s && s.web_id) return String(s.web_id);
                    const t = JSON.parse(localStorage.getItem('_tea_cache_tokens_495671') || 'null');
                    if (t && t.web_id) return String(t.web_id);
                  } catch (e) {}
                  return '';
                }"""
            )
            if wid:
                return str(wid)
        except Exception:
            continue
    return ""


async def load_logout_guard_extension(context, ext_dir: Optional[str]) -> None:
    if not ext_dir or not Path(ext_dir).is_dir():
        return
    try:
        cdp = await context.browser.new_browser_cdp_session()
        await cdp.send("Extensions.loadUnpacked", {"path": str(Path(ext_dir).resolve())})
    except Exception:
        pass


async def block_dola_logout(context) -> None:
    async def _fake_ok(route):
        try:
            await route.fulfill(status=200, content_type="application/json", body=_FAKE_LOGOUT_OK)
        except Exception:
            pass

    try:
        await context.route(DOLA_LOGOUT_RE, _fake_ok)
    except Exception:
        pass


async def force_ui_language(context, lang: str = "en") -> None:
    cookies = [
        {"name": name, "value": lang, "domain": domain, "path": "/", "secure": True, "expires": _FAR_FUTURE}
        for name in ("i18next", "user_language_code")
        for domain in (".dola.com", "www.dola.com")
    ]
    try:
        await context.add_cookies(cookies)
    except Exception:
        pass


async def pin_session_cookies(context) -> List[Dict[str, Any]]:
    try:
        live = await context.cookies("https://www.dola.com")
    except Exception:
        return []
    pinned = []
    for c in live:
        if not c.get("name") or not c.get("value"):
            continue
        same_site = c.get("sameSite")
        pinned.append(
            {
                "name": c["name"],
                "value": c["value"],
                "domain": c.get("domain") or ".dola.com",
                "path": c.get("path") or "/",
                "secure": bool(c.get("secure", True)),
                "httpOnly": bool(c.get("httpOnly", False)),
                "sameSite": same_site if same_site in ("Strict", "Lax", "None") else "Lax",
                "expires": _FAR_FUTURE,
            }
        )
    if pinned:
        try:
            await context.add_cookies(pinned)
        except Exception:
            pass
    return pinned


async def restore_dola_cookies_if_needed(
    context,
    account_dir: Path,
    initial_dola_cookie: str,
) -> None:
    try:
        jar = await context.cookies("https://www.dola.com")
    except Exception:
        jar = []
    if cookie_value(jar, "sessionid"):
        return

    # 1. Check cookies.json in account_dir
    saved_file = account_dir / "cookies.json"
    restored: List[Dict[str, Any]] = []
    if saved_file.exists():
        try:
            raw_saved = json.loads(saved_file.read_text(encoding="utf-8"))
            if isinstance(raw_saved, list):
                for c in raw_saved:
                    if isinstance(c, dict) and c.get("name") in _SESSION_COOKIE_NAMES and c.get("value"):
                        same_site = c.get("sameSite")
                        restored.append(
                            {
                                "name": c["name"],
                                "value": c["value"],
                                "domain": c.get("domain") or ".dola.com",
                                "path": c.get("path") or "/",
                                "secure": bool(c.get("secure", True)),
                                "httpOnly": bool(c.get("httpOnly", False)),
                                "sameSite": same_site if same_site in ("Strict", "Lax", "None") else "Lax",
                                "expires": _FAR_FUTURE,
                            }
                        )
        except Exception:
            pass

    # 2. Also merge initial_dola_cookie from ViraAI store
    if initial_dola_cookie:
        existing_names = {c["name"] for c in restored}
        for c in parse_cookie_header_to_list(initial_dola_cookie, ".dola.com"):
            if c["name"] not in existing_names:
                restored.append(c)

    if restored:
        try:
            await context.add_cookies(restored)
        except Exception:
            pass


async def inject_facebook_cookies(context, fb_cookie_raw: str) -> None:
    cookies = parse_cookie_header_to_list(fb_cookie_raw, ".facebook.com")
    if not cookies:
        return
    try:
        # Clear any stale/expired facebook.com cookies in the persistent profile first
        # so Chromium never sends duplicate c_user/xs headers that invalidate the session.
        await context.clear_cookies(domain=re.compile(r"(^|\.)facebook\.com$", re.I))
    except Exception:
        pass
    dedup: Dict[str, Dict[str, Any]] = {}
    for c in cookies:
        dedup[c["name"]] = {**c, "domain": ".facebook.com"}
    try:
        await context.add_cookies(list(dedup.values()))
    except Exception:
        pass


async def probe_dola_identity_in_page(page) -> Dict[str, Any]:
    """Queries Dola's passport & alice/profile/self_brief from INSIDE the CloakBrowser page
    so ByteDance's window.bdms signs the request genuinely, and also confirms 18+ age gate."""
    try:
        res = await page.evaluate(
            """async () => {
              const out = { ok: false, userId: '', screenName: '', isGuest: false, errorCode: 0 };
              try {
                // Proactively report 18+ age gate & hit_register in-page
                await fetch('/alice/age_gate/report?aid=495671&device_platform=web&version_code=20800&samantha_web=1', {
                  method: 'POST',
                  credentials: 'include',
                  headers: { 'Content-Type': 'application/json', 'agw-js-conv': 'str' },
                  body: JSON.stringify({ scene: 1, pass: true })
                }).catch(() => {});
              } catch (e) {}

              try {
                const r1 = await fetch('/passport/account/info/v2/?aid=495671', {
                  method: 'GET',
                  credentials: 'include',
                  headers: { 'Accept': 'application/json' }
                });
                const j1 = await r1.json();
                const d1 = (j1 && j1.data) || {};
                if (j1 && j1.message === 'success' && (d1.user_id || d1.user_id_str)) {
                  out.ok = true;
                  out.userId = String(d1.user_id_str || d1.user_id || '');
                  out.screenName = String(d1.name || d1.screen_name || d1.email || '');
                } else if (d1.error_code === 13) {
                  out.isGuest = true;
                  out.errorCode = 13;
                }
              } catch (e) {}

              try {
                const r2 = await fetch('/alice/profile/self_brief?version_code=20800&language=en&device_platform=web&aid=495671&real_aid=495671&samantha_web=1&use-olympus-account=1', {
                  method: 'POST',
                  credentials: 'include',
                  headers: { 'Content-Type': 'application/json', 'agw-js-conv': 'str' },
                  body: '{}'
                });
                const j2 = await r2.json();
                const j2Code = Number((j2 && (j2.code ?? j2.status_code)) || 0);
                const pb = (j2 && j2.data && j2.data.profile_brief) || (j2 && j2.data) || {};
                const uid = String(pb.id || pb.user_id || '');
                if (uid && uid !== '0' && !pb.is_guest && j2Code === 0) {
                  out.ok = true;
                  out.isGuest = false;
                  if (!out.userId) out.userId = uid;
                  if (pb.nickname || pb.name) out.screenName = String(pb.nickname || pb.name);
                } else if (
                  pb.is_guest === true ||
                  j2Code === 710012014 ||
                  j2Code === 710012003 ||
                  j2Code === 710012001
                ) {
                  out.ok = false;
                  out.isGuest = true;
                  out.errorCode = j2Code || 13;
                }
              } catch (e) {}

              return out;
            }"""
        )
        return res if isinstance(res, dict) else {"ok": False}
    except Exception:
        return {"ok": False}


async def send_initial_greeting_hi(page, account_dir: Path) -> bool:
    """Sends a warm-up 'hi' message in Dola chat (matching DTMAX ab-chat-hi.cjs 'Initial Greeting')
    right after OAuth login so Dola initializes the account on the server and does not purge it
    with code 710012014 ('The account does not exist'). Runs at most once per account profile."""
    marker = account_dir / "greeted_hi.txt"
    if marker.exists():
        return True

    try:
        await _confirm_age_gate(page)
        emit_step("[CloakBrowser] Đang gửi tin nhắn mồi 'hi' (Initial Greeting) để kích hoạt tài khoản Dola…")

        # Wait up to 6s for composer box to appear on /chat
        composer_info = None
        for _ in range(12):
            composer_info = await page.evaluate(
                """() => {
                  const vis = (el) => {
                    if (!el) return false;
                    const r = el.getBoundingClientRect();
                    return r.width > 20 && r.height > 12;
                  };
                  const candidates = [
                    ...document.querySelectorAll('[data-testid="chat_input"] [contenteditable="true"], div.ProseMirror[contenteditable="true"], textarea[data-testid="chat_input"], textarea, [contenteditable="true"]')
                  ].filter(vis);
                  const el = candidates[0];
                  if (!el) return { ok: false };
                  try { el.scrollIntoView({ block: 'center' }); } catch (e) {}
                  try { el.focus(); } catch (e) {}
                  const r = el.getBoundingClientRect();
                  const bodyText = (document.body && document.body.innerText) || '';
                  return {
                    ok: true,
                    x: Math.round(r.left + r.width / 2),
                    y: Math.round(r.top + r.height / 2),
                    isEditable: el.isContentEditable === true,
                    bodyLen: bodyText.length
                  };
                }"""
            )
            if isinstance(composer_info, dict) and composer_info.get("ok"):
                break
            await asyncio.sleep(0.5)

        if not isinstance(composer_info, dict) or not composer_info.get("ok"):
            return False

        before_len = int(composer_info.get("bodyLen") or 0)
        x = int(composer_info.get("x") or 0)
        y = int(composer_info.get("y") or 0)
        if x > 0 and y > 0:
            try:
                await page.mouse.click(x, y)
                await asyncio.sleep(0.15)
            except Exception:
                pass

        # Type 'hi' with human-like key events and fallback to InputEvent (exact ab-chat-hi.cjs logic)
        try:
            await page.keyboard.type("hi", delay=65)
        except Exception:
            pass

        await page.evaluate(
            """() => {
              const vis = (el) => {
                if (!el) return false;
                const r = el.getBoundingClientRect();
                return r.width > 20 && r.height > 12;
              };
              const el = [
                ...document.querySelectorAll('[data-testid="chat_input"] [contenteditable="true"], div.ProseMirror[contenteditable="true"], textarea[data-testid="chat_input"], textarea, [contenteditable="true"]')
              ].filter(vis)[0];
              if (!el) return;
              const cur = (el.isContentEditable ? el.textContent : el.value) || '';
              if (cur.trim().toLowerCase() === 'hi') return;
              try { el.focus(); } catch (e) {}
              if (el.isContentEditable) {
                el.textContent = 'hi';
                try {
                  el.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'hi', inputType: 'insertText' }));
                } catch (e) {
                  el.dispatchEvent(new Event('input', { bubbles: true }));
                }
              } else {
                const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
                if (desc && desc.set) desc.set.call(el, 'hi'); else el.value = 'hi';
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
              }
            }"""
        )
        await asyncio.sleep(0.25)

        # Click send button or press Enter
        clicked_send = await page.evaluate(
            """() => {
              const vis = (el) => {
                try { const r = el.getBoundingClientRect(); return r.width > 8 && r.height > 8; }
                catch (e) { return false; }
              };
              const btns = [...document.querySelectorAll('button, [role="button"]')].filter(vis);
              const sendBtns = btns.filter((b) => {
                const t = ((b.getAttribute('aria-label') || '') + ' ' + (b.innerText || '') + ' ' + (b.getAttribute('data-testid') || '')).toLowerCase();
                return t.includes('send') || t.includes('submit') || t.includes('gui') || t.includes('gửi');
              }).filter((b) => !b.disabled && b.getAttribute('aria-disabled') !== 'true');
              if (!sendBtns.length) return false;
              const b = sendBtns[sendBtns.length - 1];
              try { b.click(); } catch (e) {}
              return true;
            }"""
        )
        if not clicked_send:
            try:
                await page.keyboard.press("Enter")
            except Exception:
                pass

        # Wait up to 5.5s for Dola to create the conversation and start replying
        for _ in range(11):
            await asyncio.sleep(0.5)
            state = await page.evaluate(
                """(beforeLen) => {
                  const t = (document.body && document.body.innerText) || '';
                  const hasConvUrl = /\\/chat\\/\\d{6,}/.test(location.pathname);
                  return { grown: t.length > beforeLen + 12, hasConvUrl };
                }""",
                before_len,
            )
            if isinstance(state, dict) and (state.get("grown") or state.get("hasConvUrl")):
                break

        try:
            marker.write_text(str(int(time.time())), encoding="utf-8")
        except Exception:
            pass
        return True
    except Exception:
        return False


async def capture_and_persist_session(
    context,
    account_dir: Path,
    sniffed: List[str],
    wait_mstoken_sec: float = 8.0,
) -> Dict[str, Any]:
    """Waits for msToken, pins all Dola cookies, persists cookies.json, and returns session snapshot."""
    deadline = time.monotonic() + wait_mstoken_sec
    reloaded_for_tokens = False
    while time.monotonic() < deadline:
        try:
            cks = await context.cookies("https://www.dola.com")
            if cookie_value(cks, "msToken") and cookie_value(cks, "s_v_web_id"):
                break
            # Match dola-render-gateway harvestDolaSession: reload /chat once if msToken or s_v_web_id is missing
            if not reloaded_for_tokens and time.monotonic() + (wait_mstoken_sec * 0.5) >= deadline:
                reloaded_for_tokens = True
                for p in context.pages:
                    if _is_dola_url(p.url):
                        try:
                            await p.goto("https://www.dola.com/chat", timeout=20000, wait_until="domcontentloaded")
                        except Exception:
                            pass
                        break
        except Exception:
            pass
        await asyncio.sleep(0.5)

    pinned = await pin_session_cookies(context)
    live = await context.cookies("https://www.dola.com")
    ms_tok = cookie_value(live, "msToken")
    if not ms_tok:
        ms_tok = (sniffed[-1] if sniffed else "") or await _page_mstoken(context)
        if ms_tok:
            ms_cookie = {
                "name": "msToken",
                "value": ms_tok,
                "domain": ".dola.com",
                "path": "/",
                "secure": True,
                "httpOnly": False,
                "sameSite": "Lax",
                "expires": _FAR_FUTURE,
            }
            live = [c for c in live if c.get("name") != "msToken"] + [ms_cookie]
            try:
                await context.add_cookies([ms_cookie])
            except Exception:
                pass

    web_id = cookie_value(live, "_web_id") or await _page_web_id(context)
    if web_id and not cookie_value(live, "_web_id"):
        wid_cookie = {
            "name": "_web_id",
            "value": web_id,
            "domain": ".dola.com",
            "path": "/",
            "secure": True,
            "httpOnly": False,
            "sameSite": "Lax",
            "expires": _FAR_FUTURE,
        }
        live.append(wid_cookie)
        try:
            await context.add_cookies([wid_cookie])
        except Exception:
            pass

    # Save cookies.json in account_dir for future CloakBrowser launches
    try:
        account_dir.mkdir(parents=True, exist_ok=True)
        out_file = account_dir / "cookies.json"
        out_file.write_text(json.dumps(live, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception:
        pass

    cookie_header = "; ".join(
        f"{c['name']}={c['value']}"
        for c in live
        if isinstance(c, dict) and c.get("name") and c.get("value")
    )

    fb_cookie_header = ""
    try:
        fb_live = await context.cookies("https://www.facebook.com")
        if cookie_value(fb_live, "c_user") and cookie_value(fb_live, "xs"):
            fb_cookie_header = "; ".join(
                f"{c['name']}={c['value']}"
                for c in fb_live
                if isinstance(c, dict) and c.get("name") and c.get("value")
            )
    except Exception:
        pass

    return {
        "cookies": live,
        "cookieHeader": cookie_header,
        "fbCookieHeader": fb_cookie_header,
        "sessionId": cookie_value(live, "sessionid") or cookie_value(live, "sid_guard"),
        "msToken": ms_tok,
        "webId": web_id,
    }


async def _confirm_age_gate(page) -> bool:
    try:
        ok = await page.evaluate(
            r"""() => {
            const body = (document.body ? document.body.innerText : '');
            for (const sel of document.querySelectorAll('select')) {
              const opt1996 = Array.from(sel.options || []).find(o => o.value === '1996' || (o.textContent || '').trim() === '1996');
              if (opt1996 && sel.value !== opt1996.value) {
                sel.value = opt1996.value;
                sel.dispatchEvent(new Event('change', { bubbles: true }));
              }
            }
            const isAge = /18|age|年齢|độ tuổi|đủ tuổi|tuổi/i.test(body)
                && /confirm|xác nhận|đồng ý|同意|agree|older|over|trở lên|至少|以上/i.test(body);
            if (!isAge) return false;
            for (const cb of document.querySelectorAll('input[type="checkbox"]')) {
                if (!cb.checked) { try { cb.click(); } catch (e) {} }
            }
            const YES = /^(ok|đồng ý|xác nhận|同意する|同意|accept|confirm|agree|continue|tiếp tục|続行|はい|có|tôi đủ 18|i am 18|i'?m 18|18\+)$/i;
            const els = [...document.querySelectorAll('button, [role="button"], a, span, div')];
            const t = els.find(e => {
                const txt = (e.textContent || '').trim();
                if (/google|facebook|apple|không|no\b/i.test(txt)) return false;
                return txt.length <= 24 && YES.test(txt) && e.childElementCount === 0 && e.offsetParent !== null;
            });
            if (t) {
                try {
                  fetch('/alice/age_gate/report?aid=495671&device_platform=web', {
                    method: 'POST',
                    credentials: 'include',
                    headers: { 'Content-Type': 'application/json', 'agw-js-conv': 'str' },
                    body: JSON.stringify({ scene: 1, pass: true })
                  }).catch(() => {});
                } catch (e) {}
                t.click();
                return true;
            }
            return false;
        }"""
        )
        if ok:
            await page.wait_for_timeout(1000)
            return True
    except Exception:
        pass
    return False


async def _click_fb_icon(page) -> bool:
    try:
        xy = await page.evaluate(_FB_ICON_XY_JS)
    except Exception:
        return False
    if not xy or not xy.get("x") or not xy.get("y"):
        return False
    try:
        await page.mouse.click(float(xy["x"]), float(xy["y"]))
        return True
    except Exception:
        return False


async def _keep_single_popup(ctx, page, popup):
    """Close every tab except the Dola page and one OAuth popup; returns the popup kept (or None).

    Re-clicking the FB icon on a slow proxy opens a second popup that used to stay open for the whole wait.
    """
    if popup is not None and popup.is_closed():
        popup = None
    for extra in list(ctx.pages):
        if extra is page or extra is popup:
            continue
        try:
            if extra.is_closed():
                continue
            if popup is None and "work.meta.com" not in (extra.url or "").lower():
                popup = extra
                continue
            await extra.close()
        except Exception:
            pass
    return popup


async def _click_continue_fb(popup, timeout: int = 3500) -> bool:
    try:
        p_url = (popup.url or "").lower()
    except Exception:
        return False

    # NEVER click 'Continue' or any link when on Facebook login.php, checkpoint, recover, or work.meta.com!
    if any(x in p_url for x in ("login.php", "/login", "/checkpoint", "/recover", "work.meta.com")):
        return False

    # 1. In-Page Sahara Comet GraphQL Auto-Approval + strict OAuth Consent button detector
    try:
        xy = await popup.evaluate(
            r"""() => {
              const vis = (e) => {
                if (!e) return false;
                const r = e.getBoundingClientRect();
                return r.width > 4 && r.height > 4 && getComputedStyle(e).visibility !== 'hidden' && getComputedStyle(e).display !== 'none';
              };

              // If login password input is visible, this is a login form — never click random buttons
              const passInp = document.querySelector('#pass, input[name="pass"], input#m_login_password, input[type="password"]');
              if (vis(passInp)) return { state: 'login_form' };

              // Sahara Comet GraphQL Auto-Approval (approves OAuth consent natively inside facebook.com)
              try {
                if (!window.__viraSaharaApproved && document.documentElement) {
                  const html = document.documentElement.innerHTML || '';
                  const dtsg = /"DTSGInitialData",\[\],\{"token":"([^"]+)"/.exec(html)?.[1];
                  const lsd = /"LSD",\[\],\{"token":"([^"]+)"/.exec(html)?.[1];
                  const expId = /"experience_id":"([0-9a-f-]{36})"/.exec(html)?.[1];
                  const cUserMatch = /c_user=(\d+)/.exec(document.cookie || '')?.[1] || /"USER_ID":"(\d+)"/.exec(html)?.[1];
                  if (dtsg && lsd && expId && cUserMatch) {
                    window.__viraSaharaApproved = true;
                    const rev = /"__spin_r":(\d+)/.exec(html)?.[1] || '';
                    const hsi = /"hsi":"(\d+)"/.exec(html)?.[1] || '';
                    const hs = /"haste_session":"([^"]+)"/.exec(html)?.[1] || '';
                    const spinT = /"__spin_t":(\d+)/.exec(html)?.[1] || String(Math.floor(Date.now() / 1000));
                    const pMatch = /"initial_prompt":\{"prompt":"([A-Z0-9_]+)","input_default_values_json":"((?:\\.|[^"])+)"/.exec(html);
                    const promptName = pMatch?.[1] || 'GDP_READ';
                    let inputsJson = JSON.stringify({ public_profile: 'true', baseline: 'true', gdp_error_custom_component_input: '' });
                    if (pMatch?.[2]) {
                      try { inputsJson = JSON.parse('"' + pMatch[2] + '"'); } catch (e) {}
                    }
                    const flowName = /"flow":"([A-Z0-9_]+)","__typename":"ConsentAPIPresentPromptAction"/.exec(html)?.[1] || 'GDP';
                    let extraParamsJson = null;
                    for (const m of html.matchAll(/"extra_params_json":"((?:\\.|[^"])+)"/g)) {
                      if (m[1] && m[1].includes('__aectx__')) {
                        try { extraParamsJson = JSON.parse('"' + m[1] + '"'); break; } catch (e) {}
                      }
                    }
                    if (!extraParamsJson) {
                      const qMap = {};
                      const usp = new URLSearchParams(location.search);
                      usp.forEach((v, k) => {
                        const pm = /^params\[(.+)\]$/.exec(k);
                        if (pm && pm[1]) qMap[pm[1]] = v;
                      });
                      qMap['__aectx__'] = JSON.stringify({
                        id: expId,
                        flows: [{ id: flowName.toLowerCase(), prompts: [{ id: promptName.toLowerCase() }] }]
                      });
                      extraParamsJson = JSON.stringify(qMap);
                    }
                    let sum = 0;
                    for (let i = 0; i < dtsg.length; i++) sum += dtsg.charCodeAt(i);
                    const jazoest = '2' + sum;
                    const mkInput = (mutId) => ({
                      actor_id: cUserMatch,
                      client_mutation_id: mutId,
                      device_id: null,
                      experience_id: expId,
                      extra_params_json: extraParamsJson,
                      flow: flowName,
                      inputs_json: inputsJson,
                      outcome: 'APPROVED',
                      outcome_data_json: '{}',
                      prompt: promptName,
                      runtime: 'SAHARA',
                      source: 'gdp_delegated',
                      surface: 'FACEBOOK_COMET'
                    });
                    const postGql = async (docId, mutId, seq, fnName) => {
                      const body = new URLSearchParams({
                        av: cUserMatch, __user: cUserMatch, __a: '1', __req: seq, __hs: hs, dpr: '1',
                        __ccg: 'EXCELLENT', __rev: rev, __s: '', __hsi: hsi, __comet_req: '1',
                        fb_dtsg: dtsg, jazoest, lsd, __spin_r: rev, __spin_b: 'trunk', __spin_t: spinT,
                        fb_api_caller_class: 'RelayModern', fb_api_req_friendly_name: fnName,
                        variables: JSON.stringify({ input: mkInput(mutId) }),
                        server_timestamps: 'true', doc_id: docId
                      });
                      const r = await fetch('/api/graphql/', {
                        method: 'POST',
                        credentials: 'include',
                        headers: {
                          'Content-Type': 'application/x-www-form-urlencoded',
                          'x-asbd-id': '359341',
                          'x-fb-friendly-name': fnName,
                          'x-fb-lsd': lsd
                        },
                        body: body.toString()
                      });
                      let txt = await r.text();
                      if (txt.startsWith('for (;;);')) txt = txt.slice(9);
                      return JSON.parse(txt);
                    };
                    (async () => {
                      try {
                        await postGql('27663635456672773', '3', '4', 'useSaharaCometConsentPromptValidationServerMutation');
                        const out = await postGql('9822638027828705', '4', '5', 'useSaharaCometConsentPostPromptOutcomeServerMutation');
                        const uri = out?.data?.post_prompt_outcome?.finish_flow_action?.link_uri?.uri;
                        if (uri) window.location.href = uri;
                      } catch (e) {}
                    })();
                  }
                }
              } catch (e) {}

              const isBlue = (bg) => {
                const m = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(bg || '');
                if (!m) return false;
                const r = Number(m[1]), g = Number(m[2]), b = Number(m[3]);
                return b >= 135 && b > r + 40 && b > g + 12;
              };
              const isCancel = (txt) => /cancel|huỷ|hủy|إلغاء|عرض صلاحية|edit|chỉnh sửa|switch|đổi|not now|lúc khác|取消|workplace|meta/i.test(txt || '');

              // Only match real buttons (NEVER <a> links with external href like work.meta.com)
              const btns = [...document.querySelectorAll('button[name="__CONFIRM__"], #platformDialogForm button[type="submit"], div[role="button"], button, input[type="submit"]')]
                .filter(vis)
                .filter(e => {
                  const a = e.closest('a');
                  if (a && a.href && /work\.meta\.com|meta\.com|instagram\.com|threads\.net/i.test(a.href)) return false;
                  return true;
                })
                .map(e => {
                  const r = e.getBoundingClientRect();
                  const t = ((e.innerText || e.value || e.getAttribute('aria-label') || '') + '').replace(/\s+/g, ' ').trim();
                  const bg = getComputedStyle(e).backgroundColor || '';
                  const hasBlue = isBlue(bg) || [...e.querySelectorAll('div, span')].some(d => isBlue(getComputedStyle(d).backgroundColor || ''));
                  return { e, r, t, hasBlue };
                })
                .filter(o => !isCancel(o.t));

              const textMatch = btns.filter(o =>
                o.t.length > 0 &&
                o.t.length < 90 &&
                o.r.width >= 80 &&
                o.r.height >= 26 &&
                (/^(continue|tiếp tục|reconnect|kết nối lại|confirm|xác nhận|đồng ý|allow|cho phép|続行|继续|确认|متابعة)/i.test(o.t) ||
                 /continue as|tiếp tục dưới tên|tiếp tục với tư cách|متابعة باسم/i.test(o.t))
              );
              if (textMatch.length > 0) {
                textMatch.sort((a, b) => (Number(b.hasBlue) - Number(a.hasBlue)) || (b.r.width - a.r.width));
                const pick = textMatch[0];
                try { pick.e.click(); } catch (e) {}
                return { x: pick.r.left + pick.r.width / 2, y: pick.r.top + pick.r.height / 2 };
              }

              if (/\/dialog\/oauth|\/oidc\/|\/login\/oauth|\/privacy\/consent/i.test(location.pathname)) {
                const pick = btns.find(o => o.hasBlue && o.r.width >= 140 && o.r.height >= 28 && o.r.top >= 100);
                if (pick) {
                  try { pick.e.click(); } catch (e) {}
                  return { x: pick.r.left + pick.r.width / 2, y: pick.r.top + pick.r.height / 2 };
                }
              }
              return null;
            }"""
        )
        if isinstance(xy, dict) and xy.get("x") and xy.get("y"):
            await popup.mouse.click(float(xy["x"]), float(xy["y"]))
            return True
    except Exception:
        pass
    return False


async def _warm_facebook_session(page, timeout: int = 15000) -> str:
    try:
        await page.goto("https://m.facebook.com", timeout=timeout, wait_until="domcontentloaded")
        await page.wait_for_timeout(2200)
    except Exception:
        try:
            await page.goto("https://www.facebook.com", timeout=timeout, wait_until="domcontentloaded")
            await page.wait_for_timeout(2200)
        except Exception:
            return "ok"

    curr_url = page.url.lower()
    text = ""
    try:
        text = (await page.evaluate("() => (document.body ? document.body.innerText : '').slice(0, 600)")).lower()
    except Exception:
        pass

    if "828281030927956" in curr_url or "828281030927956" in text:
        return "checkpoint_956"
    if "1501092823525282" in curr_url or "1501092823525282" in text:
        return "checkpoint_282"
    if "/checkpoint/" in curr_url or "checkpoint" in curr_url:
        return "checkpoint"
    if any(
        sig in text
        for sig in (
            "confirm you're human",
            "confirm your identity",
            "xác nhận danh tính",
            "we've detected unusual",
            "locked your account",
            "unlock it",
            "may have been hacked",
            "tài khoản đã bị khoá",
            "xác nhận đây là tài khoản",
        )
    ):
        return "checkpoint"
    if "/login" in curr_url or "login.php" in curr_url:
        return "login"
    return "ok"


def _fill_login_js(uid: str, password: str) -> str:
    return """(() => {
  const UID = %s;
  const PASS = %s;
  const setVal = (el, val) => {
    try {
      const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
      if (desc && desc.set) desc.set.call(el, val); else el.value = val;
    } catch (e) { el.value = val; }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const email = document.querySelector('input[name="email"], input#email, input[name="username"], input#m_login_email, input[type="email"]');
  const pass = document.querySelector('input[name="pass"], input#pass, input#m_login_password, input[type="password"]');
  if (!email || !pass) return { ok: false, why: 'no-form' };
  const body = ((document.body && document.body.innerText) || '').toLowerCase();
  if (email.value === UID &&
      /(password.{0,20}(incorrect|wrong)|incorrect.{0,20}password|wrong password|mật khẩu.{0,20}(sai|không đúng)|sai mật khẩu|couldn't find your account|không tìm thấy tài khoản)/i.test(body)) {
    return { ok: false, why: 'sai-mat-khau' };
  }
  if (email.value !== UID) setVal(email, UID);
  if (!pass.value) setVal(pass, PASS);
  const btn = document.querySelector('button[name="login"], #loginbutton, button[data-testid="royal_login_button"], button[type="submit"], input[type="submit"]')
    || [...document.querySelectorAll('button, [role="button"]')].find((b) => {
      const t = ((b.innerText || b.value || '') + '').replace(/\\s+/g, ' ').trim();
      return /^(log in|đăng nhập|anmelden|iniciar sesión|se connecter|masuk|entrar)$/i.test(t);
    });
  if (email.value && pass.value && btn) {
    const t = btn.closest('button, a, [role="button"]') || btn;
    try { t.click(); } catch (e) {}
    try { t.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window })); } catch (e2) {}
    return { ok: true, why: 'submit' };
  }
  return { ok: false, why: 'cho-nut' };
})()""" % (json.dumps(str(uid)), json.dumps(str(password)))


def _fill_2fa_js(code: str) -> str:
    return """(() => {
  const MA = %s;
  const setVal = (el, val) => {
    try {
      const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
      if (desc && desc.set) desc.set.call(el, val); else el.value = val;
    } catch (e) { el.value = val; }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const field = document.querySelector('input[name="approvals_code"], input#approvals_code, input[autocomplete="one-time-code"], input[name="code"], input[inputmode="numeric"], input[type="tel"]');
  if (!field) return { ok: false, why: 'no-2fa-field' };
  if (field.value !== MA) setVal(field, MA);
  const btn = document.querySelector('button[name="submit[Continue]"], #checkpointSubmitButton, button[name="submit[Submit Code]"], button[type="submit"]')
    || [...document.querySelectorAll('button, [role="button"]')].find((b) => {
      const t = ((b.innerText || b.value || '') + '').replace(/\\s+/g, ' ').trim();
      return /^(continue|tiếp tục|続行|submit|gửi|xác nhận|confirm)$/i.test(t);
    });
  if (btn) {
    const t = btn.closest('button, a, [role="button"]') || btn;
    try { t.click(); } catch (e) {}
    try { t.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window })); } catch (e2) {}
    return { ok: true, why: 'submit' };
  }
  return { ok: false, why: 'cho-nut' };
})()""" % json.dumps(str(code))


async def _fb_autofill_login(
    page,
    uid: str,
    password: str,
    totp_secret: str,
    timeout: int = 55,
) -> str:
    if not (uid and password):
        return "no-creds"

    emit_step("[CloakBrowser] Cookie Facebook hết hạn — đang tự điền UID + Mật khẩu + 2FA…")
    deadline = time.monotonic() + timeout
    two_fa_done = False
    while time.monotonic() < deadline:
        url = page.url.lower()
        text = ""
        try:
            text = (await page.evaluate("() => (document.body ? document.body.innerText : '').slice(0, 500)")).lower()
        except Exception:
            pass

        if any(
            sig in text
            for sig in (
                "confirm you're human",
                "confirm your identity",
                "xác nhận danh tính",
                "we've detected unusual",
            )
        ):
            return "checkpoint"

        try:
            fb_cookies = await page.context.cookies("https://www.facebook.com")
        except Exception:
            fb_cookies = []
        if cookie_value(fb_cookies, "c_user") and not any(x in url for x in ("/login", "login.php", "/checkpoint")):
            emit_step("[CloakBrowser] Đăng nhập lại Facebook thành công (tự điền).")
            return "ok"

        needs_2fa = (
            "two_factor" in url
            or "/checkpoint" in url
            or "approvals_code" in text
            or any(k in text for k in ("login code", "mã đăng nhập", "two-factor", "xác thực hai"))
        )
        if needs_2fa and not two_fa_done:
            if not totp_secret:
                return "checkpoint"
            code = totp_code(totp_secret)
            if code:
                try:
                    res = await page.evaluate(_fill_2fa_js(code))
                except Exception:
                    res = None
                if isinstance(res, dict) and res.get("ok"):
                    emit_step("[CloakBrowser] Đã nhập mã 2FA Facebook.")
                    two_fa_done = True
                    await page.wait_for_timeout(3500)
                    continue

        await _click_continue_fb(page, timeout=1500)

        try:
            res = await page.evaluate(_fill_login_js(uid, password))
        except Exception:
            res = None
        if isinstance(res, dict) and res.get("why") == "sai-mat-khau":
            return "sai-mat-khau"
        await page.wait_for_timeout(3000)

    return "timeout"


async def launch_cloak_context(
    p,
    account_key: str,
    account_dir: Path,
    headless: bool,
    proxy_raw: Optional[str],
    ext_dir: Optional[str],
    timezone: str = "Asia/Ho_Chi_Minh",
    locale: str = "vi-VN",
):
    cloak_dir = account_dir / "cloak"
    cloak_dir.mkdir(parents=True, exist_ok=True)
    await asyncio.to_thread(assert_profile_free, cloak_dir)

    exe = await asyncio.to_thread(resolve_cloak_binary)
    seed = compute_cloak_seed(account_key)
    plat = "macos" if sys.platform == "darwin" else "windows"

    args = [
        *LAUNCH_ARGS,
        f"--fingerprint={seed}",
        f"--fingerprint-platform={plat}",
        f"--fingerprint-timezone={timezone}",
    ]
    if ext_dir and Path(ext_dir).is_dir():
        args.append("--enable-unsafe-extension-debugging")

    kwargs: Dict[str, Any] = {
        "executable_path": exe,
        "headless": headless,
        "args": args,
        "locale": locale,
        "chromium_sandbox": True,
        "ignore_default_args": ["--no-sandbox"],
    }
    if not headless:
        kwargs["no_viewport"] = True

    proxy_cfg = parse_proxy_string(proxy_raw)
    if proxy_cfg:
        proxy_cfg = await asyncio.to_thread(to_local_relay_proxy, proxy_cfg)
        kwargs["proxy"] = proxy_cfg

    context = await p.chromium.launch_persistent_context(str(cloak_dir), **kwargs)
    await load_logout_guard_extension(context, ext_dir)
    if not (proxy_cfg or {}).get("username"):
        await block_dola_logout(context)
    await context.add_init_script(_THIRTYSEC_HIJACK_JS)
    return context


async def check_and_use_existing_dola_session(
    ctx,
    page,
    account_dir: Path,
    sniffed: List[str],
    dead_sid: str,
) -> Tuple[bool, str, Dict[str, Any]]:
    live = await ctx.cookies("https://www.dola.com")
    sid = cookie_value(live, "sessionid") or cookie_value(live, "sid_guard")
    if not sid or sid == dead_sid:
        return False, dead_sid, {}

    emit_step("[CloakBrowser] Phát hiện cookie phiên Dola — đang xác thực với Passport & Alice…")
    probe = await probe_dola_identity_in_page(page)
    if probe.get("ok") and not probe.get("isGuest"):
        await send_initial_greeting_hi(page, account_dir)
        snap = await capture_and_persist_session(ctx, account_dir, sniffed, wait_mstoken_sec=6.0)
        return True, dead_sid, {**snap, "userId": probe.get("userId", ""), "screenName": probe.get("screenName", "")}

    if probe.get("isGuest"):
        try:
            (account_dir / "greeted_hi.txt").unlink(missing_ok=True)
        except Exception:
            pass
        emit_step("[CloakBrowser] Phiên cũ trong profile đã hết hạn — tiến hành đăng nhập mới qua Facebook…")
        return False, sid, {}

    # Wait 3s and retry once in case Dola OAuth session sync is slightly delayed
    await asyncio.sleep(2.5)
    probe2 = await probe_dola_identity_in_page(page)
    if probe2.get("ok") and not probe2.get("isGuest"):
        await send_initial_greeting_hi(page, account_dir)
        snap = await capture_and_persist_session(ctx, account_dir, sniffed, wait_mstoken_sec=6.0)
        return True, dead_sid, {**snap, "userId": probe2.get("userId", ""), "screenName": probe2.get("screenName", "")}

    return False, sid, {}


async def run_fb_login_flow(cfg: Dict[str, Any]) -> Dict[str, Any]:
    account_key = str(cfg.get("accountKey") or cfg.get("accountId") or "default")
    account_dir = Path(cfg["accountDir"])
    fb_cookie = str(cfg.get("fbCookie") or "").strip()
    dola_cookie = str(cfg.get("dolaCookie") or "").strip()
    fb_uid = str(cfg.get("fbUid") or "")
    proxy_raw = cfg.get("proxyUrl")
    visible = bool(cfg.get("visible", False))
    ext_dir = cfg.get("logoutGuardDir")
    base_url = str(cfg.get("baseUrl") or "https://www.dola.com").rstrip("/")
    timeout_sec = int(cfg.get("timeoutSec") or 75)

    if not fb_cookie and not dola_cookie and not (account_dir / "cookies.json").exists():
        return {
            "ok": False,
            "status": "expired",
            "errorCode": "FB_COOKIE_EXPIRED",
            "message": "Tài khoản chưa có Cookie (chỉ hỗ trợ đăng nhập bằng Cookie, không dùng tài khoản/mật khẩu).",
        }

    async with async_playwright() as p:
        emit_step(f"[CloakBrowser] Đang khởi chạy nhân CloakBrowser C++ (seed={compute_cloak_seed(account_key)})…")
        ctx = await launch_cloak_context(
            p=p,
            account_key=account_key,
            account_dir=account_dir,
            headless=not visible,
            proxy_raw=proxy_raw,
            ext_dir=ext_dir,
        )
        sniffed = watch_mstoken(ctx)
        try:
            await restore_dola_cookies_if_needed(ctx, account_dir, dola_cookie)
            if fb_cookie:
                emit_step("[CloakBrowser] Đang nạp Cookie Facebook vào CloakBrowser…")
                await inject_facebook_cookies(ctx, fb_cookie)

            page = ctx.pages[0] if ctx.pages else await ctx.new_page()
            # The persistent profile can restore tabs from the previous run; they'd be mistaken for the OAuth popup.
            for stale in list(ctx.pages[1:]):
                try:
                    await stale.close()
                except Exception:
                    pass

            # 1. Open Dola /chat DIRECTLY (matching dola-render-gateway desktop/main.js lines 838-846:
            #    NEVER open m.facebook.com/www.facebook.com beforehand as that triggers FB Checkpoint 956!)
            emit_step("[CloakBrowser] Đang vào thẳng Dola (/chat) trên nhân CloakBrowser…")
            await force_ui_language(ctx, "en")
            await page.goto(f"{base_url}/chat", timeout=60000, wait_until="domcontentloaded")

            dead_sid = ""
            # Wait up to 4.5s for automatic SSO or pre-existing sessionid
            deadline_sso = time.monotonic() + 4.5
            while time.monotonic() < deadline_sso:
                live_cks = await ctx.cookies("https://www.dola.com")
                if cookie_value(live_cks, "sessionid"):
                    break
                await asyncio.sleep(0.5)

            ok_exist, dead_sid, snap_exist = await check_and_use_existing_dola_session(
                ctx, page, account_dir, sniffed, dead_sid
            )
            if ok_exist:
                return {
                    "ok": True,
                    "status": "ready",
                    "message": f"Phiên Dola đang hoạt động ({snap_exist.get('screenName') or fb_uid})!",
                    **snap_exist,
                }

            await _confirm_age_gate(page)

            # Dismiss cookie consent banner if visible
            for label in ("OK", "Đồng ý", "同意する", "Accept"):
                try:
                    btn = page.get_by_text(label, exact=True).first
                    if await btn.count() and await btn.is_visible():
                        await btn.click(timeout=1500)
                        await page.wait_for_timeout(300)
                        break
                except Exception:
                    pass

            # 2. Open login modal on Dola if not already open
            modal_open = False
            try:
                modal = page.locator(".semi-modal-wrap, [role='dialog']").first
                if await modal.count() and await modal.is_visible():
                    modal_open = True
            except Exception:
                pass

            if not modal_open:
                emit_step("[CloakBrowser] Đang mở hộp thoại đăng nhập trực tiếp trên Dola…")
                for sel in (
                    "[data-testid='to_login_button']",
                    "button:has-text('Log in')",
                    "button:has-text('Đăng nhập')",
                    "button:has-text('ログイン')",
                    "button:has-text('Sign in')",
                    "text=Log in",
                    "text=Đăng nhập",
                    "header button",
                    "header [role='button']",
                ):
                    try:
                        b = page.locator(sel).first
                        if await b.count() and await b.is_visible():
                            try:
                                await b.click(timeout=3500)
                            except Exception:
                                await b.evaluate("e => e.click()")
                            await page.wait_for_timeout(1200)
                            modal = page.locator(".semi-modal-wrap, [role='dialog']").first
                            if await modal.count() and await modal.is_visible():
                                modal_open = True
                                break
                    except Exception:
                        continue

            # Fallback from dola-render-gateway (JS_TRIGGER_BY_SEND): if Guest mode hides header Login button,
            # type 'hi' in chat composer and click send to force Dola's login modal to pop up!
            if not modal_open:
                try:
                    triggered = await page.evaluate(
                        """() => {
                          const ed = document.querySelector('[contenteditable="true"], textarea');
                          if (!ed) return false;
                          ed.focus();
                          document.execCommand('selectAll', false, null);
                          document.execCommand('insertText', false, 'hi');
                          ed.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'hi' }));
                          const send = document.querySelector('[data-testid*="send" i], button[type="submit"]')
                            || [...document.querySelectorAll('button')].find(b => b.querySelector('svg') && !b.disabled && b.offsetParent !== null);
                          if (send) send.click();
                          return true;
                        }"""
                    )
                    if triggered:
                        await page.wait_for_timeout(1500)
                except Exception:
                    pass

            # 3. Click Facebook OAuth icon inside modal using real mouse coordinates
            emit_step("[CloakBrowser] Đang bấm biểu tượng Facebook OAuth trên Dola…")
            clicked_fb = False
            for _ in range(8):
                ok_exist, dead_sid, snap_exist = await check_and_use_existing_dola_session(
                    ctx, page, account_dir, sniffed, dead_sid
                )
                if ok_exist:
                    return {
                        "ok": True,
                        "status": "ready",
                        "message": f"Đăng nhập Dola bằng CloakBrowser thành công ({snap_exist.get('screenName') or fb_uid})!",
                        **snap_exist,
                    }

                await _confirm_age_gate(page)
                clicked_fb = await _click_fb_icon(page)
                if clicked_fb:
                    break

                for sel in (
                    "[aria-label*='facebook' i]",
                    "[title*='facebook' i]",
                    "svg.facebook-icon",
                    "svg[data-icon='facebook']",
                    "button:has-text('Facebook')",
                    "[role='button']:has-text('Facebook')",
                    "svg:has(path[fill*='0068FF' i])",
                    "svg:has(path[fill*='1877F2' i])",
                ):
                    try:
                        loc = page.locator(sel).first
                        if await loc.count() and await loc.is_visible():
                            await loc.click(timeout=2500)
                            clicked_fb = True
                            break
                    except Exception:
                        continue
                if clicked_fb:
                    break
                await page.wait_for_timeout(900)

            login_codes: List[int] = []

            async def _on_resp(resp):
                try:
                    if "login_only" in resp.url or "/auth/login" in resp.url:
                        data = await resp.json()
                        code = int(data.get("error_code") or data.get("code") or (data.get("data") or {}).get("error_code") or 0)
                        login_codes.append(code)
                        # If login_only returned need_age_gate / profile_key, confirm age gate immediately
                        d = data.get("data") or {}
                        if d.get("need_age_gate") or d.get("profile_key"):
                            asyncio.create_task(_confirm_age_gate(page))
                except Exception:
                    pass

            page.on("response", _on_resp)

            # 4. Wait for Facebook OAuth popup opened by Dola
            popup = None
            for w in range(15):
                await page.wait_for_timeout(900)
                popup = await _keep_single_popup(ctx, page, None)
                if popup:
                    break
                if w == 7:
                    await _click_fb_icon(page)

            if popup:
                emit_step("[CloakBrowser] Đang xác nhận OAuth trên popup Dola…")
                try:
                    await popup.wait_for_load_state("domcontentloaded", timeout=15000)
                    await popup.wait_for_timeout(1800)
                except Exception:
                    pass

                p_url = popup.url.lower()
                ptxt = ""
                try:
                    ptxt = (await popup.evaluate("() => (document.body ? document.body.innerText : '').slice(0, 600)")).lower()
                except Exception:
                    pass

                if "828281030927956" in p_url or any(
                    k in ptxt for k in ("your account has been locked", "your account was locked", "tài khoản của bạn đã bị khóa")
                ):
                    return {
                        "ok": False,
                        "status": "error",
                        "message": "Nick FB bị khóa Checkpoint 956 — hãy dùng Cookie Dola trực tiếp hoặc đổi nick khác.",
                    }
                if "1501092823525282" in p_url or any(
                    k in ptxt for k in ("we suspended your account", "chúng tôi đã đình chỉ tài khoản")
                ):
                    return {
                        "ok": False,
                        "status": "error",
                        "message": "Nick FB bị đình chỉ Checkpoint 282 — hãy đổi nick khác.",
                    }

                if "login.php" in p_url or "/login" in p_url:
                    try:
                        await popup.close()
                    except Exception:
                        pass
                    return {
                        "ok": False,
                        "status": "expired",
                        "errorCode": "FB_COOKIE_EXPIRED",
                        "message": "Cookie Facebook đã hết hạn (bị đá ra trang đăng nhập) — chỉ đăng nhập bằng Cookie, không điền tài khoản/mật khẩu.",
                    }

                try:
                    p_url = popup.url.lower()
                    ptxt = (await popup.evaluate("() => (document.body ? document.body.innerText : '').slice(0, 600)")).lower()
                except Exception:
                    pass

                if (
                    "/checkpoint/" in p_url
                    or "two_step_verification" in p_url
                    or "828281030927956" in p_url
                    or any(
                        x in ptxt
                        for x in (
                            "confirm you're human",
                            "confirm your identity",
                            "xác nhận danh tính",
                            "your account has been locked",
                            "your account was locked",
                            "tài khoản của bạn đã bị khóa",
                            "invalid request",
                        )
                    )
                ):
                    if not visible:
                        return {
                            "ok": False,
                            "status": "error",
                            "message": "Nick FB bị Checkpoint / Khóa thiết bị (956) — hãy bấm 🌐 để đăng nhập trực tiếp trên Dola hoặc nạp Cookie Dola.",
                        }

                for _ in range(5):
                    if popup.is_closed():
                        break
                    await _click_continue_fb(popup, timeout=3500)
                    await popup.wait_for_timeout(1800)

            await _confirm_age_gate(page)

            # 6. Wait for Dola sessionid & verify with Passport / self_brief
            emit_step("[CloakBrowser] Đang chờ Dola cấp phiên (sessionid & msToken)…")
            deadline = time.monotonic() + timeout_sec
            while time.monotonic() < deadline:
                await page.wait_for_timeout(1800)

                popup = await _keep_single_popup(ctx, page, popup)

                if popup and not popup.is_closed():
                    if "/checkpoint/" in popup.url.lower() and not visible:
                        return {
                            "ok": False,
                            "status": "error",
                            "message": "Tài khoản Facebook bị Checkpoint xác minh danh tính.",
                        }
                    await _click_continue_fb(popup, timeout=2000)

                await _confirm_age_gate(page)

                live = await ctx.cookies("https://www.dola.com")
                sid = cookie_value(live, "sessionid") or cookie_value(live, "sid_guard")
                if sid and sid != dead_sid:
                    ok_now, dead_sid, snap = await check_and_use_existing_dola_session(
                        ctx, page, account_dir, sniffed, dead_sid
                    )
                    if ok_now:
                        emit_step("[CloakBrowser] Đăng nhập thành công! Đã lưu phiên Dola + msToken.")
                        return {
                            "ok": True,
                            "status": "ready",
                            "message": f"Đăng nhập Facebook → Dola bằng CloakBrowser thành công ({snap.get('screenName') or fb_uid})!",
                            **snap,
                        }

                if 1011 in login_codes:
                    await _confirm_age_gate(page)

            return {
                "ok": False,
                "status": "expired",
                "message": "Không lấy được phiên Dola sau khi đăng nhập Facebook (hết thời gian chờ cấp sessionid).",
            }
        finally:
            await ctx.close()


async def run_google_login_flow(cfg: Dict[str, Any]) -> Dict[str, Any]:
    account_key = str(cfg.get("accountKey") or cfg.get("accountId") or "default")
    account_dir = Path(cfg["accountDir"])
    email = str(cfg.get("email") or "")
    password = str(cfg.get("password") or "")
    dola_cookie = str(cfg.get("dolaCookie") or "")
    proxy_raw = cfg.get("proxyUrl")
    visible = bool(cfg.get("visible", True))
    ext_dir = cfg.get("logoutGuardDir")
    base_url = str(cfg.get("baseUrl") or "https://www.dola.com").rstrip("/")
    timeout_sec = int(cfg.get("timeoutSec") or 120)

    async with async_playwright() as p:
        emit_step(f"[CloakBrowser] Đang mở CloakBrowser đăng nhập Google ({email})…")
        ctx = await launch_cloak_context(
            p=p,
            account_key=account_key,
            account_dir=account_dir,
            headless=not visible,
            proxy_raw=proxy_raw,
            ext_dir=ext_dir,
        )
        sniffed = watch_mstoken(ctx)
        try:
            await restore_dola_cookies_if_needed(ctx, account_dir, dola_cookie)
            page = ctx.pages[0] if ctx.pages else await ctx.new_page()
            await force_ui_language(ctx, "en")
            await page.goto(f"{base_url}/chat", timeout=60000, wait_until="domcontentloaded")

            dead_sid = ""
            ok_exist, dead_sid, snap_exist = await check_and_use_existing_dola_session(
                ctx, page, account_dir, sniffed, dead_sid
            )
            if ok_exist:
                return {
                    "ok": True,
                    "status": "ready",
                    "message": f"Đăng nhập Google → Dola bằng CloakBrowser thành công ({snap_exist.get('screenName') or email})!",
                    **snap_exist,
                }

            deadline = time.monotonic() + timeout_sec
            while time.monotonic() < deadline:
                await page.wait_for_timeout(1500)
                await _confirm_age_gate(page)

                live = await ctx.cookies("https://www.dola.com")
                sid = cookie_value(live, "sessionid") or cookie_value(live, "sid_guard")
                if sid and sid != dead_sid:
                    ok_now, dead_sid, snap = await check_and_use_existing_dola_session(
                        ctx, page, account_dir, sniffed, dead_sid
                    )
                    if ok_now:
                        return {
                            "ok": True,
                            "status": "ready",
                            "message": f"Đăng nhập Google → Dola bằng CloakBrowser thành công ({snap.get('screenName') or email})!",
                            **snap,
                        }

                for target in list(ctx.pages):
                    if target.is_closed():
                        continue
                    t_url = target.url.lower()
                    if "dola.com" in t_url:
                        for sel in (
                            "button:has-text('Continue with Google')",
                            "button:has-text('Tiếp tục bằng Google')",
                            "[role='button']:has-text('Google')",
                            "[data-testid='to_login_button']",
                            "button:has-text('Log in')",
                            "button:has-text('Đăng nhập')",
                        ):
                            try:
                                btn = target.locator(sel).first
                                if await btn.count() and await btn.is_visible():
                                    await btn.click(timeout=2000)
                                    await target.wait_for_timeout(1200)
                                    break
                            except Exception:
                                continue
                    elif "google.com" in t_url:
                        try:
                            em_input = target.locator("input[type='email'], #identifierId").first
                            if await em_input.count() and await em_input.is_visible():
                                val = await em_input.input_value()
                                if not val:
                                    await em_input.fill(email)
                                    await target.keyboard.press("Enter")
                                    await target.wait_for_timeout(2000)
                                    continue
                            pw_input = target.locator("input[type='password'], input[name='Passwd']").first
                            if await pw_input.count() and await pw_input.is_visible():
                                val = await pw_input.input_value()
                                if not val:
                                    await pw_input.fill(password)
                                    await target.keyboard.press("Enter")
                                    await target.wait_for_timeout(2500)
                                    continue
                            for c_sel in (
                                "button:has-text('Continue')",
                                "button:has-text('Tiếp tục')",
                                "button:has-text('I agree')",
                                "button:has-text('Tôi đồng ý')",
                                "button:has-text('Allow')",
                            ):
                                c_btn = target.locator(c_sel).first
                                if await c_btn.count() and await c_btn.is_visible():
                                    await c_btn.click(timeout=1500)
                                    break
                        except Exception:
                            pass

            return {
                "ok": False,
                "status": "expired",
                "message": "Quá thời gian đăng nhập Google tự động trên CloakBrowser.",
            }
        finally:
            await ctx.close()


async def run_interactive_browser(cfg: Dict[str, Any]) -> Dict[str, Any]:
    """Opens a visible CloakBrowser window for the account (🌐 button).
    Restores Dola & Facebook cookies, auto-assists with 18+ age-gate and Facebook OAuth popups,
    streams live session updates to Node.js whenever cookies/sessionid change, and saves on close."""
    account_key = str(cfg.get("accountKey") or cfg.get("accountId") or "default")
    account_dir = Path(cfg["accountDir"])
    fb_cookie = str(cfg.get("fbCookie") or "")
    dola_cookie = str(cfg.get("dolaCookie") or "")
    fb_uid = str(cfg.get("fbUid") or "")
    fb_password = str(cfg.get("password") or "")
    totp_secret = str(cfg.get("twoFactorSecret") or "")
    proxy_raw = cfg.get("proxyUrl")
    ext_dir = cfg.get("logoutGuardDir")
    base_url = str(cfg.get("baseUrl") or "https://www.dola.com").rstrip("/")

    async with async_playwright() as p:
        emit_step(f"[CloakBrowser] Đang mở trình duyệt CloakBrowser cho tài khoản ({account_key})…")
        ctx = await launch_cloak_context(
            p=p,
            account_key=account_key,
            account_dir=account_dir,
            headless=False,
            proxy_raw=proxy_raw,
            ext_dir=ext_dir,
        )
        sniffed = watch_mstoken(ctx)
        try:
            await restore_dola_cookies_if_needed(ctx, account_dir, dola_cookie)
            if fb_cookie:
                await inject_facebook_cookies(ctx, fb_cookie)

            page = ctx.pages[0] if ctx.pages else await ctx.new_page()
            await force_ui_language(ctx, "en")
            try:
                await page.goto(f"{base_url}/chat", timeout=60000, wait_until="domcontentloaded")
            except Exception:
                pass

            emit_json({"type": "window_opened", "accountKey": account_key})

            last_emitted_sid = ""
            last_emitted_ms = ""
            autofilled_popup_ids = set()

            # Loop while at least one page remains open in the CloakBrowser window
            while True:
                await asyncio.sleep(1.8)
                open_pages = [pg for pg in ctx.pages if not pg.is_closed()]
                if not open_pages:
                    break

                main_page = open_pages[0]
                for pg in open_pages:
                    try:
                        u = (pg.url or "").lower()
                        if "work.meta.com" in u:
                            await pg.close()
                            continue
                        if "dola.com" in u:
                            main_page = pg
                            await _confirm_age_gate(pg)
                        elif "facebook.com" in u and len(open_pages) > 1:
                            if "login.php" not in u and "/login" not in u:
                                await _click_continue_fb(pg, timeout=2000)
                    except Exception:
                        pass

                try:
                    live = await ctx.cookies("https://www.dola.com")
                    sid = cookie_value(live, "sessionid") or cookie_value(live, "sid_guard")
                    ms = cookie_value(live, "msToken")
                    if sid and (sid != last_emitted_sid or (ms and ms != last_emitted_ms)):
                        probe = await probe_dola_identity_in_page(main_page)
                        if probe.get("ok") and not probe.get("isGuest"):
                            await send_initial_greeting_hi(main_page, account_dir)
                            snap = await capture_and_persist_session(
                                ctx, account_dir, sniffed, wait_mstoken_sec=1.5
                            )
                            last_emitted_sid = sid
                            last_emitted_ms = snap.get("msToken") or ""
                            emit_json(
                                {
                                    "type": "session_update",
                                    "ok": True,
                                    "userId": probe.get("userId", ""),
                                    "screenName": probe.get("screenName", "") or fb_uid,
                                    **snap,
                                }
                            )
                except Exception:
                    pass

            # Window closed by user: do a final capture if sessionid exists
            try:
                live = await ctx.cookies("https://www.dola.com")
                if cookie_value(live, "sessionid") or cookie_value(live, "sid_guard"):
                    snap = await capture_and_persist_session(ctx, account_dir, sniffed, wait_mstoken_sec=0.5)
                    return {
                        "ok": True,
                        "status": "ready",
                        "message": "Đã đóng cửa sổ CloakBrowser và lưu phiên đăng nhập.",
                        **snap,
                    }
            except Exception:
                pass

            return {
                "ok": True,
                "status": "closed",
                "message": "Đã đóng cửa sổ CloakBrowser.",
            }
        finally:
            try:
                await ctx.close()
            except Exception:
                pass


async def main() -> None:
    parser = argparse.ArgumentParser(description="CloakBrowser runner for ViraAI")
    parser.add_argument("--config", required=True, help="JSON config string or path to JSON file")
    args = parser.parse_args()

    raw_cfg = args.config.strip()
    if raw_cfg.startswith("{"):
        cfg = json.loads(raw_cfg)
    else:
        cfg = json.loads(Path(raw_cfg).read_text(encoding="utf-8"))

    mode = cfg.get("mode", "fb_login")
    try:
        if mode == "fb_login":
            res = await run_fb_login_flow(cfg)
        elif mode == "google_login":
            res = await run_google_login_flow(cfg)
        elif mode == "interactive":
            res = await run_interactive_browser(cfg)
        else:
            res = {"ok": False, "message": f"Unsupported mode: {mode}"}
    except Exception as exc:
        res = {
            "ok": False,
            "status": "error",
            "message": f"Lỗi CloakBrowser: {str(exc)[:220]}",
        }

    emit_json({"type": "result", **res})


if __name__ == "__main__":
    asyncio.run(main())

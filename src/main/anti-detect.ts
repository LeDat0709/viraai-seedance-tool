import { BrowserWindow } from 'electron'
import * as crypto from 'crypto'

export interface AccountFingerprint {
  seedHash: string
  fallbackWebId: string
  userAgent: string
  platform: string
  uaDataPlatform: string
  uaDataPlatformVersion: string
  chromeMajor: string
  chromeFullVersion: string
  webglVendor: string
  webglRenderer: string
  hardwareConcurrency: number
  deviceMemory: number
  screenWidth: number
  screenHeight: number
  availWidth: number
  availHeight: number
  devicePixelRatio: number
  noiseSeed: number
}

const FINGERPRINT_PRESETS: Array<{
  userAgent: string
  platform: string
  uaDataPlatform: string
  uaDataPlatformVersion: string
  chromeMajor: string
  chromeFullVersion: string
  webglVendor: string
  webglRenderer: string
  hardwareConcurrency: number
  deviceMemory: number
  screenWidth: number
  screenHeight: number
  devicePixelRatio: number
}> = [
  {
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    platform: 'MacIntel',
    uaDataPlatform: 'macOS',
    uaDataPlatformVersion: '14.6.1',
    chromeMajor: '131',
    chromeFullVersion: '131.0.6778.205',
    webglVendor: 'Google Inc. (Apple)',
    webglRenderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Pro, Unspecified Version)',
    hardwareConcurrency: 10,
    deviceMemory: 16,
    screenWidth: 1512,
    screenHeight: 982,
    devicePixelRatio: 2
  },
  {
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
    platform: 'MacIntel',
    uaDataPlatform: 'macOS',
    uaDataPlatformVersion: '15.1.0',
    chromeMajor: '132',
    chromeFullVersion: '132.0.6834.110',
    webglVendor: 'Google Inc. (Apple)',
    webglRenderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)',
    hardwareConcurrency: 8,
    deviceMemory: 8,
    screenWidth: 1470,
    screenHeight: 956,
    devicePixelRatio: 2
  },
  {
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
    platform: 'MacIntel',
    uaDataPlatform: 'macOS',
    uaDataPlatformVersion: '15.2.0',
    chromeMajor: '133',
    chromeFullVersion: '133.0.6943.98',
    webglVendor: 'Google Inc. (Apple)',
    webglRenderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Pro, Unspecified Version)',
    hardwareConcurrency: 12,
    deviceMemory: 16,
    screenWidth: 1728,
    screenHeight: 1117,
    devicePixelRatio: 2
  },
  {
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    platform: 'MacIntel',
    uaDataPlatform: 'macOS',
    uaDataPlatformVersion: '14.5.0',
    chromeMajor: '131',
    chromeFullVersion: '131.0.6778.140',
    webglVendor: 'Google Inc. (Apple)',
    webglRenderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)',
    hardwareConcurrency: 8,
    deviceMemory: 8,
    screenWidth: 1440,
    screenHeight: 900,
    devicePixelRatio: 2
  },
  {
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
    platform: 'MacIntel',
    uaDataPlatform: 'macOS',
    uaDataPlatformVersion: '14.7.1',
    chromeMajor: '132',
    chromeFullVersion: '132.0.6834.83',
    webglVendor: 'Google Inc. (Apple)',
    webglRenderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Max, Unspecified Version)',
    hardwareConcurrency: 12,
    deviceMemory: 32,
    screenWidth: 1680,
    screenHeight: 1050,
    devicePixelRatio: 2
  },
  {
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
    platform: 'MacIntel',
    uaDataPlatform: 'macOS',
    uaDataPlatformVersion: '15.3.0',
    chromeMajor: '133',
    chromeFullVersion: '133.0.6943.54',
    webglVendor: 'Google Inc. (Apple)',
    webglRenderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M3, Unspecified Version)',
    hardwareConcurrency: 8,
    deviceMemory: 16,
    screenWidth: 1512,
    screenHeight: 982,
    devicePixelRatio: 2
  }
]

const fingerprintCache = new Map<string, AccountFingerprint>()
const decoratedWindows = new WeakSet<BrowserWindow>()

export function getAccountFingerprint(seedKey: string): AccountFingerprint {
  const key = String(seedKey || 'default').trim()
  const cached = fingerprintCache.get(key)
  if (cached) return cached

  const hash = crypto.createHash('sha256').update(`viraai-fp-v1:${key}`).digest()
  const presetIdx = hash[0] % FINGERPRINT_PRESETS.length
  const preset = FINGERPRINT_PRESETS[presetIdx]
  const noiseSeed = (hash[1] % 250) + 1

  // Deterministic 19-digit ByteDance-style web_id ("769" + 16 digits) unique to this partition
  let digits = '769'
  for (let i = 2; i < 18; i++) {
    digits += String(hash[i] % 10)
  }

  const fp: AccountFingerprint = {
    seedHash: hash.toString('hex').slice(0, 16),
    fallbackWebId: digits,
    userAgent: preset.userAgent,
    platform: preset.platform,
    uaDataPlatform: preset.uaDataPlatform,
    uaDataPlatformVersion: preset.uaDataPlatformVersion,
    chromeMajor: preset.chromeMajor,
    chromeFullVersion: preset.chromeFullVersion,
    webglVendor: preset.webglVendor,
    webglRenderer: preset.webglRenderer,
    hardwareConcurrency: preset.hardwareConcurrency,
    deviceMemory: preset.deviceMemory,
    screenWidth: preset.screenWidth,
    screenHeight: preset.screenHeight,
    availWidth: preset.screenWidth,
    availHeight: preset.screenHeight - 28,
    devicePixelRatio: preset.devicePixelRatio,
    noiseSeed
  }

  fingerprintCache.set(key, fp)
  return fp
}

const guardedSessions = new WeakSet<Electron.Session>()

/**
 * Blocks ByteDance Shark `/passport/<type>/logout` requests on an Electron session partition
 * so Dola never wipes `sessionid` from the cookie jar.
 */
export function installLogoutGuardOnSession(ses: Electron.Session): void {
  if (!ses || guardedSessions.has(ses)) return
  guardedSessions.add(ses)
  try {
    ses.webRequest.onBeforeRequest(
      {
        urls: ['*://*.dola.com/passport/*/logout*', '*://dola.com/passport/*/logout*']
      },
      (_details, callback) => {
        callback({ cancel: true })
      }
    )
  } catch {}
}

/**
 * Generates an initialization script injected into the page:
 * Unifies Dola `cookie._web_id`, `localStorage['samantha_web_web_id']`, and `localStorage['_tea_cache_tokens_495671']`
 * so ByteDance's `webmssdk` / `bdms` never detects mismatched `device_id` vs `web_id` vs `_web_id` cookie.
 * NOTE: Never tamper with Navigator.prototype, Screen.prototype, WebGL, or Canvas via JS `Object.defineProperty`
 * (ByteDance bdms detects JS prototype descriptor overrides and rejects `/passport/` / `/alice/profile/self_brief`).
 */
export function buildAntiDetectInitScript(
  fp: AccountFingerprint,
  preferredWebId?: string
): string {
  const cfg = JSON.stringify({
    fp,
    preferredWebId: preferredWebId || fp.fallbackWebId || ''
  })

  return `
(() => {
  try {
    const CFG = ${cfg};
    const FP = CFG.fp;

    const syncDolaIdentity = () => {
      try {
        if (!location || !location.hostname || !location.hostname.includes('dola.com')) return;
        const cookieStr = document.cookie || '';
        const readCookie = (name) => {
          const m = cookieStr.match(new RegExp('(?:^|;\\\\s*)' + name + '=([^;]+)'));
          return m ? decodeURIComponent(m[1]) : '';
        };
        const readJson = (key) => {
          try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (_) { return null; }
        };

        const cookieWebId = readCookie('_web_id');
        const samantha = readJson('samantha_web_web_id');
        const tea = readJson('_tea_cache_tokens_495671');
        const passportUid =
          (samantha && samantha.user_id) ||
          (tea && tea.user_unique_id) ||
          '';

        const canonicalWebId =
          cookieWebId ||
          (samantha && samantha.web_id) ||
          (tea && tea.web_id) ||
          CFG.preferredWebId ||
          FP.fallbackWebId ||
          '';

        if (canonicalWebId && /^\\d{15,22}$/.test(canonicalWebId)) {
          const now = Date.now();
          if (!samantha || samantha.web_id !== canonicalWebId) {
            localStorage.setItem(
              'samantha_web_web_id',
              JSON.stringify({
                user_id: (samantha && samantha.user_id) || passportUid || canonicalWebId,
                web_id: canonicalWebId,
                timestamp: (samantha && samantha.timestamp) || now
              })
            );
          }
          if (!tea || tea.web_id !== canonicalWebId) {
            localStorage.setItem(
              '_tea_cache_tokens_495671',
              JSON.stringify({
                web_id: canonicalWebId,
                user_unique_id: (tea && tea.user_unique_id) || passportUid || canonicalWebId,
                timestamp: (tea && tea.timestamp) || now,
                _type_: 'default'
              })
            );
          }
          if (!cookieWebId) {
            document.cookie = '_web_id=' + canonicalWebId + '; path=/; domain=.dola.com; max-age=31536000; SameSite=Lax';
          }
        }
      } catch (_) {}
    };

    syncDolaIdentity();
  } catch (_) {}
})();
`
}

/**
 * Applies native User-Agent cleanup (preserving exact Chromium version to match `sec-ch-ua`),
 * WebRTC leak protection, Dola `/passport/<type>/logout` blocker, and `_web_id` identity sync to a `BrowserWindow`.
 */
export async function applyAntiDetectToWindow(
  win: BrowserWindow,
  seedKey: string,
  preferredWebId?: string
): Promise<AccountFingerprint> {
  const fp = getAccountFingerprint(seedKey)
  if (!win || win.isDestroyed()) return fp

  try {
    installLogoutGuardOnSession(win.webContents.session)
  } catch {}

  try {
    const rawUa = win.webContents.getUserAgent() || ''
    const cleanNativeUa = rawUa
      .replace(/\s+Electron\/[\d.]+/gi, '')
      .replace(/\s+viraai-seedance-studio\/[\d.]+/gi, '')
      .replace(/\s+ViraAI[^\s]*/gi, '')
      .trim()
    win.webContents.setUserAgent(cleanNativeUa || fp.userAgent)
  } catch {}

  try {
    win.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
  } catch {}

  const script = buildAntiDetectInitScript(fp, preferredWebId)

  if (!decoratedWindows.has(win)) {
    decoratedWindows.add(win)
    try {
      win.webContents.setMaxListeners(100)
    } catch {}
    const injectNow = () => {
      try {
        if (!win.isDestroyed()) {
          win.webContents.executeJavaScript(script).catch(() => {})
        }
      } catch {}
    }
    try {
      win.webContents.on('dom-ready', injectNow)
      win.webContents.on('did-finish-load', injectNow)
    } catch {}
  }

  return fp
}

import { app } from 'electron'
import { spawn, ChildProcess } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as crypto from 'crypto'
import type { AccountProfile } from '../shared/types'

export interface CloakSessionSnapshot {
  ok: boolean
  status?: 'ready' | 'expired' | 'error' | 'closed'
  errorCode?: string
  message?: string
  cookieHeader?: string
  fbCookieHeader?: string
  sessionId?: string
  msToken?: string
  webId?: string
  userId?: string
  screenName?: string
  cookies?: Array<Record<string, any>>
}

const activeCloakInteractiveProcs = new Map<string, ChildProcess>()

export function computeCloakSeed(accountKey: string): number {
  const hex = crypto.createHash('sha256').update(accountKey).digest('hex')
  const rem = Number(BigInt('0x' + hex) % 90000n)
  return 10000 + rem
}

export function getCloakAccountKey(acc: Pick<AccountProfile, 'id' | 'fbUid'>): string {
  const uid = (acc.fbUid || '').trim()
  return uid ? `fb${uid}` : acc.id
}

export function resolveCloakBinaryPath(): string | null {
  const envBin = (process.env.CLOAKBROWSER_BINARY_PATH || '').trim()
  if (envBin && fs.existsSync(envBin)) {
    return envBin
  }

  const cacheDir =
    (process.env.CLOAKBROWSER_CACHE_DIR || '').trim() ||
    path.join(os.homedir(), '.cloakbrowser')

  if (fs.existsSync(cacheDir)) {
    try {
      const entries = fs
        .readdirSync(cacheDir)
        .filter((name) => name.startsWith('chromium-'))
        .sort()
        .reverse()
      for (const dirName of entries) {
        const base = path.join(cacheDir, dirName)
        const cand =
          process.platform === 'darwin'
            ? path.join(base, 'Chromium.app', 'Contents', 'MacOS', 'Chromium')
            : process.platform === 'win32'
              ? path.join(base, 'chrome.exe')
              : path.join(base, 'chrome')
        if (fs.existsSync(cand)) {
          return cand
        }
      }
    } catch {}
  }

  return null
}

export function resolveCloakPythonPath(): string | null {
  const candidates = [
    process.env.VIRAAI_CLOAK_PYTHON,
    '/Users/dat/Downloads/dola-render-gateway/.venv/bin/python',
    '/Users/dat/Downloads/dola-render-gateway/venv/bin/python',
    path.resolve(process.cwd(), '../dola-render-gateway/.venv/bin/python'),
    path.resolve(process.cwd(), '.venv/bin/python')
  ].filter(Boolean) as string[]

  for (const cand of candidates) {
    try {
      if (fs.existsSync(cand)) {
        return cand
      }
    } catch {}
  }
  return null
}

export function resolveCloakResources(): {
  runnerScript: string
  logoutGuardDir: string
} | null {
  const roots = [
    process.resourcesPath ? path.join(process.resourcesPath, 'resources') : '',
    process.resourcesPath ? path.join(process.resourcesPath, 'app.asar.unpacked', 'resources') : '',
    path.join(process.cwd(), 'resources'),
    path.join(app.getAppPath(), 'resources'),
    path.resolve(__dirname, '../../resources')
  ].filter(Boolean)

  for (const r of roots) {
    const runnerScript = path.join(r, 'cloak_runner.py')
    const logoutGuardDir = path.join(r, 'logout_guard')
    if (fs.existsSync(runnerScript)) {
      if (!runnerScript.includes('.asar') || runnerScript.includes('app.asar.unpacked')) {
        return { runnerScript, logoutGuardDir }
      }
      // If inside app.asar, extract to userData/cloak_resources so external Python can execute it
      try {
        const extractedRoot = path.join(app.getPath('userData'), 'cloak_resources')
        const extractedGuard = path.join(extractedRoot, 'logout_guard')
        fs.mkdirSync(extractedGuard, { recursive: true })
        const extractedRunner = path.join(extractedRoot, 'cloak_runner.py')
        fs.writeFileSync(extractedRunner, fs.readFileSync(runnerScript, 'utf8'), 'utf8')
        for (const fName of ['manifest.json', 'rules.json']) {
          const srcFile = path.join(logoutGuardDir, fName)
          if (fs.existsSync(srcFile)) {
            fs.writeFileSync(path.join(extractedGuard, fName), fs.readFileSync(srcFile, 'utf8'), 'utf8')
          }
        }
        return { runnerScript: extractedRunner, logoutGuardDir: extractedGuard }
      } catch {}
    }
  }
  return null
}

export function resolveCloakAccountDir(acc: Pick<AccountProfile, 'id' | 'fbUid'>): string {
  const accountKey = getCloakAccountKey(acc)
  // Reuse existing warmed CloakBrowser profile in dola-render-gateway if present on disk
  const gatewayAccountsDir = '/Users/dat/Downloads/dola-render-gateway/accounts'
  const gatewayAccountPath = path.join(gatewayAccountsDir, accountKey)
  try {
    if (fs.existsSync(gatewayAccountPath) && fs.statSync(gatewayAccountPath).isDirectory()) {
      return gatewayAccountPath
    }
  } catch {}

  const localDir = path.join(app.getPath('userData'), 'cloak_profiles', accountKey)
  try {
    fs.mkdirSync(localDir, { recursive: true })
  } catch {}
  return localDir
}

export function isCloakBrowserAvailable(): boolean {
  const py = resolveCloakPythonPath()
  const res = resolveCloakResources()
  return Boolean(py && res && fs.existsSync(res.runnerScript))
}

function writeTempCloakConfig(configObj: Record<string, any>): string {
  const tmpDir = path.join(app.getPath('userData'), 'cloak_tmp')
  fs.mkdirSync(tmpDir, { recursive: true })
  const cfgPath = path.join(
    tmpDir,
    `cloak_cfg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.json`
  )
  fs.writeFileSync(cfgPath, JSON.stringify(configObj, null, 2), 'utf8')
  return cfgPath
}

function cleanupTempFile(filePath: string): void {
  try {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath)
    }
  } catch {}
}

export async function runCloakFacebookLogin(
  acc: AccountProfile,
  options: {
    visible?: boolean
    proxyUrl?: string | null
    baseUrl?: string
    timeoutSec?: number
    onStep?: (msg: string) => void
  } = {}
): Promise<CloakSessionSnapshot> {
  const py = resolveCloakPythonPath()
  const res = resolveCloakResources()
  if (!py || !res) {
    return {
      ok: false,
      status: 'error',
      message: 'Không tìm thấy môi trường Python CloakBrowser + Patchright.'
    }
  }

  const accountKey = getCloakAccountKey(acc)
  const accountDir = resolveCloakAccountDir(acc)
  const cloakBin = resolveCloakBinaryPath()

  const cfgPath = writeTempCloakConfig({
    mode: 'fb_login',
    accountId: acc.id,
    accountKey,
    accountDir,
    fbUid: acc.fbUid || '',
    fbCookie: acc.fbCookie || '',
    dolaCookie: acc.cookieHeader || '',
    password: acc.password || '',
    twoFactorSecret: acc.twoFactorSecret || '',
    proxyUrl: options.proxyUrl || null,
    visible: Boolean(options.visible),
    logoutGuardDir: res.logoutGuardDir,
    baseUrl: options.baseUrl || 'https://www.dola.com',
    timeoutSec: options.timeoutSec || 75
  })

  return new Promise<CloakSessionSnapshot>((resolve) => {
    let settled = false
    let finalResult: CloakSessionSnapshot | null = null
    let stderrTail = ''
    let stdoutBuf = ''

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PYTHONUNBUFFERED: '1',
      PYTHONIOENCODING: 'utf-8'
    }
    if (cloakBin) {
      env.CLOAKBROWSER_BINARY_PATH = cloakBin
    }

    const child = spawn(py, [res.runnerScript, '--config', cfgPath], {
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    })

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        child.kill('SIGTERM')
      } catch {}
      cleanupTempFile(cfgPath)
      resolve({
        ok: false,
        status: 'expired',
        message: 'Quá thời gian chờ đăng nhập Facebook trên CloakBrowser.'
      })
    }, ((options.timeoutSec || 75) + 35) * 1000)

    const handleLine = (line: string) => {
      const idx = line.indexOf('__CLOAK_EVENT__')
      if (idx < 0) return
      const jsonStr = line.slice(idx + '__CLOAK_EVENT__'.length).trim()
      try {
        const evt = JSON.parse(jsonStr)
        if (evt.type === 'step' && evt.message && options.onStep) {
          options.onStep(String(evt.message))
        } else if (evt.type === 'result') {
          finalResult = evt as CloakSessionSnapshot
        }
      } catch {}
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString('utf8')
      const lines = stdoutBuf.split(/\r?\n/)
      stdoutBuf = lines.pop() || ''
      for (const ln of lines) {
        handleLine(ln)
      }
    })

    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-600)
    })

    child.on('close', () => {
      if (stdoutBuf) {
        handleLine(stdoutBuf)
        stdoutBuf = ''
      }
      clearTimeout(timer)
      cleanupTempFile(cfgPath)
      if (settled) return
      settled = true
      if (finalResult) {
        resolve(finalResult)
      } else {
        resolve({
          ok: false,
          status: 'error',
          message: stderrTail.trim()
            ? `CloakBrowser dừng bất ngờ: ${stderrTail.trim().slice(-200)}`
            : 'CloakBrowser đóng trước khi hoàn tất đăng nhập.'
        })
      }
    })

    child.on('error', (err) => {
      clearTimeout(timer)
      cleanupTempFile(cfgPath)
      if (settled) return
      settled = true
      resolve({
        ok: false,
        status: 'error',
        message: `Không khởi chạy được CloakBrowser: ${err.message}`
      })
    })
  })
}

export async function runCloakGoogleLogin(
  acc: AccountProfile,
  options: {
    visible?: boolean
    proxyUrl?: string | null
    baseUrl?: string
    timeoutSec?: number
    onStep?: (msg: string) => void
  } = {}
): Promise<CloakSessionSnapshot> {
  const py = resolveCloakPythonPath()
  const res = resolveCloakResources()
  if (!py || !res) {
    return {
      ok: false,
      status: 'error',
      message: 'Không tìm thấy môi trường Python CloakBrowser + Patchright.'
    }
  }

  const accountKey = getCloakAccountKey(acc)
  const accountDir = resolveCloakAccountDir(acc)
  const cloakBin = resolveCloakBinaryPath()

  const cfgPath = writeTempCloakConfig({
    mode: 'google_login',
    accountId: acc.id,
    accountKey,
    accountDir,
    email: acc.email || '',
    password: acc.password || '',
    dolaCookie: acc.cookieHeader || '',
    proxyUrl: options.proxyUrl || null,
    visible: options.visible ?? true,
    logoutGuardDir: res.logoutGuardDir,
    baseUrl: options.baseUrl || 'https://www.dola.com',
    timeoutSec: options.timeoutSec || 120
  })

  return new Promise<CloakSessionSnapshot>((resolve) => {
    let settled = false
    let finalResult: CloakSessionSnapshot | null = null
    let stdoutBuf = ''

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PYTHONUNBUFFERED: '1',
      PYTHONIOENCODING: 'utf-8'
    }
    if (cloakBin) {
      env.CLOAKBROWSER_BINARY_PATH = cloakBin
    }

    const child = spawn(py, [res.runnerScript, '--config', cfgPath], {
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    })

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        child.kill('SIGTERM')
      } catch {}
      cleanupTempFile(cfgPath)
      resolve({
        ok: false,
        status: 'expired',
        message: 'Quá thời gian đăng nhập Google trên CloakBrowser.'
      })
    }, ((options.timeoutSec || 120) + 30) * 1000)

    const handleLine = (line: string) => {
      const idx = line.indexOf('__CLOAK_EVENT__')
      if (idx < 0) return
      const jsonStr = line.slice(idx + '__CLOAK_EVENT__'.length).trim()
      try {
        const evt = JSON.parse(jsonStr)
        if (evt.type === 'step' && evt.message && options.onStep) {
          options.onStep(String(evt.message))
        } else if (evt.type === 'result') {
          finalResult = evt as CloakSessionSnapshot
        }
      } catch {}
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString('utf8')
      const lines = stdoutBuf.split(/\r?\n/)
      stdoutBuf = lines.pop() || ''
      for (const ln of lines) {
        handleLine(ln)
      }
    })

    child.on('close', () => {
      if (stdoutBuf) {
        handleLine(stdoutBuf)
        stdoutBuf = ''
      }
      clearTimeout(timer)
      cleanupTempFile(cfgPath)
      if (settled) return
      settled = true
      resolve(
        finalResult || {
          ok: false,
          status: 'expired',
          message: 'Đã đóng cửa sổ đăng nhập Google CloakBrowser.'
        }
      )
    })

    child.on('error', (err) => {
      clearTimeout(timer)
      cleanupTempFile(cfgPath)
      if (settled) return
      settled = true
      resolve({
        ok: false,
        status: 'error',
        message: `Lỗi mở CloakBrowser: ${err.message}`
      })
    })
  })
}

export async function openCloakInteractiveBrowser(
  acc: AccountProfile,
  options: {
    proxyUrl?: string | null
    baseUrl?: string
    onStep?: (msg: string) => void
    onSessionUpdate?: (snap: CloakSessionSnapshot) => void
    onWindowClosed?: (finalSnap?: CloakSessionSnapshot) => void
  } = {}
): Promise<{ ok: boolean; message: string }> {
  const existing = activeCloakInteractiveProcs.get(acc.id)
  if (existing && !existing.killed) {
    return {
      ok: true,
      message: `Cửa sổ CloakBrowser của ${acc.name} đang mở sẵn.`
    }
  }

  const py = resolveCloakPythonPath()
  const res = resolveCloakResources()
  if (!py || !res) {
    return {
      ok: false,
      message: 'Không tìm thấy môi trường Python CloakBrowser + Patchright.'
    }
  }

  const accountKey = getCloakAccountKey(acc)
  const accountDir = resolveCloakAccountDir(acc)
  const cloakBin = resolveCloakBinaryPath()

  const cfgPath = writeTempCloakConfig({
    mode: 'interactive',
    accountId: acc.id,
    accountKey,
    accountDir,
    fbUid: acc.fbUid || '',
    fbCookie: acc.fbCookie || '',
    dolaCookie: acc.cookieHeader || '',
    password: acc.password || '',
    twoFactorSecret: acc.twoFactorSecret || '',
    proxyUrl: options.proxyUrl || null,
    logoutGuardDir: res.logoutGuardDir,
    baseUrl: options.baseUrl || 'https://www.dola.com'
  })

  return new Promise<{ ok: boolean; message: string }>((resolve) => {
    let resolvedOpen = false
    let stdoutBuf = ''
    let finalResult: CloakSessionSnapshot | undefined

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PYTHONUNBUFFERED: '1',
      PYTHONIOENCODING: 'utf-8'
    }
    if (cloakBin) {
      env.CLOAKBROWSER_BINARY_PATH = cloakBin
    }

    const child = spawn(py, [res.runnerScript, '--config', cfgPath], {
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    })

    activeCloakInteractiveProcs.set(acc.id, child)

    const openTimer = setTimeout(() => {
      if (!resolvedOpen) {
        resolvedOpen = true
        resolve({
          ok: true,
          message: `Đã khởi chạy trình duyệt CloakBrowser cho ${acc.name} (seed=${computeCloakSeed(accountKey)}).`
        })
      }
    }, 6000)

    const handleLine = (line: string) => {
      const idx = line.indexOf('__CLOAK_EVENT__')
      if (idx < 0) return
      const jsonStr = line.slice(idx + '__CLOAK_EVENT__'.length).trim()
      try {
        const evt = JSON.parse(jsonStr)
        if (evt.type === 'step' && evt.message && options.onStep) {
          options.onStep(String(evt.message))
        } else if (evt.type === 'window_opened') {
          if (!resolvedOpen) {
            resolvedOpen = true
            clearTimeout(openTimer)
            resolve({
              ok: true,
              message: `Đã mở trình duyệt CloakBrowser C++ cho ${acc.name} (seed=${computeCloakSeed(accountKey)}).`
            })
          }
        } else if (evt.type === 'session_update') {
          if (options.onSessionUpdate) {
            options.onSessionUpdate(evt as CloakSessionSnapshot)
          }
        } else if (evt.type === 'result') {
          finalResult = evt as CloakSessionSnapshot
          if (finalResult.cookieHeader && options.onSessionUpdate) {
            options.onSessionUpdate(finalResult)
          }
        }
      } catch {}
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString('utf8')
      const lines = stdoutBuf.split(/\r?\n/)
      stdoutBuf = lines.pop() || ''
      for (const ln of lines) {
        handleLine(ln)
      }
    })

    child.on('close', () => {
      if (stdoutBuf) {
        handleLine(stdoutBuf)
        stdoutBuf = ''
      }
      clearTimeout(openTimer)
      activeCloakInteractiveProcs.delete(acc.id)
      cleanupTempFile(cfgPath)
      if (!resolvedOpen) {
        resolvedOpen = true
        resolve({
          ok: finalResult?.ok ?? false,
          message: finalResult?.message || 'Cửa sổ CloakBrowser đã đóng.'
        })
      }
      if (options.onWindowClosed) {
        options.onWindowClosed(finalResult)
      }
    })

    child.on('error', (err) => {
      clearTimeout(openTimer)
      activeCloakInteractiveProcs.delete(acc.id)
      cleanupTempFile(cfgPath)
      if (!resolvedOpen) {
        resolvedOpen = true
        resolve({
          ok: false,
          message: `Không mở được CloakBrowser: ${err.message}`
        })
      }
    })
  })
}

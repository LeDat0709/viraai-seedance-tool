import { app, session } from 'electron'
import * as crypto from 'crypto'
import { ProxyEntry, RotatingProxyEntry, RotatingProxyProvider } from '../shared/types'
import { store } from './store'
import { proxyKeepMs, rotateCooldownSec } from './proxy-ttl'

// Map partition -> proxy credentials for Electron's 'login' event handler
const partitionCredentials = new Map<string, { username: string; password: string }>()
let loginListenerRegistered = false

export function registerProxyAuthHandler(): void {
  if (loginListenerRegistered) return
  loginListenerRegistered = true

  app.on('login', (event, webContents, _request, authInfo, callback) => {
    if (!authInfo.isProxy) return
    event.preventDefault()
    // Find credentials for this webContents session
    for (const [partName, creds] of partitionCredentials.entries()) {
      const partSession = session.fromPartition(partName)
      if (webContents.session === partSession) {
        callback(creds.username, creds.password)
        return
      }
    }
    // Fallback: check any matching host/port proxy in store
    const match = store
      .getProxies()
      .find((p) => p.host === authInfo.host && p.port === authInfo.port && p.username)
    if (match && match.username) {
      callback(match.username, match.password || '')
      return
    }
    callback()
  })
}

export function parseProxyString(
  rawInput: string,
  defaultProtocol: 'http' | 'socks5' = 'http'
): Omit<ProxyEntry, 'id' | 'status'> | null {
  const s = rawInput.trim()
  if (!s) return null

  try {
    if (/^(https?|socks5):\/\//i.test(s)) {
      const u = new URL(s)
      const protocol: 'http' | 'socks5' = u.protocol.startsWith('socks') ? 'socks5' : 'http'
      const host = u.hostname
      const port = Number(u.port)
      if (!host || !port) return null
      const username = u.username ? decodeURIComponent(u.username) : undefined
      const password = u.password ? decodeURIComponent(u.password) : undefined
      return {
        raw: s,
        protocol,
        host,
        port,
        username,
        password
      }
    }

    // Format host:port:user:pass or user:pass@host:port
    if (s.includes('@')) {
      const [authPart, hostPart] = s.split('@')
      const [host, portStr] = hostPart.split(':')
      const [username, ...passRest] = authPart.split(':')
      const port = Number(portStr)
      if (!host || !port) return null
      return {
        raw: s,
        protocol: defaultProtocol,
        host,
        port,
        username,
        password: passRest.join(':')
      }
    }

    const parts = s.split(':')
    if (parts.length >= 2) {
      const host = parts[0]?.trim()
      const port = Number(parts[1]?.trim())
      if (!host || !port || isNaN(port)) return null
      const username = parts[2]?.trim() || undefined
      const rawPass = parts.length > 3 ? parts.slice(3).join(':').trim() : ''
      const password = username && rawPass ? rawPass : undefined
      const cleanRaw = username
        ? `${host}:${port}:${username}:${password || ''}`
        : `${host}:${port}`
      return {
        raw: cleanRaw,
        protocol: defaultProtocol,
        host,
        port,
        username,
        password
      }
    }
  } catch {}
  return null
}

let fallbackRotCursor = 0

export function formatAccountProxyLabel(proxyId?: string): string {
  if (!proxyId) return 'Trực tiếp (Chưa gắn Proxy)'
  if (proxyId.startsWith('rot:')) {
    const rotId = proxyId.slice(4)
    const rot = store.getRotatingProxies().find((r) => r.id === rotId)
    if (!rot) return 'Key xoay (Đã xoá)'
    const ipPart = rot.currentProxy
      ? rot.currentProxy.split(':').slice(0, 2).join(':')
      : rot.exitIp || `proxyvn:${rot.apiKey.slice(0, 8)}…`
    return `${rot.name} · ${ipPart}`
  }
  const px = store.getProxies().find((p) => p.id === proxyId)
  if (!px) return 'Proxy tĩnh (Đã xoá)'
  return `${px.label || px.protocol.toUpperCase()} · ${px.host}:${px.port}`
}

export function ensureAccountHasLiveProxy(
  accountId: string,
  busyProxyIds?: ReadonlySet<string>
): {
  proxyId?: string
  proxyLabel: string
} {
  const acc = store.getAccountById(accountId)
  if (!acc) return { proxyLabel: 'Trực tiếp' }

  const allRot = store.getRotatingProxies()
  const liveRot = allRot.filter((r) => r.status !== 'expired')
  const candidateRot = liveRot.length > 0 ? liveRot : allRot
  const liveStatic = store.getProxies().filter((p) => p.status !== 'dead')

  let validCurrent = false
  if (acc.proxyId) {
    if (acc.proxyId.startsWith('rot:')) {
      const rot = allRot.find((r) => r.id === acc.proxyId!.slice(4))
      if (rot && rot.status !== 'expired') {
        validCurrent = true
      }
    } else {
      const px = liveStatic.find((p) => p.id === acc.proxyId)
      if (px) validCurrent = true
    }
  }

  const isBusyCollision = Boolean(
    validCurrent && acc.proxyId && busyProxyIds && busyProxyIds.has(acc.proxyId)
  )

  if (!validCurrent || isBusyCollision) {
    let newProxyId: string | undefined
    const freeRot = busyProxyIds
      ? candidateRot.filter((r) => !busyProxyIds.has(`rot:${r.id}`))
      : candidateRot
    const poolRot = freeRot.length > 0 ? freeRot : candidateRot

    if (poolRot.length > 0) {
      // Only switch if !validCurrent OR we actually found a free non-colliding proxy
      if (!validCurrent || freeRot.length > 0) {
        const chosen = poolRot[fallbackRotCursor % poolRot.length]
        fallbackRotCursor++
        newProxyId = `rot:${chosen.id}`
      }
    } else if (!validCurrent && liveStatic.length > 0) {
      const chosen = liveStatic[fallbackRotCursor % liveStatic.length]
      fallbackRotCursor++
      newProxyId = chosen.id
    }
    if (newProxyId && newProxyId !== acc.proxyId) {
      store.updateAccount(acc.id, { proxyId: newProxyId })
      return { proxyId: newProxyId, proxyLabel: formatAccountProxyLabel(newProxyId) }
    }
  }

  return {
    proxyId: acc.proxyId,
    proxyLabel: formatAccountProxyLabel(acc.proxyId)
  }
}

export async function applyProxyToPartition(
  partition: string,
  proxyId?: string
): Promise<{
  ok: boolean
  desc: string
  proxyId?: string
  proxyLabel?: string
  proxyUrl?: string
  error?: string
}> {
  registerProxyAuthHandler()
  const ses = session.fromPartition(partition)

  // Find owning account if any so we can auto-assign or failover its proxyId
  const ownerAcc = store.getAccounts().find((a) => a.partition === partition)
  let effectiveProxyId = proxyId || ownerAcc?.proxyId

  // If no proxyId is set on this account/partition, auto-assign a live rotating proxy if available
  if (!effectiveProxyId) {
    const liveRot = store.getRotatingProxies().filter((r) => r.status !== 'expired')
    if (liveRot.length > 0) {
      const chosen = liveRot[fallbackRotCursor % liveRot.length]
      fallbackRotCursor++
      effectiveProxyId = `rot:${chosen.id}`
      if (ownerAcc) {
        store.updateAccount(ownerAcc.id, { proxyId: effectiveProxyId })
      }
    }
  }

  if (!effectiveProxyId) {
    partitionCredentials.delete(partition)
    await ses.setProxy({ mode: 'direct' })
    return {
      ok: true,
      desc: 'Mạng trực tiếp (Direct)',
      proxyLabel: 'Trực tiếp (Direct)'
    }
  }

  let targetProxy: {
    protocol: 'http' | 'socks5'
    host: string
    port: number
    username?: string
    password?: string
  } | null = null
  let activeLabel = formatAccountProxyLabel(effectiveProxyId)

  if (effectiveProxyId.startsWith('rot:')) {
    const rotId = effectiveProxyId.slice(4)
    let rot = store.getRotatingProxies().find((r) => r.id === rotId)
    let resolved = rot && rot.status !== 'expired' ? await resolveRotatingProxy(rot.id, false) : null

    // Auto-failover to another live rotating key if this key is expired/deleted/unreachable
    if (!resolved || !resolved.ok || !resolved.parsed) {
      const candidates = store
        .getRotatingProxies()
        .filter((r) => r.id !== rotId && r.status !== 'expired')
      for (let i = 0; i < candidates.length; i++) {
        const candidate = candidates[(fallbackRotCursor + i) % candidates.length]
        const tryRes = await resolveRotatingProxy(candidate.id, false)
        if (tryRes.ok && tryRes.parsed) {
          fallbackRotCursor += i + 1
          rot = candidate
          resolved = tryRes
          effectiveProxyId = `rot:${candidate.id}`
          if (ownerAcc) {
            store.updateAccount(ownerAcc.id, { proxyId: effectiveProxyId })
          }
          break
        }
      }
    }

    if (!resolved || !resolved.ok || !resolved.parsed || !rot) {
      partitionCredentials.delete(partition)
      await ses.setProxy({ mode: 'direct' })
      return {
        ok: true,
        desc: `Mạng trực tiếp (Tạm vượt lỗi Key xoay ${rot?.name || rotId})`,
        proxyId: effectiveProxyId,
        proxyLabel: `Trực tiếp (Bypass lỗi ${rot?.name || 'Proxy'})`
      }
    }
    targetProxy = resolved.parsed
    activeLabel = `${rot.name} · ${targetProxy.host}:${targetProxy.port}`
  } else {
    const p = store.getProxies().find((x) => x.id === effectiveProxyId)
    if (!p) {
      partitionCredentials.delete(partition)
      await ses.setProxy({ mode: 'direct' })
      return {
        ok: true,
        desc: 'Mạng trực tiếp (Proxy cũ đã xoá)',
        proxyLabel: 'Trực tiếp (Direct)'
      }
    }
    targetProxy = p
    activeLabel = `${p.label || p.protocol.toUpperCase()} · ${p.host}:${p.port}`
  }

  const proxyRules = `${targetProxy.protocol}://${targetProxy.host}:${targetProxy.port}`
  const proxyUrl = targetProxy.username
    ? `${targetProxy.protocol}://${targetProxy.username}:${targetProxy.password || ''}@${targetProxy.host}:${targetProxy.port}`
    : proxyRules
  if (targetProxy.username) {
    partitionCredentials.set(partition, {
      username: targetProxy.username,
      password: targetProxy.password || ''
    })
  } else {
    partitionCredentials.delete(partition)
  }

  await ses.setProxy({
    proxyRules,
    proxyBypassRules: '<-loopback>'
  })

  return {
    ok: true,
    desc: `${targetProxy.protocol.toUpperCase()} ${targetProxy.host}:${targetProxy.port}`,
    proxyId: effectiveProxyId,
    proxyLabel: activeLabel,
    proxyUrl
  }
}

export async function checkSingleProxy(proxyId: string): Promise<ProxyEntry | null> {
  const proxy = store.getProxies().find((p) => p.id === proxyId)
  if (!proxy) return null

  registerProxyAuthHandler()
  proxy.status = 'checking'
  store.upsertProxy(proxy)

  const tempPartition = `temp-proxy-check-${proxy.id}-${Date.now()}`
  const ses = session.fromPartition(tempPartition)

  const start = Date.now()
  try {
    if (proxy.username) {
      partitionCredentials.set(tempPartition, {
        username: proxy.username,
        password: proxy.password || ''
      })
    }
    await ses.setProxy({
      proxyRules: `${proxy.protocol}://${proxy.host}:${proxy.port}`,
      proxyBypassRules: '<-loopback>'
    })

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10000)
    const resp = await ses.fetch('https://api.ipify.org?format=json', {
      signal: controller.signal
    })
    clearTimeout(timeout)

    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`)
    }
    const data = (await resp.json()) as { ip?: string }
    const latency = Date.now() - start
    proxy.status = 'alive'
    proxy.exitIp = data.ip || proxy.host
    proxy.latencyMs = latency
    proxy.errorMessage = undefined
    proxy.lastCheckedAt = Date.now()
  } catch (err: any) {
    proxy.status = 'dead'
    proxy.latencyMs = undefined
    proxy.errorMessage =
      err?.name === 'AbortError'
        ? 'Quá thời gian chờ phản hồi (Timeout 10s)'
        : `Không kết nối được qua proxy (${err?.message || String(err)})`
    proxy.lastCheckedAt = Date.now()
  } finally {
    partitionCredentials.delete(tempPartition)
  }

  store.upsertProxy(proxy)
  return proxy
}

// A fresh TopProxy IP's first request to /chat/ took ~4.1s in testing; 5.5s rejected slow-but-fine IPs.
const PROXY_PROBE_TIMEOUT_MS = 8000
const lastProbedAliveAt = new Map<string, number>()
/** Pause before re-asking the provider API for a rotating key that just failed. */
const ROT_ERROR_RETRY_MS = 60_000
const lastResolveFailedAt = new Map<string, number>()
/** Minimum gap between two forced IP rotations of the same key. */
const MIN_FORCE_ROTATE_GAP_MS = 90_000
const lastForcedRotateAt = new Map<string, number>()

/**
 * Loads dola.com through a proxy before handing it out. TopProxy often issues IPs that reset
 * every connection; using one leaves the task stuck at "nạp chữ ký" or polling blind until it times out.
 * Returns the failure reason, or undefined when the proxy works.
 */
async function probeProxyReachesDola(proxy: Omit<ProxyEntry, 'id' | 'status'>): Promise<string | undefined> {
  registerProxyAuthHandler()
  const tempPartition = `temp-proxy-probe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const ses = session.fromPartition(tempPartition)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROXY_PROBE_TIMEOUT_MS)
  try {
    if (proxy.username) {
      partitionCredentials.set(tempPartition, { username: proxy.username, password: proxy.password || '' })
    }
    await ses.setProxy({
      proxyRules: `${proxy.protocol}://${proxy.host}:${proxy.port}`,
      proxyBypassRules: '<-loopback>'
    })
    // dola.com/ always answers 302 → /chat, and Electron's session.fetch throws "Redirect was cancelled"
    // on any redirect with redirect:'manual' — so every healthy IP was rejected and 0/8 proxies ever
    // stayed alive. /chat/ answers 200 directly.
    const resp = await ses.fetch('https://www.dola.com/chat/', { signal: controller.signal })
    return resp.status >= 500 ? `HTTP ${resp.status}` : undefined
  } catch (err: any) {
    return err?.name === 'AbortError' ? `timeout ${PROXY_PROBE_TIMEOUT_MS / 1000}s` : err?.message || String(err)
  } finally {
    clearTimeout(timer)
    partitionCredentials.delete(tempPartition)
  }
}

let cachedPublicIpv4 = ''
let cachedPublicIpv4At = 0

export async function getMachinePublicIpv4(): Promise<string> {
  if (cachedPublicIpv4 && Date.now() - cachedPublicIpv4At < 5 * 60 * 1000) {
    return cachedPublicIpv4
  }
  const urls = ['https://api.ipify.org', 'https://ipv4.icanhazip.com']
  for (const url of urls) {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 4000)
      const resp = await fetch(url, { signal: controller.signal })
      clearTimeout(timer)
      if (resp.ok) {
        const ip = (await resp.text()).trim()
        if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip)) {
          cachedPublicIpv4 = ip
          cachedPublicIpv4At = Date.now()
          return ip
        }
      }
    } catch {}
  }
  return cachedPublicIpv4
}

export function normalizeRotatingKeyInput(
  rawInput: string,
  fallbackProvider: RotatingProxyProvider = 'topproxy',
  fallbackNhamang = 'Random',
  fallbackTinhthanh = '0'
): {
  apiKey: string
  provider: RotatingProxyProvider
  nhamang: string
  tinhthanh: string
  isRotatingKeyFormat: boolean
} {
  let s = (rawInput || '').trim()
  let provider: RotatingProxyProvider = fallbackProvider
  let nhamang = fallbackNhamang || 'Random'
  let tinhthanh = fallbackTinhthanh || '0'
  let isRotatingKeyFormat = false

  if (/proxyxoay\.shop\/api\/get\.php/i.test(s)) {
    provider = 'topproxy'
    isRotatingKeyFormat = true
    const mKey = /[?&]key=([^&#\s]+)/i.exec(s)
    if (mKey && mKey[1]) s = decodeURIComponent(mKey[1])
    const mIsp = /[?&]nhamang=([^&#\s]+)/i.exec(s)
    if (mIsp && mIsp[1]) nhamang = decodeURIComponent(mIsp[1])
    const mProv = /[?&]tinhthanh=([^&#\s]+)/i.exec(s)
    if (mProv && mProv[1]) tinhthanh = decodeURIComponent(mProv[1])
    return { apiKey: s.trim(), provider, nhamang, tinhthanh, isRotatingKeyFormat }
  }

  const mPrefix = /^(proxyvn|topproxy|proxyxoay|tmproxy|kiotproxy|wwproxy|tinsoft)(?::\/\/|:)(.+)$/i.exec(
    s
  )
  if (mPrefix) {
    isRotatingKeyFormat = true
    const pName = mPrefix[1].toLowerCase()
    if (pName === 'proxyvn' || pName === 'topproxy' || pName === 'proxyxoay') {
      provider = 'topproxy'
    } else if (
      pName === 'tmproxy' ||
      pName === 'kiotproxy' ||
      pName === 'wwproxy' ||
      pName === 'tinsoft'
    ) {
      provider = pName as RotatingProxyProvider
    }
    let rest = mPrefix[2].trim()
    let optPart = ''
    if (rest.includes('@')) {
      const idx = rest.indexOf('@')
      optPart = rest.slice(idx + 1)
      rest = rest.slice(0, idx)
    } else if (rest.includes('?')) {
      const idx = rest.indexOf('?')
      optPart = rest.slice(idx + 1)
      rest = rest.slice(0, idx)
    }
    if (optPart) {
      for (const token of optPart.split(/[,&]/)) {
        const [k, v] = token.split('=')
        if (!k || v === undefined) continue
        const keyLower = k.trim().toLowerCase()
        const valClean = decodeURIComponent(v.trim())
        if (keyLower === 'nhamang' && valClean) nhamang = valClean
        if (keyLower === 'tinhthanh' && valClean) tinhthanh = valClean
      }
    }
    s = rest.trim()
  }

  return {
    apiKey: s,
    provider,
    nhamang,
    tinhthanh,
    isRotatingKeyFormat
  }
}

export async function resolveRotatingProxy(
  id: string,
  forceRotate = false
): Promise<{
  ok: boolean
  entry?: RotatingProxyEntry
  parsed?: Omit<ProxyEntry, 'id' | 'status'>
  error?: string
}> {
  const entry = store.getRotatingProxies().find((r) => r.id === id)
  if (!entry) {
    return { ok: false, error: 'Không tìm thấy key xoay này (có thể đã bị xoá).' }
  }

  // Every Dola overload (710022002) / proxy hiccup forced a new IP from the provider API; in a burst that
  // is dozens of calls a minute and got this machine IP-banned by TopProxy. Forced rotation is rate-limited
  // per key; inside the gap the current IP is reused if it still reaches Dola (dead IPs still get replaced).
  if (forceRotate) {
    const lastForced = lastForcedRotateAt.get(id) || 0
    if (Date.now() - lastForced < MIN_FORCE_ROTATE_GAP_MS) {
      forceRotate = false
    } else {
      lastForcedRotateAt.set(id, Date.now())
    }
  }

  // Normalize key if it was saved with a prefix like proxyvn:KEY
  const normalized = normalizeRotatingKeyInput(
    entry.apiKey,
    entry.provider,
    entry.nhamang || 'Random',
    entry.tinhthanh || '0'
  )
  if (normalized.isRotatingKeyFormat && normalized.apiKey !== entry.apiKey) {
    entry.apiKey = normalized.apiKey
    entry.provider = normalized.provider
    if (normalized.provider === 'topproxy') {
      entry.nhamang = normalized.nhamang
      entry.tinhthanh = normalized.tinhthanh
    }
    store.upsertRotatingProxy(entry)
  }

  // Keep current active proxy IP:port until shortly before its TTL ends (max 60 min) unless forceRotate=true,
  // and never rotate a shared rotating proxy key if another active task is currently mid-render on it!
  if (entry.currentProxy && entry.status !== 'expired' && entry.status !== 'error') {
    const parsed = parseProxyString(entry.currentProxy, entry.protocol)
    if (parsed) {
      const ageMs = entry.lastRotatedAt ? Date.now() - entry.lastRotatedAt : 0
      let shouldKeepCurrent = !forceRotate && ageMs < proxyKeepMs(entry.statusMessage)
      if (!shouldKeepCurrent && forceRotate && ageMs < 180_000) {
        const rotKeyTag = `rot:${id}`
        const accountsOnKey = new Set(
          store
            .getAccounts()
            .filter((a) => a.proxyId === rotKeyTag)
            .map((a) => a.id)
        )
        const activeTasksOnKey = store
          .getTasks()
          .filter(
            (t) =>
              t.assignedAccountId &&
              accountsOnKey.has(t.assignedAccountId) &&
              (t.status === 'submitting' || t.status === 'polling' || t.status === 'downloading')
          )
        if (activeTasksOnKey.length > 0) {
          shouldKeepCurrent = true
        }
      }
      if (shouldKeepCurrent) {
        const lastOkAt = lastProbedAliveAt.get(parsed.raw) || 0
        if (Date.now() - lastOkAt < 20_000) {
          return { ok: true, entry, parsed }
        }
        const probeErr = await probeProxyReachesDola(parsed)
        if (!probeErr) {
          lastProbedAliveAt.set(parsed.raw, Date.now())
          return { ok: true, entry, parsed }
        }
        // Cached IP died (ERR_CONNECTION_RESET / timeout) — clear it and rotate immediately
        lastProbedAliveAt.delete(parsed.raw)
        entry.currentProxy = undefined
      }
    }
  }

  // A key that just failed is asked again only after a pause: every account login used to re-hit the provider
  // API for every failing key, and that burst got the machine's IP banned by TopProxy (403).
  const failedAt = lastResolveFailedAt.get(id) || 0
  if (entry.status === 'error' && Date.now() - failedAt < ROT_ERROR_RETRY_MS) {
    return { ok: false, entry, error: entry.statusMessage || 'Key xoay đang lỗi — đang chờ thử lại.' }
  }

  entry.status = 'checking'
  store.upsertRotatingProxy(entry)

  try {
    let rawProxy = ''
    let exitIp = ''
    let cooldownMsg = ''
    let extraMeta = ''

    const isTopProxyUrl = /proxyxoay\.shop|topproxy\.vn/i.test(entry.apiKey || entry.customApiUrl || '')
    if (entry.provider === 'topproxy' || isTopProxyUrl) {
      let endpoint = ''
      const trimmedKey = (entry.apiKey || '').trim()
      const nhamang = (entry.nhamang || 'Random').trim()
      const tinhthanh = (entry.tinhthanh || '0').trim()
      const publicIpv4 = await getMachinePublicIpv4()

      if (/^https?:\/\//i.test(trimmedKey)) {
        endpoint = trimmedKey
        if (publicIpv4 && !/[?&]whitelist=/i.test(endpoint)) {
          endpoint += `${endpoint.includes('?') ? '&' : '?'}whitelist=${encodeURIComponent(publicIpv4)}`
        }
      } else {
        // Extract key if user pasted query string like key=xyz
        const mKey = /[?&]key=([^&#\s]+)/i.exec(trimmedKey)
        const cleanKey = mKey ? decodeURIComponent(mKey[1]) : trimmedKey
        const wlParam = publicIpv4 ? `&whitelist=${encodeURIComponent(publicIpv4)}` : ''
        endpoint = `https://proxyxoay.shop/api/get.php?key=${encodeURIComponent(cleanKey)}&nhamang=${encodeURIComponent(nhamang)}&tinhthanh=${encodeURIComponent(tinhthanh)}${wlParam}`
      }

      const fetchTopProxy = async (): Promise<any> => {
        const resp = await fetch(endpoint)
        if (resp.status === 403) {
          throw new Error(
            'TopProxy chặn IP máy này (403 Forbidden) — đợi vài phút hoặc liên hệ TopProxy gỡ chặn / whitelist IP.'
          )
        }
        const text = (await resp.text()).trim()
        try {
          return JSON.parse(text)
        } catch {
          // Sometimes PHP outputs multiple JSON blocks or warnings; grab the first JSON object
          const mObj = /\{[\s\S]*?\}/.exec(text)
          try {
            return mObj ? JSON.parse(mObj[0]) : {}
          } catch {
            return {}
          }
        }
      }
      let json: any = await fetchTopProxy()
      // No IP to fall back on and TopProxy says "Con 42s moi co the doi proxy": wait it out once
      // instead of marking the key dead (which made every login on it fail until a manual retry).
      const waitSec = entry.currentProxy ? 0 : rotateCooldownSec(String(json?.message || json?.comen || ''))
      if (Number(json?.status) !== 100 && waitSec > 0) {
        entry.statusMessage = `Đang chờ TopProxy cấp IP mới (${waitSec}s)…`
        store.upsertRotatingProxy(entry)
        await new Promise((r) => setTimeout(r, (waitSec + 1) * 1000))
        json = await fetchTopProxy()
      }

      const status = Number(json?.status)
      const candidateRaw =
        (entry.protocol === 'socks5'
          ? json?.proxysocks5 || json?.proxyhttp
          : json?.proxyhttp || json?.proxysocks5) ||
        json?.proxy ||
        ''

      if (status === 100 && candidateRaw) {
        rawProxy = String(candidateRaw).replace(/:+$/, '').trim()
        if (json['Nha Mang']) entry.isp = String(json['Nha Mang'])
        if (json['Vi Tri']) entry.location = String(json['Vi Tri'])
        if (json['Token expiration date']) {
          entry.tokenExpiration = String(json['Token expiration date'])
        }
        const mTtl = /(\d+)\s*s/i.exec(String(json?.message || ''))
        const partsMeta = [
          entry.isp ? entry.isp.toUpperCase() : '',
          entry.location || '',
          mTtl ? `TTL ${mTtl[1]}s` : '',
          entry.tokenExpiration ? `HSD: ${entry.tokenExpiration}` : ''
        ].filter(Boolean)
        if (partsMeta.length > 0) {
          extraMeta = ` · ${partsMeta.join(' · ')}`
        }
      } else if (status === 102 || /khong ton tai|does not exist|het han|expired/i.test(String(json?.message || json?.comen || ''))) {
        throw new Error(
          `TopProxy hết hạn / key không tồn tại (${json?.message || json?.comen || `status=${status}`})`
        )
      } else {
        // Status 101 or rotation cooldown: keep existing proxy if available!
        const msg = String(json?.message || json?.comen || `status=${status || 'unknown'}`)
        // Check if message itself embeds an ip:port
        const mEmbeddedIp = /(\d{1,3}(?:\.\d{1,3}){3}:\d{2,5}(?::[^\s"']*)?)/.exec(msg)
        if (mEmbeddedIp) {
          rawProxy = mEmbeddedIp[1].replace(/:+$/, '')
          cooldownMsg = `Đang chờ xoay (${msg}) — dùng IP: ${rawProxy}`
        } else if (entry.currentProxy) {
          rawProxy = entry.currentProxy
          cooldownMsg = `Chưa tới hạn đổi IP (${msg}) — giữ IP hiện tại (${rawProxy})`
        } else {
          throw new Error(`TopProxy: ${msg}`)
        }
      }
    } else if (entry.provider === 'tmproxy') {
      const endpoint = forceRotate
        ? 'https://tmproxy.com/api/proxy/get-new-proxy'
        : 'https://tmproxy.com/api/proxy/get-current-proxy'
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: entry.apiKey })
      })
      const json = (await resp.json()) as any
      const data = json?.data || {}
      rawProxy = entry.protocol === 'socks5' ? data.socks5 : data.https
      exitIp = data.public_ip || ''
      if (!rawProxy && forceRotate) {
        // Fallback to get-current-proxy when in cooldown
        const curResp = await fetch('https://tmproxy.com/api/proxy/get-current-proxy', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ api_key: entry.apiKey })
        })
        const curJson = (await curResp.json()) as any
        const curData = curJson?.data || {}
        rawProxy = entry.protocol === 'socks5' ? curData.socks5 : curData.https
        exitIp = curData.public_ip || ''
        if (rawProxy && json?.message) {
          cooldownMsg = `Chưa tới hạn xoay IP (${json.message}) — đang dùng IP hiện tại.`
        }
      }
      if (!rawProxy && entry.currentProxy) {
        rawProxy = entry.currentProxy
        cooldownMsg = `Chưa tới hạn xoay IP (${json?.message || 'cooldown'}) — giữ IP hiện tại.`
      }
      if (!rawProxy) {
        throw new Error(json?.message || 'TMProxy không trả về địa chỉ hợp lệ.')
      }
    } else if (entry.provider === 'kiotproxy') {
      const region = 'random'
      const endpoint = forceRotate
        ? `https://api.kiotproxy.com/api/v1/proxies/new?key=${encodeURIComponent(entry.apiKey)}&region=${region}`
        : `https://api.kiotproxy.com/api/v1/proxies/current?key=${encodeURIComponent(entry.apiKey)}`
      const resp = await fetch(endpoint)
      const json = (await resp.json()) as any
      const data = json?.data || {}
      rawProxy = entry.protocol === 'socks5' ? data.socks5 : data.http
      exitIp = data.realIpAddress || ''
      if (!rawProxy && forceRotate) {
        const curResp = await fetch(
          `https://api.kiotproxy.com/api/v1/proxies/current?key=${encodeURIComponent(entry.apiKey)}`
        )
        const curJson = (await curResp.json()) as any
        const curData = curJson?.data || {}
        rawProxy = entry.protocol === 'socks5' ? curData.socks5 : curData.http
        exitIp = curData.realIpAddress || ''
        if (rawProxy) cooldownMsg = 'Đang trong thời gian chờ xoay — giữ IP hiện tại.'
      }
      if (!rawProxy && entry.currentProxy) {
        rawProxy = entry.currentProxy
        cooldownMsg = 'Đang trong thời gian chờ xoay — giữ IP hiện tại.'
      }
      if (!rawProxy) {
        throw new Error(json?.message || 'KiotProxy không trả về địa chỉ hợp lệ.')
      }
    } else if (entry.provider === 'wwproxy') {
      const endpoint = forceRotate
        ? `https://wwproxy.com/api/client/proxy/available?key=${encodeURIComponent(entry.apiKey)}&provinceId=-1`
        : `https://wwproxy.com/api/client/proxy/current?key=${encodeURIComponent(entry.apiKey)}`
      const resp = await fetch(endpoint)
      const json = (await resp.json()) as any
      const data = json?.data || {}
      rawProxy = data.proxy || ''
      exitIp = data.ip || ''
      if (!rawProxy && forceRotate) {
        const curResp = await fetch(
          `https://wwproxy.com/api/client/proxy/current?key=${encodeURIComponent(entry.apiKey)}`
        )
        const curJson = (await curResp.json()) as any
        rawProxy = curJson?.data?.proxy || ''
        exitIp = curJson?.data?.ip || ''
        if (rawProxy) cooldownMsg = 'Đang trong thời gian chờ xoay — giữ IP hiện tại.'
      }
      if (!rawProxy && entry.currentProxy) {
        rawProxy = entry.currentProxy
        cooldownMsg = 'Đang trong thời gian chờ xoay — giữ IP hiện tại.'
      }
      if (!rawProxy) {
        throw new Error(json?.message || 'WWProxy không trả về địa chỉ hợp lệ.')
      }
    } else if (entry.provider === 'tinsoft') {
      const endpoint = forceRotate
        ? `http://proxy.tinsoftsv.com/api/changeProxy.php?key=${encodeURIComponent(entry.apiKey)}`
        : `http://proxy.tinsoftsv.com/api/getProxy.php?key=${encodeURIComponent(entry.apiKey)}`
      const resp = await fetch(endpoint)
      const json = (await resp.json()) as any
      rawProxy = json?.proxy || ''
      if (!rawProxy && forceRotate) {
        const curResp = await fetch(
          `http://proxy.tinsoftsv.com/api/getProxy.php?key=${encodeURIComponent(entry.apiKey)}`
        )
        const curJson = (await curResp.json()) as any
        rawProxy = curJson?.proxy || ''
        if (rawProxy) cooldownMsg = json?.description || 'Chưa tới hạn xoay IP — giữ IP hiện tại.'
      }
      if (!rawProxy && entry.currentProxy) {
        rawProxy = entry.currentProxy
        cooldownMsg = json?.description || 'Chưa tới hạn xoay IP — giữ IP hiện tại.'
      }
      if (!rawProxy) {
        throw new Error(json?.description || 'Tinsoft không trả về địa chỉ hợp lệ.')
      }
    } else {
      // Custom URL or direct host:port key
      const directParsed = parseProxyString(entry.apiKey, entry.protocol)
      if (directParsed) {
        rawProxy = entry.apiKey
      } else {
        const url = entry.customApiUrl
          ? entry.customApiUrl.replace('{key}', encodeURIComponent(entry.apiKey))
          : entry.apiKey
        const resp = await fetch(url)
        const text = (await resp.text()).trim()
        try {
          const j = JSON.parse(text)
          rawProxy =
            (entry.protocol === 'socks5'
              ? j?.proxysocks5 || j?.data?.socks5
              : j?.proxyhttp || j?.data?.http || j?.data?.https) ||
            j?.proxy ||
            j?.data?.proxy ||
            j?.http ||
            text
        } catch {
          rawProxy = text
        }
      }
    }

    const parsed = parseProxyString(rawProxy, entry.protocol)
    if (!parsed) {
      throw new Error(`Proxy xoay trả về địa chỉ không hợp lệ: "${rawProxy.slice(0, 80)}"`)
    }

    // A dead IP throws → key marked 'error' → applyProxyToPartition fails over to another live key,
    // and the next resolve of this key asks TopProxy for a new IP.
    const probeError = await probeProxyReachesDola(parsed)
    if (probeError) {
      lastProbedAliveAt.delete(parsed.raw)
      entry.currentProxy = undefined
      throw new Error(`IP mới ${parsed.host}:${parsed.port} không vào được Dola (${probeError}) — sẽ xin IP khác`)
    }

    lastProbedAliveAt.set(parsed.raw, Date.now())
    entry.currentProxy = parsed.raw
    entry.exitIp = exitIp || parsed.host
    entry.status = cooldownMsg ? 'cooldown' : 'active'
    entry.statusMessage =
      cooldownMsg || `Hoạt động (${parsed.host}:${parsed.port}${extraMeta})`
    entry.lastRotatedAt = Date.now()
    store.upsertRotatingProxy(entry)

    return { ok: true, entry, parsed }
  } catch (err: any) {
    const msg = err?.message || String(err)
    entry.status = /hết hạn|expired|không tồn tại|does not exist/i.test(msg) ? 'expired' : 'error'
    entry.statusMessage = msg
    lastResolveFailedAt.set(id, Date.now())
    store.upsertRotatingProxy(entry)
    return { ok: false, entry, error: msg }
  }
}

/**
 * Batch add multiple rotating proxy keys (1 per line) and resolve their initial IP concurrently.
 */
export async function createRotatingProxiesBatch(payload: {
  rawKeys: string
  provider: RotatingProxyProvider
  protocol: 'http' | 'socks5'
  namePrefix?: string
  nhamang?: string
  tinhthanh?: string
}): Promise<{ added: number; skipped: number; entries: RotatingProxyEntry[] }> {
  const lines = (payload.rawKeys || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)

  const existingSnapshot = [...store.getRotatingProxies()]
  const addedEntries: RotatingProxyEntry[] = []
  let skipped = 0

  for (const line of lines) {
    const norm = normalizeRotatingKeyInput(
      line,
      payload.provider,
      payload.nhamang || 'Random',
      payload.tinhthanh || '0'
    )
    const apiKey = norm.apiKey
    const detectedProvider = norm.provider
    const nhamang = norm.nhamang
    const tinhthanh = norm.tinhthanh

    if (!apiKey) {
      skipped++
      continue
    }

    if (
      existingSnapshot.some((r) => r.apiKey === apiKey) ||
      addedEntries.some((r) => r.apiKey === apiKey)
    ) {
      skipped++
      continue
    }

    const idx = existingSnapshot.length + addedEntries.length + 1
    const prefix = (payload.namePrefix || detectedProvider.toUpperCase()).trim()
    const entry: RotatingProxyEntry = {
      id: `rot-${crypto.randomUUID().slice(0, 8)}`,
      name: lines.length === 1 && payload.namePrefix ? payload.namePrefix.trim() : `${prefix} #${idx}`,
      provider: detectedProvider,
      apiKey,
      nhamang: detectedProvider === 'topproxy' ? nhamang : undefined,
      tinhthanh: detectedProvider === 'topproxy' ? tinhthanh : undefined,
      protocol: payload.protocol,
      status: 'unknown'
    }
    store.upsertRotatingProxy(entry)
    addedEntries.push(entry)
  }

  // Resolve all newly added keys in parallel (up to 5 at a time)
  let cursor = 0
  const workers = Array.from({ length: Math.min(5, addedEntries.length) }, async () => {
    while (cursor < addedEntries.length) {
      const item = addedEntries[cursor++]
      await resolveRotatingProxy(item.id, false)
    }
  })
  await Promise.all(workers)

  return {
    added: addedEntries.length,
    skipped,
    entries: store.getRotatingProxies()
  }
}

/**
 * Sync rotating keys (`apigetkeyxoay.php`) and/or static proxies (`apiv2/listproxy.php`)
 * directly from a TopProxy.vn master account API key.
 */
export async function syncTopProxyAccount(payload: {
  accountApiKey: string
  protocol: 'http' | 'socks5'
  nhamang?: string
  tinhthanh?: string
  syncRotating?: boolean
  syncStaticType?: string // e.g., 'all' | 'Viettel' | 'FPT' | 'VNPT' | '4Gvinaphone' | 'US' | ''
}): Promise<{
  ok: boolean
  rotatingAdded: number
  staticAdded: number
  message: string
}> {
  const masterKey = (payload.accountApiKey || '').trim()
  if (!masterKey) {
    return {
      ok: false,
      rotatingAdded: 0,
      staticAdded: 0,
      message: 'Vui lòng nhập API Key tài khoản TopProxy.vn.'
    }
  }

  let rotatingAdded = 0
  let staticAdded = 0
  const errors: string[] = []

  // Helper to parse TopProxy's concatenated JSON objects: {...}{...}
  const parseConcatenatedJson = (rawText: string): any[] => {
    const out: any[] = []
    const trimmed = (rawText || '').trim()
    if (!trimmed) return out
    try {
      const direct = JSON.parse(trimmed)
      if (Array.isArray(direct)) return direct
      if (direct && typeof direct === 'object') return [direct]
    } catch {}
    const matches = trimmed.match(/\{[^{}]*\}/g) || []
    for (const m of matches) {
      try {
        out.push(JSON.parse(m))
      } catch {}
    }
    return out
  }

  // 1. Fetch active rotating keys via https://topproxy.vn/proxyxoay/apigetkeyxoay.php?key=[key]
  if (payload.syncRotating !== false) {
    try {
      const url = `https://topproxy.vn/proxyxoay/apigetkeyxoay.php?key=${encodeURIComponent(masterKey)}`
      const resp = await fetch(url)
      const text = await resp.text()
      const items = parseConcatenatedJson(text)
      const existing = store.getRotatingProxies()
      const newIds: string[] = []

      for (const item of items) {
        if (Number(item?.status) === 100 && item?.keyxoay) {
          const k = String(item.keyxoay).trim()
          if (!k) continue
          const existingEntry = existing.find((r) => r.apiKey === k)
          if (existingEntry) {
            if (item.expired) {
              existingEntry.tokenExpiration = String(item.expired)
              store.upsertRotatingProxy(existingEntry)
            }
            continue
          }
          const id = `rot-${crypto.randomUUID().slice(0, 8)}`
          const entry: RotatingProxyEntry = {
            id,
            name: `TopProxy #${existing.length + newIds.length + 1}`,
            provider: 'topproxy',
            apiKey: k,
            nhamang: payload.nhamang || 'Random',
            tinhthanh: payload.tinhthanh || '0',
            tokenExpiration: item.expired ? String(item.expired) : undefined,
            protocol: payload.protocol || 'http',
            status: 'unknown',
            statusMessage: item.expired ? `HSD: ${item.expired}` : 'Vừa đồng bộ từ TopProxy.vn'
          }
          store.upsertRotatingProxy(entry)
          newIds.push(id)
          rotatingAdded++
        } else if (Number(item?.status) === 101 && items.length === 1) {
          errors.push(`Key xoay: ${item?.comen || 'Không tìm thấy key xoay hoặc sai API key'}`)
        }
      }

      // Resolve newly added rotating keys
      for (const id of newIds) {
        await resolveRotatingProxy(id, false)
      }
    } catch (err: any) {
      errors.push(`Lỗi đồng bộ key xoay: ${err?.message || String(err)}`)
    }
  }

  // 2. Optionally fetch static proxies via https://topproxy.vn/apiv2/listproxy.php
  if (payload.syncStaticType) {
    const typesToFetch =
      payload.syncStaticType === 'all'
        ? ['Viettel', 'FPT', 'VNPT', '4Gvinaphone', 'US', 'DatacenterA', 'DatacenterB', 'DatacenterC', 'GoiViettel', 'GoiVNPT', 'GoiFPT', 'GoiDATACENTER']
        : [payload.syncStaticType]

    const existingStatic = store.getProxies()
    for (const loai of typesToFetch) {
      try {
        const url = `https://topproxy.vn/apiv2/listproxy.php?loaiproxy=${encodeURIComponent(loai)}&key=${encodeURIComponent(masterKey)}&idproxy=all`
        const resp = await fetch(url)
        const text = await resp.text()
        const items = parseConcatenatedJson(text)
        for (const item of items) {
          if (Number(item?.status) === 100 && item?.proxy) {
            const proto: 'http' | 'socks5' = /socks/i.test(String(item.type || ''))
              ? 'socks5'
              : payload.protocol || 'http'
            const parsed = parseProxyString(String(item.proxy), proto)
            if (!parsed) continue
            const dup = existingStatic.some(
              (p) => p.host === parsed.host && p.port === parsed.port && p.username === parsed.username
            )
            if (dup) continue
            const created: ProxyEntry = {
              id: `px-${crypto.randomUUID().slice(0, 8)}`,
              ...parsed,
              label: `TopProxy ${loai}${item.idproxy ? ` #${item.idproxy}` : ''}`,
              status: 'unknown'
            }
            store.upsertProxy(created)
            existingStatic.push(created)
            staticAdded++
          }
        }
      } catch {}
    }
  }

  if (rotatingAdded === 0 && staticAdded === 0 && errors.length > 0) {
    return {
      ok: false,
      rotatingAdded: 0,
      staticAdded: 0,
      message: errors.join(' | ')
    }
  }

  return {
    ok: true,
    rotatingAdded,
    staticAdded,
    message: `Đồng bộ TopProxy.vn hoàn tất: +${rotatingAdded} key xoay, +${staticAdded} proxy tĩnh.`
  }
}

export function autoPairProxiesToAccounts(options?: {
  poolId?: string
  mode?: '1_to_1' | '1_per_pool'
}): { pairedCount: number; message: string } {
  const allEnabled = store.getAccounts().filter((a) => a.enabled)
  const targetPoolId = options?.poolId && options.poolId !== 'all' ? options.poolId : undefined
  const accounts = targetPoolId
    ? allEnabled.filter((a) => (a.poolId || 'pool-default') === targetPoolId)
    : allEnabled

  if (accounts.length === 0) {
    return { pairedCount: 0, message: 'Chưa có tài khoản nào đang bật trong kho đã chọn để ghép proxy.' }
  }

  const rotKeys = store.getRotatingProxies().filter((r) => r.status !== 'expired')
  const staticProxies = store.getProxies().filter((p) => p.status !== 'dead')

  const proxyIds: string[] = [
    ...rotKeys.map((r) => `rot:${r.id}`),
    ...staticProxies.map((p) => p.id)
  ]

  if (proxyIds.length === 0) {
    return { pairedCount: 0, message: 'Chưa có proxy sống hoặc key xoay nào trong danh sách.' }
  }

  if (options?.mode === '1_per_pool') {
    const pools = store.getAccountPools()
    let paired = 0
    pools.forEach((pool, poolIdx) => {
      const assignedProxyId = proxyIds[poolIdx % proxyIds.length]
      const poolAccs = allEnabled.filter((a) => (a.poolId || 'pool-default') === pool.id)
      for (const acc of poolAccs) {
        store.updateAccount(acc.id, { proxyId: assignedProxyId })
        paired++
      }
    })
    return {
      pairedCount: paired,
      message: `Đã gán mỗi Kho Tài Khoản (${pools.length} kho) 1 Proxy/Key xoay cố định cho tổng cộng ${paired} tài khoản!`
    }
  }

  let paired = 0
  accounts.forEach((acc, idx) => {
    const targetProxyId = proxyIds[idx % proxyIds.length]
    store.updateAccount(acc.id, { proxyId: targetProxyId })
    paired++
  })

  return {
    pairedCount: paired,
    message: `Đã ghép tự động ${paired} tài khoản với ${proxyIds.length} proxy/key xoay.`
  }
}

export function createStaticProxiesFromText(
  rawLines: string,
  protocol: 'http' | 'socks5' = 'http'
): { added: number; skipped: number } {
  const existing = store.getProxies()
  let added = 0
  let skipped = 0
  const rotatingRedirectIds: string[] = []

  const lines = rawLines
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)

  for (const line of lines) {
    // Support pasting proxyvn:KEY or topproxy:KEY into the static box as well
    const norm = normalizeRotatingKeyInput(line, 'topproxy', 'Random', '0')
    if (norm.isRotatingKeyFormat && norm.apiKey) {
      const existingRot = store.getRotatingProxies()
      if (existingRot.some((r) => r.apiKey === norm.apiKey)) {
        skipped++
        continue
      }
      const rotEntry: RotatingProxyEntry = {
        id: `rot-${crypto.randomUUID().slice(0, 8)}`,
        name: `TopProxy #${existingRot.length + 1}`,
        provider: norm.provider,
        apiKey: norm.apiKey,
        nhamang: norm.provider === 'topproxy' ? norm.nhamang : undefined,
        tinhthanh: norm.provider === 'topproxy' ? norm.tinhthanh : undefined,
        protocol,
        status: 'unknown'
      }
      store.upsertRotatingProxy(rotEntry)
      rotatingRedirectIds.push(rotEntry.id)
      added++
      continue
    }

    const parsed = parseProxyString(line, protocol)
    if (!parsed) {
      skipped++
      continue
    }
    const dup = existing.some(
      (p) => p.host === parsed.host && p.port === parsed.port && p.username === parsed.username
    )
    if (dup) {
      skipped++
      continue
    }
    store.upsertProxy({
      id: `px-${crypto.randomUUID().slice(0, 8)}`,
      ...parsed,
      status: 'unknown'
    })
    added++
  }

  if (rotatingRedirectIds.length > 0) {
    void (async () => {
      for (const id of rotatingRedirectIds) {
        await resolveRotatingProxy(id, false)
      }
    })()
  }

  return { added, skipped }
}

export const KNOWN_EXPIRED_ROTATING_KEYS = new Set([
  'axoJvPQYnkrqlwxzpOiHgW',
  'CcrfOjfasQvDxCuXQRZFFv',
  'DKCqKAaNaquBXMHostgFyp',
  'EUZnYrbRApIPgzzalwzsrU',
  'hDHiqvAdnWXznbghfrqFjH',
  'lbyxiogRupPlWKByONFxmG',
  'MwwlZnFZfAsOakXNxlrdLm',
  'ozbOBLueYAphonAXIJLaGD'
])

// Key proxy xoay thật nằm ở local-seed/rotating-keys.json (gitignore). Thiếu file → không seed key nào.
const localRotatingKeys = import.meta.glob<string[]>('./local-seed/rotating-keys.json', {
  eager: true,
  import: 'default'
})
const DEFAULT_USER_ROTATING_KEYS: string[] = localRotatingKeys['./local-seed/rotating-keys.json'] ?? []

export async function seedUserDefaultRotatingProxies(
  onProgress?: () => void
): Promise<void> {
  // First normalize any existing rotating proxy entries that may have been saved with "proxyvn:" prefix
  const currentList = [...store.getRotatingProxies()]
  const seenKeys = new Set<string>()
  for (const item of currentList) {
    const norm = normalizeRotatingKeyInput(
      item.apiKey,
      item.provider,
      item.nhamang || 'Random',
      item.tinhthanh || '0'
    )
    if (KNOWN_EXPIRED_ROTATING_KEYS.has(norm.apiKey) || seenKeys.has(norm.apiKey)) {
      store.deleteRotatingProxy(item.id)
      continue
    }
    seenKeys.add(norm.apiKey)
    if (norm.apiKey !== item.apiKey) {
      item.apiKey = norm.apiKey
      item.provider = norm.provider
      item.nhamang = norm.nhamang
      item.tinhthanh = norm.tinhthanh
      store.upsertRotatingProxy(item)
    }
  }

  // Add any missing keys from the 8 live user keys
  const missingRawLines: string[] = []
  for (const raw of DEFAULT_USER_ROTATING_KEYS) {
    const norm = normalizeRotatingKeyInput(raw, 'topproxy', 'Random', '0')
    if (!seenKeys.has(norm.apiKey)) {
      missingRawLines.push(raw)
    }
  }

  if (missingRawLines.length > 0) {
    await createRotatingProxiesBatch({
      rawKeys: missingRawLines.join('\n'),
      provider: 'topproxy',
      protocol: 'http',
      namePrefix: 'TopProxy',
      nhamang: 'Random',
      tinhthanh: '0'
    })
    onProgress?.()
  }

  // Cleanly number TopProxy #1 .. #N and resolve keys that don't have a valid currentProxy yet
  const allRot = store.getRotatingProxies()
  allRot.forEach((r, idx) => {
    if (/^TopProxy\s*#\d+$/i.test(r.name)) {
      r.name = `TopProxy #${idx + 1}`
      store.upsertRotatingProxy(r)
    }
  })

  let cursor = 0
  const workers = Array.from({ length: Math.min(5, allRot.length) }, async () => {
    while (cursor < allRot.length) {
      const entry = allRot[cursor++]
      if (!entry.currentProxy || entry.status === 'error' || entry.status === 'unknown') {
        await resolveRotatingProxy(entry.id, false)
        onProgress?.()
      }
    }
  })
  await Promise.all(workers)

  // Auto-pair any account that has no proxy OR is bound to an expired rotating proxy
  const liveRot = store.getRotatingProxies().filter((r) => r.status !== 'expired')
  const validRotIds = new Set(liveRot.map((r) => `rot:${r.id}`))
  const validStaticIds = new Set(
    store
      .getProxies()
      .filter((p) => p.status !== 'dead')
      .map((p) => p.id)
  )

  const liveProxyPool: string[] = [
    ...liveRot.map((r) => `rot:${r.id}`),
    ...Array.from(validStaticIds)
  ]

  if (liveProxyPool.length > 0) {
    let pairIdx = 0
    let changed = false
    for (const acc of store.getAccounts()) {
      const hasValidLiveProxy =
        acc.proxyId && (validRotIds.has(acc.proxyId) || validStaticIds.has(acc.proxyId))
      if (!hasValidLiveProxy) {
        const assigned = liveProxyPool[pairIdx % liveProxyPool.length]
        pairIdx++
        store.updateAccount(acc.id, { proxyId: assigned })
        changed = true
      }
    }
    if (changed) {
      store.flushSync()
      onProgress?.()
    }
  }
}

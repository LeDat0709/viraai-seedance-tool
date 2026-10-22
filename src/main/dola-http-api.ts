import { BrowserWindow, net } from 'electron'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { applyAntiDetectToWindow, getAccountFingerprint } from './anti-detect'
import { byCodePoint, canonicalQuery } from './aws-sigv4'

export const DOLA_BOT_ID = '7339470689562525703'
export const DOLA_PC_VERSION = '3.28.8'
export const DOLA_PC_AID = '582465'
export const DOLA_WEB_AID = '495671'
export const QAAB_SALT_B64 =
  'TdTC5rgxYgkOUrPHpnM7pByyRiuCmrWKGWs521cXdST0m69/COjWjSanLjfBqVovHwWlGJKu8pSXMrYqOKrdWA=='

const DEFAULT_UA =
  process.platform === 'darwin'
    ? 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

// Precomputed IEEE 802.3 CRC32 lookup table for ByteDance ImageX `content-crc32` header
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[i] = c >>> 0
  }
  return table
})()

export function crc32Hex(buf: Buffer): string {
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    crc = CRC32_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
  }
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0')
}

function decodeBase64Safe(value: string): Buffer {
  const normalized = String(value || '')
    .trim()
    .replace(/-/g, '+')
    .replace(/_/g, '/')
  const padLen = (4 - (normalized.length % 4)) % 4
  return Buffer.from(normalized + '='.repeat(padLen), 'base64')
}

function aes128CbcDecryptRaw(key: Buffer, iv: Buffer, ciphertext: Buffer): Buffer {
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv)
  decipher.setAutoPadding(false)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

/**
 * Decodes Dola VOD `main_url` / `backup_url_1` tokens:
 * - Plain `http(s)://...` URLs are returned as-is.
 * - Standard Base64 URLs are decoded directly.
 * - Encrypted `qAAB...` tokens (header `0xa8 0x00 0x01 0x00`) are decrypted with AES-128-CBC
 *   using `key_seed` and `QAAB_SALT_B64`:
 *   `d = sha512(sha512(b64(key_seed)) + b64(QAAB_SALT_B64))`
 *   `key = d[0..16]`, `iv = d[16..32]`, `ciphertext = raw[4..]`.
 */
export function decodeDolaMediaToken(token: string, keySeed = ''): string {
  if (!token) return ''
  const trimmed = token.trim().replace(/\\+$/g, '')
  if (/^https?:\/\//i.test(trimmed)) return trimmed

  try {
    const raw = decodeBase64Safe(trimmed)
    if (raw.length < 8) return ''

    let text = ''
    if (raw[0] === 0xa8 && raw[1] === 0x00 && raw[2] === 0x01 && raw[3] === 0x00) {
      if (!keySeed) return ''
      const seedHash = crypto.createHash('sha512').update(decodeBase64Safe(keySeed)).digest()
      const saltBuf = decodeBase64Safe(QAAB_SALT_B64)
      const d = crypto
        .createHash('sha512')
        .update(Buffer.concat([seedHash, saltBuf]))
        .digest()
      const ciphertext = raw.subarray(4)
      if (ciphertext.length === 0 || ciphertext.length % 16 !== 0) return ''
      let out = aes128CbcDecryptRaw(d.subarray(0, 16), d.subarray(16, 32), ciphertext)
      const padByte = out[out.length - 1]
      if (padByte > 0 && padByte <= 16 && padByte <= out.length) {
        out = out.subarray(0, out.length - padByte)
      }
      text = out.toString('utf8').replace(/\0+/g, '').trim()
    } else {
      text = raw.toString('utf8').replace(/\0+/g, '').trim()
    }

    if (/^https?:\/\//i.test(text)) {
      return text
        .replace(/\\+u0026/gi, '&')
        .replace(/\\+u003d/gi, '=')
        .replace(/\\+u003f/gi, '?')
        .replace(/\\+\//g, '/')
    }
  } catch {}
  return ''
}

/**
 * Recursively walks nested dicts, arrays, and JSON-encoded strings inside Dola responses.
 */
export function* walkDolaNestedObjects(obj: unknown, seen = new Set<unknown>()): Generator<Record<string, any>> {
  if (obj == null) return
  if (typeof obj === 'string') {
    const s = obj.trim()
    if ((s.startsWith('{') || s.startsWith('[')) && s.length > 2) {
      try {
        yield* walkDolaNestedObjects(JSON.parse(s), seen)
      } catch {}
    }
    return
  }
  if (typeof obj !== 'object' || seen.has(obj)) return
  seen.add(obj)

  if (Array.isArray(obj)) {
    for (const item of obj) {
      yield* walkDolaNestedObjects(item, seen)
    }
    return
  }

  const rec = obj as Record<string, any>
  yield rec
  for (const val of Object.values(rec)) {
    yield* walkDolaNestedObjects(val, seen)
  }
}

/**
 * Extracts and decrypts any `main_url` / `backup_url_1` tokens (including `qAAB` AES-128-CBC tokens)
 * from a raw JSON string or parsed object that may contain `key_seed` and `video_list`.
 */
export function extractDecryptedUrlsFromDolaPayload(
  rawInput: unknown,
  extraKeySeeds: string[] = [],
  assumeUnwatermarked = false
): {
  unwatermarkedUrls: string[]
  allDecryptedUrls: string[]
  bestInfo?: Record<string, any>
} {
  const seeds: string[] = []
  for (const s of extraKeySeeds) {
    if (typeof s === 'string' && s.trim()) {
      seeds.push(s.trim())
    }
  }
  const rawTokens: Array<{ token: string; info: Record<string, any> }> = []

  // 1. Walk structured JSON if possible
  try {
    const parsed = typeof rawInput === 'string' ? JSON.parse(rawInput) : rawInput
    for (const node of walkDolaNestedObjects(parsed)) {
      if (typeof node.key_seed === 'string' && node.key_seed.trim()) {
        seeds.push(node.key_seed.trim())
      }
      const vlist = node.video_list
      if (vlist && typeof vlist === 'object' && !Array.isArray(vlist)) {
        for (const v of Object.values(vlist)) {
          if (v && typeof v === 'object') {
            const vObj = v as Record<string, any>
            for (const field of ['main_url', 'backup_url_1']) {
              if (typeof vObj[field] === 'string' && vObj[field].trim()) {
                rawTokens.push({ token: vObj[field].trim(), info: vObj })
              }
            }
          }
        }
      }
    }
  } catch {}

  // 2. Also regex-scan raw text in case it is partially escaped
  if (typeof rawInput === 'string' && rawInput.length > 0) {
    const norm = rawInput
      .replace(/\\+u0026/gi, '&')
      .replace(/\\+u003d/gi, '=')
      .replace(/\\+u003f/gi, '?')
      .replace(/\\+"/g, '"')
      .replace(/\\+\//g, '/')
    for (const m of norm.matchAll(/"key_seed"\s*:\s*"([^"\s]+)"/gi)) {
      if (m[1]) seeds.push(m[1].trim())
    }
    for (const m of norm.matchAll(/[?&]key_seed=([^&\s"\\]+)/gi)) {
      if (m[1]) {
        try {
          seeds.push(decodeURIComponent(m[1].trim()))
        } catch {
          seeds.push(m[1].trim())
        }
      }
    }
    for (const m of norm.matchAll(/"(?:main_url|backup_url_1)"\s*:\s*"([^"\s]+)"/gi)) {
      if (m[1]) rawTokens.push({ token: m[1].trim(), info: {} })
    }
  }

  const uniqueSeeds = Array.from(new Set([...seeds, '']))
  const unwatermarkedUrls: string[] = []
  const allDecryptedUrls: string[] = []
  let bestInfo: Record<string, any> | undefined

  // Sort video_list entries by (resolution area, bitrate) descending (matching SeedanceUnlimited v1.5.8 nologo_url)
  rawTokens.sort((a, b) => {
    const areaA = Number(a.info?.vheight || 0) * Number(a.info?.vwidth || 0)
    const areaB = Number(b.info?.vheight || 0) * Number(b.info?.vwidth || 0)
    if (areaB !== areaA) return areaB - areaA
    return Number(b.info?.bitrate || b.info?.size || 0) - Number(a.info?.bitrate || a.info?.size || 0)
  })

  for (const { token, info } of rawTokens) {
    for (const seed of uniqueSeeds) {
      const url = decodeDolaMediaToken(token, seed)
      if (url) {
        allDecryptedUrls.push(url)
        const isExplicitlyWatermarked =
          /logo_type=watermarked|watermark_dyn|lr=video_gen_watermark|lr=cici_ai/i.test(url)
        const isExplicitlyClean = /lr=unwatermarked|logo_type=unwatermarked/i.test(url)
        if (isExplicitlyClean || (assumeUnwatermarked && !isExplicitlyWatermarked) || (!isExplicitlyWatermarked && !/watermark/i.test(url))) {
          unwatermarkedUrls.push(url)
          if (!bestInfo && Object.keys(info).length > 0) {
            bestInfo = {
              definition: info.definition,
              width: info.vwidth,
              height: info.vheight,
              bitrate: info.bitrate
            }
          }
        }
        break
      }
    }
  }

  return {
    unwatermarkedUrls: Array.from(new Set(unwatermarkedUrls)),
    allDecryptedUrls: Array.from(new Set(allDecryptedUrls)),
    bestInfo
  }
}

/**
 * Given a `fallback_api` URL (`APIVod/action/GetPlayInfo`), rewrites its query params to
 * `channel=no&codec_type=8&logo_type=unwatermarked` (matching SeedanceUnlimited v1.5.8 `nologo_url`),
 * fetches the VOD play info, and decrypts the `qAAB` AES-128-CBC `main_url` token.
 */
export async function fetchDolaNoLogoUrlFromFallbackApi(
  ses: Electron.Session,
  fallbackApiUrl: string,
  cookieHeader?: string,
  baseUrl = 'https://www.dola.com',
  extraKeySeed = ''
): Promise<{ url: string; info?: Record<string, any> }> {
  if (!fallbackApiUrl) return { url: '' }
  try {
    const cleanFbUrl = fallbackApiUrl
      .replace(/\\+u0026/gi, '&')
      .replace(/\\+u003d/gi, '=')
      .replace(/\\+u003f/gi, '?')
      .replace(/\\+\//g, '/')
      .trim()
    const baseParsed = new URL(cleanFbUrl)
    const urlKeySeed = baseParsed.searchParams.get('key_seed') || ''
    const extraSeeds = [extraKeySeed, urlKeySeed].filter(Boolean)

    for (const codecType of ['8', '0']) {
      const parsedUrl = new URL(cleanFbUrl)
      parsedUrl.searchParams.set('channel', 'no')
      parsedUrl.searchParams.set('codec_type', codecType)
      parsedUrl.searchParams.set('logo_type', 'unwatermarked')
      const targetUrl = parsedUrl.toString()

      let text = ''
      // 1. Primary: Direct Node fetch (fallback_api is a self-signed ByteDance VOD URL that does not require cookies;
      // calling it directly avoids rotating proxy SSL resets `net_error -100` and responds in ~150ms)
      try {
        const ctrl = new AbortController()
        const timer = setTimeout(() => ctrl.abort(), 12000)
        try {
          const resp = await fetch(targetUrl, {
            method: 'GET',
            headers: {
              Accept: 'application/json',
              Referer: `${baseUrl.replace(/\/+$/, '')}/`,
              'User-Agent': DEFAULT_UA
            },
            signal: ctrl.signal
          })
          if (resp.ok) {
            text = await resp.text()
          }
        } finally {
          clearTimeout(timer)
        }
      } catch {}

      // 2. Fallback: Electron net.request via `ses` (uses account proxy)
      if (!text) {
        try {
          const netHeaders: Record<string, string> = {
            Accept: 'application/json',
            'Accept-Encoding': 'identity',
            Referer: `${baseUrl.replace(/\/+$/, '')}/`,
            'User-Agent': DEFAULT_UA
          }
          if (cookieHeader) netHeaders['Cookie'] = cookieHeader
          const buf = await fetchViaElectronNet(targetUrl, {
            method: 'GET',
            headers: netHeaders,
            ses,
            timeoutMs: 20000
          })
          text = buf.toString('utf8')
        } catch {
          // 3. Fallback: ses.fetch WITHOUT manual Referer header
          try {
            const resp = await ses.fetch(targetUrl, {
              method: 'GET',
              headers: {
                Accept: 'application/json',
                'User-Agent': DEFAULT_UA
              },
              referrerPolicy: 'no-referrer'
            })
            if (resp.ok) {
              text = await resp.text()
            }
          } catch {}
        }
      }

      if (!text) continue
      const extracted = extractDecryptedUrlsFromDolaPayload(text, extraSeeds, true)
      const bestUrl =
        extracted.unwatermarkedUrls[0] ||
        extracted.allDecryptedUrls.find(
          (u) => !/logo_type=watermarked|watermark_dyn|lr=video_gen_watermark/i.test(u)
        ) ||
        ''
      if (bestUrl) {
        return { url: bestUrl, info: extracted.bestInfo }
      }
    }

    return { url: '' }
  } catch {
    return { url: '' }
  }
}

/**
 * AWS Signature Version 4 (`AWS4-HMAC-SHA256`) header generator for ByteDance ImageX (`ApplyImageUpload`).
 */
export function buildAws4Headers(params: {
  accessKey: string
  secretKey: string
  sessionToken: string
  region: string
  service: string
  method: string
  url: string
  extraHeaders?: Record<string, string>
}): Record<string, string> {
  const { accessKey, secretKey, sessionToken, region, service, method, url, extraHeaders } = params
  const parsed = new URL(url)
  const now = new Date()
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
  const dateStamp = amzDate.slice(0, 8)

  const signHeaders: Record<string, string> = {
    'x-amz-date': amzDate,
    'x-amz-security-token': sessionToken,
    ...(extraHeaders || {})
  }

  // Canonical query string sorted by key
  const queryEntries = Array.from(parsed.searchParams.entries()).sort((a, b) =>
    a[0] === b[0] ? byCodePoint(a[1], b[1]) : byCodePoint(a[0], b[0])
  )
  const canonicalQuery = queryEntries
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&')

  const sortedHeaderKeys = Object.keys(signHeaders)
    .map((k) => k.toLowerCase())
    .sort()
  const canonicalHeaders = sortedHeaderKeys
    .map((k) => `${k}:${String(signHeaders[k] ?? '').trim()}\n`)
    .join('')
  const signedHeaders = sortedHeaderKeys.join(';')
  const emptyPayloadHash = crypto.createHash('sha256').update('').digest('hex')

  const canonicalRequest = [
    method.toUpperCase(),
    parsed.pathname || '/',
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    emptyPayloadHash
  ].join('\n')

  const scope = `${dateStamp}/${region}/${service}/aws4_request`
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    crypto.createHash('sha256').update(canonicalRequest, 'utf8').digest('hex')
  ].join('\n')

  const hmac = (key: Buffer | string, msg: string): Buffer =>
    crypto.createHmac('sha256', key).update(msg, 'utf8').digest()

  const kDate = hmac(`AWS4${secretKey}`, dateStamp)
  const kRegion = hmac(kDate, region)
  const kService = hmac(kRegion, service)
  const kSigning = hmac(kService, 'aws4_request')
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex')

  return {
    ...signHeaders,
    Authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
  }
}

/**
 * Probes PNG / JPEG / WebP dimensions directly from buffer bytes (zero external dependencies).
 */
export function probeImageDimensions(buf: Buffer): { width: number; height: number } {
  try {
    // PNG: 8-byte signature + IHDR chunk
    if (
      buf.length >= 24 &&
      buf[0] === 0x89 &&
      buf[1] === 0x50 &&
      buf[2] === 0x4e &&
      buf[3] === 0x47
    ) {
      const width = buf.readUInt32BE(16)
      const height = buf.readUInt32BE(20)
      if (width > 0 && height > 0) return { width, height }
    }

    // JPEG: scan SOF0 / SOF1 / SOF2 markers
    if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) {
          i++
          continue
        }
        const marker = buf[i + 1]
        if (marker === 0xff) {
          i++
          continue
        }
        if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
          const height = buf.readUInt16BE(i + 5)
          const width = buf.readUInt16BE(i + 7)
          if (width > 0 && height > 0) return { width, height }
          break
        }
        const segLen = buf.readUInt16BE(i + 2)
        if (segLen < 2) break
        i += 2 + segLen
      }
    }

    // WebP (VP8X / VP8 / VP8L)
    if (
      buf.length >= 30 &&
      buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
      buf.subarray(8, 12).toString('ascii') === 'WEBP'
    ) {
      const chunkHeader = buf.subarray(12, 16).toString('ascii')
      if (chunkHeader === 'VP8X') {
        const width = 1 + buf.readUIntLE(24, 3)
        const height = 1 + buf.readUIntLE(27, 3)
        if (width > 0 && height > 0) return { width, height }
      } else if (chunkHeader === 'VP8 ' && buf.length >= 30) {
        const width = buf.readUInt16LE(26) & 0x3fff
        const height = buf.readUInt16LE(28) & 0x3fff
        if (width > 0 && height > 0) return { width, height }
      } else if (chunkHeader === 'VP8L' && buf.length >= 25) {
        const b0 = buf[21]
        const b1 = buf[22]
        const b2 = buf[23]
        const b3 = buf[24]
        const width = 1 + (((b1 & 0x3f) << 8) | b0)
        const height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6))
        if (width > 0 && height > 0) return { width, height }
      }
    }
  } catch {}

  return { width: 1024, height: 1024 }
}

export interface DolaUploadedAttachment {
  uri: string
  url: string
  width: number
  height: number
  name: string
  nativeAttachment?: Record<string, any>
}

export function buildDolaImageMessageBlock(att: DolaUploadedAttachment): Record<string, any> {
  return {
    local_block_id: crypto.randomUUID(),
    block_type: 10052,
    content: {
      attachment_block: {
        type: 10052,
        name: att.name,
        key: att.uri,
        extra: JSON.stringify({}),
        file_parse_state: 3,
        url: att.url,
        option: {
          image_Create_Option: {
            width: att.width,
            height: att.height
          }
        }
      }
    },
    UniqueKey: att.uri,
    _nativeAttachment:
      att.nativeAttachment || {
        type: 1,
        identifier: crypto.randomUUID(),
        image: {
          name: att.name,
          uri: att.uri,
          image_ori: {
            url: '',
            width: 0,
            height: 0,
            format: '',
            url_formats: {}
          }
        },
        parse_state: 0,
        review_state: 1,
        upload_status: 1,
        progress: 100,
        src: ''
      }
  }
}

export interface DolaChainMessage {
  messageId: string
  index: number
  userType: number
  status: number
  createdTime: number
  text: string
  ext?: Record<string, any>
  quotaDowngraded?: boolean
  creationResCode?: string
  isGenerating?: boolean
  videos: Array<{
    vid: string
    status?: number
    downloadUrl: string
    videoModel: Record<string, any>
  }>
}

export function parseDolaChainMessages(data: Record<string, any>): DolaChainMessage[] {
  const msgs: any[] = []
  for (const d of walkDolaNestedObjects(data)) {
    if (Array.isArray(d.messages)) {
      msgs.push(...d.messages)
      break
    }
  }

  const out: DolaChainMessage[] = []
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i]
    if (!m || typeof m !== 'object') continue
    const rawIdx = m.index ?? m.message_index ?? m.order_index ?? m.index_in_conv
    const idx = rawIdx !== undefined && rawIdx !== null ? Number(rawIdx) : i + 1
    const texts: string[] = []
    const seenTexts = new Set<string>()
    const videos: DolaChainMessage['videos'] = []
    const seenVids = new Set<string>()

    // Merge blocks from BOTH m.content_block AND JSON.parse(m.content):
    // In Dola's real /im/chain/single response, m.content_block often lacks `is_finish: true`
    // or `creation_block` (2074), while `m.content` (JSON string) carries `is_finish: true` and `video_model`.
    const cbBlocks: any[] = Array.isArray(m.content_block) ? m.content_block : []
    let contentBlocks: any[] = []
    if (typeof m.content === 'string' && m.content.trim()) {
      try {
        const parsedContent = JSON.parse(m.content)
        if (Array.isArray(parsedContent)) {
          contentBlocks = parsedContent
        } else if (parsedContent && typeof parsedContent === 'object') {
          contentBlocks = [parsedContent]
        }
      } catch {}
    }
    const blocks: any[] = [...cbBlocks, ...contentBlocks]

    const thinkingBlockIds = new Set<string>()
    for (const b of blocks) {
      if (b && typeof b === 'object' && b.block_type === 10040 && b.block_id) {
        thinkingBlockIds.add(String(b.block_id))
      }
    }

    let hasFinishedReplyBlock = false

    for (const b of blocks) {
      if (!b || typeof b !== 'object') continue
      const bt = b.block_type
      const isThinkingChild = Boolean(b.parent_id && thinkingBlockIds.has(String(b.parent_id)))
      if (
        bt !== 10040 &&
        !isThinkingChild &&
        (b.is_finish === true || b.is_finish === 1 || String(b.is_finish) === '1')
      ) {
        hasFinishedReplyBlock = true
      }

      let c = b.content || {}
      if (typeof c === 'string') {
        try {
          c = JSON.parse(c)
        } catch {
          c = {}
        }
      }
      const cv2 = b.content_v2 && typeof b.content_v2 === 'object' ? b.content_v2 : {}

      if (bt === 10000 && !isThinkingChild) {
        // Skip internal Deep Think chain-of-thought blocks (parent_id -> thinking_block 10040)
        const tb = c.text_block || cv2.text_block || {}
        if (typeof tb === 'object' && tb.text) {
          const txt = String(tb.text).trim()
          if (txt && !seenTexts.has(txt)) {
            seenTexts.add(txt)
            texts.push(String(tb.text))
          }
        }
      }

      for (const rootObj of [c, cv2]) {
        for (const sub of walkDolaNestedObjects(rootObj)) {
          let vm: Record<string, any> | null = null
          if (typeof sub.video_model === 'string' && sub.video_model.trim()) {
            try {
              const parsed = JSON.parse(sub.video_model)
              if (parsed && typeof parsed === 'object') vm = parsed
            } catch {}
          } else if (sub.video_model && typeof sub.video_model === 'object') {
            vm = sub.video_model as Record<string, any>
          }
          if (vm && Object.keys(vm).length > 0) {
            const vidKey = String(sub.vid || vm.video_id || JSON.stringify(vm).slice(0, 64))
            if (seenVids.has(vidKey)) continue
            seenVids.add(vidKey)
            videos.push({
              vid: String(sub.vid || vm.video_id || ''),
              status: sub.status,
              downloadUrl: String(sub.download_url || ''),
              videoModel: vm
            })
            hasFinishedReplyBlock = true
          }
        }
      }
    }

    // Also walk m.content directly (matching SeedanceUnlimited v1.5.8 `parse_chain_messages`)
    // in case creation_block / video_model is nested outside standard content_block entries
    for (const node of walkDolaNestedObjects(m.content || m)) {
      const cb = node.creation_block
      if (cb && typeof cb === 'object' && Array.isArray(cb.creations)) {
        for (const cr of cb.creations) {
          const v = cr?.video
          if (!v || typeof v !== 'object') continue
          let vm: Record<string, any> | null = null
          if (typeof v.video_model === 'string' && v.video_model.trim()) {
            try {
              const parsed = JSON.parse(v.video_model)
              if (parsed && typeof parsed === 'object') vm = parsed
            } catch {}
          } else if (v.video_model && typeof v.video_model === 'object') {
            vm = v.video_model as Record<string, any>
          }
          if (vm && Object.keys(vm).length > 0) {
            const vidKey = String(v.vid || vm.video_id || JSON.stringify(vm).slice(0, 64))
            if (seenVids.has(vidKey)) continue
            seenVids.add(vidKey)
            videos.push({
              vid: String(v.vid || vm.video_id || ''),
              status: v.status,
              downloadUrl: String(v.download_url || ''),
              videoModel: vm
            })
            hasFinishedReplyBlock = true
          }
        }
      }
    }

    // Parse m.ext (`mode_downgrade_reason`, `ai_creation_res_code`, `ai_creation_tool_list`)
    let extObj: Record<string, any> = {}
    if (typeof m.ext === 'string' && m.ext.trim()) {
      try {
        extObj = JSON.parse(m.ext)
      } catch {
        extObj = { _raw: m.ext }
      }
    } else if (m.ext && typeof m.ext === 'object') {
      extObj = m.ext as Record<string, any>
    }

    const userTypeNum = Number(m.user_type ?? m.sender_type ?? 0)
    // Also extract bare `"vid":"<16+ chars>"` from bot messages (user_type === 2) if not already in `videos`
    if (userTypeNum !== 1 && videos.length === 0) {
      const rawMsgText = JSON.stringify({ content: m.content, content_block: m.content_block, ext: m.ext })
      for (const vidMatch of rawMsgText.matchAll(/"vid"\s*:\s*"(v[a-z0-9_]{15,})"/gi)) {
        const matchedVid = vidMatch[1]
        if (matchedVid && !seenVids.has(matchedVid)) {
          seenVids.add(matchedVid)
          videos.push({
            vid: matchedVid,
            downloadUrl: '',
            videoModel: { video_id: matchedVid }
          })
          hasFinishedReplyBlock = true
        }
      }
    }

    const quotaDowngraded =
      String(extObj.mode_downgrade_reason || '').toLowerCase() === 'user_quota'
    const creationResCode = extObj.ai_creation_res_code
      ? String(extObj.ai_creation_res_code)
      : undefined
    let isGenerating = false
    if (extObj.ai_creation_tool_list) {
      const toolListStr =
        typeof extObj.ai_creation_tool_list === 'string'
          ? extObj.ai_creation_tool_list
          : JSON.stringify(extObj.ai_creation_tool_list)
      if (toolListStr && !/"is_finish"\s*:\s*(?:"1"|1|true)/i.test(toolListStr)) {
        isGenerating = true
      }
    }

    const rawStatus = Number(m.status || 0)
    out.push({
      messageId: String(m.message_id || m.id || `msg_${i}`),
      index: idx,
      userType: userTypeNum,
      status: hasFinishedReplyBlock ? 2 : rawStatus,
      createdTime: Number(m.created_time || m.create_time || 0),
      text: texts.join('\n').trim(),
      ext: extObj,
      quotaDowngraded,
      creationResCode,
      isGenerating,
      videos
    })
  }

  out.sort((a, b) => a.index - b.index)
  return out
}

/**
 * Extracts direct `/video/tos/` or `.mp4` URLs from raw `/im/chain/single` JSON text.
 * Prioritizes unwatermarked URLs first, followed by any direct `/video/tos/` MP4 URLs
 * (such as Markdown `[点击播放](http://v19-dola.dola.com/.../video/tos/...)` links from `text_to_video` tool blocks).
 */
export function extractCleanVideoUrlsFromJson(strData: string): string[] {
  const explicitUnwatermarkedUrls: string[] = []
  const cleanUrls: string[] = []
  if (!strData) return cleanUrls
  const norm = strData
    .replace(/\\+u0026/gi, '&')
    .replace(/\\+u003d/gi, '=')
    .replace(/\\+u003f/gi, '?')
  const urlMatches = norm.match(/https?:(?:\\\/\\\/|\/\/)[^\s"'<>\\)\]]+/gi) || []
  for (const rawUrl of urlMatches) {
    const clean = rawUrl
      .replace(/\\\//g, '/')
      .replace(/[.,;!?)+]+$/, '')
      .replace(/^http:\/\//i, 'https://')
    if (/(?:\.(?:mp4|webm|mov)(?:$|[?#])|\/video\/tos\/|mime_type=video_)/i.test(clean)) {
      if (/lr=unwatermarked|logo_type=unwatermarked/i.test(clean)) {
        if (!explicitUnwatermarkedUrls.includes(clean)) explicitUnwatermarkedUrls.push(clean)
      } else if (!/watermark|logo|cici_ai|tos-[a-z0-9]+-ve-/i.test(clean)) {
        if (!cleanUrls.includes(clean)) cleanUrls.push(clean)
      }
    }
  }
  return [...explicitUnwatermarkedUrls, ...cleanUrls]
}

const CONFIRM_INTENT_RE =
  /xác\s*nhận|bạn\s*(có\s*)?muốn|bạn\s*chọn|tiếp\s*tục\s*không|đồng\s*ý\s*không|phương\s*án\s*(nào|1|2|a|b)|hãy\s*cho\s*(mình|tôi)\s*biết|vui\s*lòng\s*(chọn|xác\s*nhận)|please\s*(confirm|choose|let\s*me\s*know)|would\s*you\s*like\s*(me\s*to|to\s*proceed)|shall\s*i\s*(proceed|generate|continue)|which\s*option|do\s*you\s*want\s*me\s*to|请确认|确认无误|生成参数确认|是否按此|是否继续|请回复|回复\s*[「"“'【]?(?:确认|生成|confirm|start)|确认后|需要我为您生成/i

const FAIL_INTENT_RE =
  /không\s*thể\s*tạo|từ\s*chối|vi\s*phạm\s*chính\s*sách|hết\s*lượt|đã\s*đạt\s*giới\s*hạn|out\s*of\s*credits?|daily\s*limit|cannot\s*generate|unable\s*to\s*generate|policy\s*violation|免费额度用完了|额度已用完|今日额度已用完|先使用快速模式/i

const GEN_ACK_RE =
  /i['’]ll\s+generate|will\s+be\s+generated|ready\s+in\s+\d|send\s+it\s+to\s+you\s+when\s+it['’]s\s+done|video\s+credits?\s+left\s+today|sẽ\s+tạo\s+video|đang\s+tạo\s+video|gửi\s+cho\s+bạn\s+khi\s+hoàn\s+tất|còn\s+\d+\s+lượt|正在(?:为您)?生成|已开始生成|视频生成中|生成完成后/i

export function needsDolaConfirmation(text: string): boolean {
  if (!text) return false
  if (FAIL_INTENT_RE.test(text) || GEN_ACK_RE.test(text)) return false
  if (CONFIRM_INTENT_RE.test(text)) return true
  if (text.includes('?') || text.includes('？')) return true
  return false
}

export function extractCreditsLeftFromText(text: string): number | null {
  const m = /(?:still\s+have|còn\s+lại|còn)\s+(\d+)\s+(?:video\s+)?(?:credits?|lượt)/i.exec(
    text || ''
  )
  return m ? Number(m[1]) : null
}

// ============================================================================
// NATIVE IN-PAGE SIGNED FETCH ENGINE (window.bdms a_bogus + localStorage device_id/web_id)
// ============================================================================

function execJsWithTimeout<T = any>(
  win: BrowserWindow | null | undefined,
  code: string,
  timeoutMs = 4500
): Promise<T | null> {
  if (!win || win.isDestroyed()) return Promise.resolve(null)
  return new Promise<T | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs)
    win.webContents
      .executeJavaScript(code)
      .then((res) => {
        clearTimeout(timer)
        resolve(res as T)
      })
      .catch(() => {
        clearTimeout(timer)
        resolve(null)
      })
  })
}

function loadUrlWithTimeout(
  win: BrowserWindow | null | undefined,
  url: string,
  timeoutMs = 8000
): Promise<boolean> {
  if (!win || win.isDestroyed()) return Promise.resolve(false)
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs)
    win.webContents
      .loadURL(url)
      .then(() => {
        clearTimeout(timer)
        resolve(true)
      })
      .catch(() => {
        clearTimeout(timer)
        resolve(false)
      })
  })
}

const SIGNER_CHECK_SCRIPT = `
(() => {
  try {
    const w = window;
    const isDolaOrigin = location.origin === 'https://www.dola.com';
    const isErrorPage = location.href.startsWith('chrome-error://') || !isDolaOrigin;
    const hasBdms = !!(w.bdms && (typeof w.bdms.frontierSign === 'function' || w.bdms.init));
    const hasAcrawler = typeof w.byted_acrawler !== 'undefined';
    const hasSdkScript = !!document.querySelector('script[src*="webmssdk"]');
    const cookie = document.cookie || '';
    const hasFingerprint = /(?:^|;\\s*)s_v_web_id=/.test(cookie);
    const hasChatDom = !!document.querySelector('div.ProseMirror, [data-testid="chat_input"], textarea, [data-testid="to_login_button"]');
    let hasSamanthaId = false;
    if (isDolaOrigin) {
      try {
        let sam = JSON.parse(localStorage.getItem('samantha_web_web_id') || 'null');
        let tea = JSON.parse(localStorage.getItem('_tea_cache_tokens_495671') || 'null');
        const mWebId = cookie.match(/(?:^|;\\s*)_web_id=([^;]+)/);
        const cookieWebId = mWebId ? decodeURIComponent(mWebId[1]).trim() : '';
        const canonicalWebId = cookieWebId || (sam && sam.web_id) || (tea && tea.web_id) || '';
        if (canonicalWebId && /^\\d{12,}$/.test(canonicalWebId)) {
          if (!sam || sam.web_id !== canonicalWebId) {
            sam = { user_id: (sam && sam.user_id) || canonicalWebId, web_id: canonicalWebId, timestamp: Date.now() };
            localStorage.setItem('samantha_web_web_id', JSON.stringify(sam));
          }
          if (!tea || tea.web_id !== canonicalWebId) {
            tea = { web_id: canonicalWebId, user_unique_id: (tea && tea.user_unique_id) || canonicalWebId, timestamp: Date.now(), _type_: 'default' };
            localStorage.setItem('_tea_cache_tokens_495671', JSON.stringify(tea));
          }
          if (!cookieWebId) {
            document.cookie = '_web_id=' + canonicalWebId + '; path=/; domain=.dola.com; max-age=31536000; SameSite=Lax';
          }
        }
        const mCountry = cookie.match(/(?:^|;\\s*)flow_user_country=([^;]+)/);
        if (mCountry && !localStorage.getItem('flow_user_country')) {
          localStorage.setItem('flow_user_country', decodeURIComponent(mCountry[1]).trim());
        }
        hasSamanthaId = Boolean((sam && sam.web_id) || (tea && tea.web_id));
      } catch (_) {}
    }
    return {
      ready: !!(isDolaOrigin && (hasBdms || hasAcrawler || (hasSdkScript && hasChatDom))),
      isDolaOrigin,
      isErrorPage,
      hasBdms,
      hasAcrawler,
      hasSdkScript,
      hasFingerprint,
      hasChatDom,
      hasSamanthaId
    };
  } catch (e) {
    return { ready: false, isErrorPage: true, error: String(e && e.message) };
  }
})()
`

const IDENTITY_READER_SCRIPT = `
(() => {
  const readJson = (key) => {
    try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (_) { return null; }
  };
  const samantha = readJson('samantha_web_web_id');
  const tea = readJson('_tea_cache_tokens_495671');
  const cookie = document.cookie || '';
  const readCookie = (name) => {
    const m = cookie.match(new RegExp('(?:^|;\\\\s*)' + name + '=([^;]+)'));
    return m ? decodeURIComponent(m[1]) : '';
  };
  const cookieWebId = readCookie('_web_id');
  const canonicalWebId =
    cookieWebId ||
    (samantha && samantha.web_id) ||
    (tea && tea.web_id) ||
    '';

  if (canonicalWebId && /^\\d{15,22}$/.test(canonicalWebId)) {
    const now = Date.now();
    const uid = (samantha && samantha.user_id) || (tea && tea.user_unique_id) || canonicalWebId;
    try {
      if (!samantha || samantha.web_id !== canonicalWebId) {
        localStorage.setItem(
          'samantha_web_web_id',
          JSON.stringify({
            user_id: uid,
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
            user_unique_id: uid,
            timestamp: (tea && tea.timestamp) || now,
            _type_: 'default'
          })
        );
      }
    } catch (_) {}
  }

  return {
    cookie,
    identity: {
      deviceId: canonicalWebId,
      webId: canonicalWebId,
      teaUuid: canonicalWebId,
      webTabId: crypto.randomUUID(),
      region: localStorage.getItem('flow_user_country') || readCookie('flow_user_country') || (readCookie('store-country-code') || 'VN').toUpperCase(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Saigon',
      s_v_web_id: readCookie('s_v_web_id'),
      msToken: readCookie('msToken')
    }
  };
})()
`

const SESSION_VERIFY_SCRIPT = `
(async () => {
  let hasLoginBtn = false;
  try {
    const btn = document.querySelector('[data-testid="to_login_button"]');
    if (btn) {
      const r = btn.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) hasLoginBtn = true;
    }
  } catch (_) {}

  let brief = null;
  try {
    const response = await fetch('/alice/profile/self_brief', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      credentials: 'include'
    });
    brief = await response.json().catch(() => null);
  } catch (_) {}

  let passportUid = '';
  try {
    const pRes = await fetch('/passport/web/account/info/?aid=495671&account_sdk_source=web&device_platform=web&language=en', {
      method: 'GET',
      credentials: 'include'
    });
    const pJson = await pRes.json().catch(() => null);
    if (pJson && pJson.message === 'success' && pJson.data) {
      passportUid = String(pJson.data.user_id_str || pJson.data.user_id || '');
    }
  } catch (_) {}

  const briefCode = brief && (brief.code ?? brief.status_code);
  const briefCodeNum = briefCode !== undefined && briefCode !== null ? Number(briefCode) : undefined;
  const briefData = brief && brief.data;
  const briefUser = briefData && (briefData.profile_brief || briefData.user || briefData.user_info || briefData);
  const uid = String(passportUid || (briefUser && (briefUser.id || briefUser.user_id || briefUser.user_id_str)) || '');
  const isGuest = Boolean(
    hasLoginBtn ||
      briefCodeNum === 710012014 ||
      briefCodeNum === 710012003 ||
      briefCodeNum === 710012001 ||
      (briefUser && (briefUser.is_guest === true || briefUser.isGuest === true))
  );
  const authenticated =
    !isGuest &&
    (Boolean(passportUid) || briefCodeNum === 0) &&
    Boolean(uid && uid !== '0');
  return {
    authenticated,
    isGuest,
    code: briefCode,
    id: uid || undefined,
    nickname: briefUser ? String(briefUser.nickname || briefUser.user_name || briefUser.name || '') : undefined
  };
})()
`

function hmacSha256(key: Buffer | string, message: string): Buffer {
  return crypto.createHmac('sha256', key).update(message, 'utf8').digest()
}

function sha256Hex(data: Buffer | string): string {
  return crypto.createHash('sha256').update(data).digest('hex')
}


function signImagexRequest(params: {
  method: string
  host: string
  query: Record<string, string>
  body?: string
  credentials: {
    accessKey: string
    secretKey: string
    sessionToken?: string | null
    region?: string
  }
}): Record<string, string> {
  const { method, host, query, body = '', credentials } = params
  const now = new Date()
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  const dateStamp = amzDate.slice(0, 8)
  const bodyHash = sha256Hex(body || '')
  const region = credentials.region || 'ap-southeast-1'

  const headers: Record<string, string> = {
    host,
    'x-amz-content-sha256': bodyHash,
    'x-amz-date': amzDate
  }
  if (credentials.sessionToken) {
    headers['x-amz-security-token'] = credentials.sessionToken
  }

  const sortedHeaderKeys = Object.keys(headers).sort()
  const canonicalHeaders = sortedHeaderKeys.map((k) => `${k}:${headers[k]}\n`).join('')
  const signedHeaders = sortedHeaderKeys.join(';')

  const canonicalReq = [
    method.toUpperCase(),
    '/',
    canonicalQuery(query),
    canonicalHeaders,
    signedHeaders,
    bodyHash
  ].join('\n')

  const credentialScope = `${dateStamp}/${region}/imagex/aws4_request`
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256Hex(canonicalReq)
  ].join('\n')

  const kDate = hmacSha256('AWS4' + credentials.secretKey, dateStamp)
  const kRegion = hmacSha256(kDate, region)
  const kService = hmacSha256(kRegion, 'imagex')
  const kSigning = hmacSha256(kService, 'aws4_request')
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex')

  const finalHeaders: Record<string, string> = {
    Authorization: `AWS4-HMAC-SHA256 Credential=${credentials.accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    'X-Amz-Content-Sha256': bodyHash,
    'X-Amz-Date': amzDate
  }
  if (credentials.sessionToken) {
    finalHeaders['X-Amz-Security-Token'] = credentials.sessionToken
  }
  if (body) {
    finalHeaders['Content-Type'] = 'application/json'
  }
  return finalHeaders
}

export function fetchViaElectronNet(
  url: string,
  options: {
    method?: string
    headers?: Record<string, string>
    body?: Buffer | string | null
    ses?: Electron.Session
    timeoutMs?: number
  } = {}
): Promise<Buffer> {
  const { method = 'GET', headers = {}, body = null, ses, timeoutMs = 60000 } = options
  return new Promise((resolve, reject) => {
    const req = net.request({ method, url, session: ses, redirect: 'follow' })
    for (const [k, v] of Object.entries(headers)) {
      if (v != null) req.setHeader(k, String(v))
    }

    const timer = setTimeout(() => {
      try {
        req.abort()
      } catch {}
      reject(new Error(`Timeout ${method} ${url}`))
    }, timeoutMs)

    req.on('response', (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c) => chunks.push(Buffer.from(c)))
      res.on('end', () => {
        clearTimeout(timer)
        const buf = Buffer.concat(chunks)
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          return reject(
            new Error(`HTTP ${res.statusCode}: ${buf.toString('utf8').slice(0, 300)}`)
          )
        }
        resolve(buf)
      })
      res.on('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
    })

    req.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })

    if (body) {
      req.write(body)
    }
    req.end()
  })
}

export const DOLA_KHAN_EXTRA: Record<string, any> = {
  allow_free_queue: true,
  accept_queue: true,
  credits: 1,
  cost: 1,
  audio: false,
  generate_audio: false,
  with_audio: false,
  has_audio: false,
  bgm: false,
  sound: false,
  no_watermark: true,
  remove_logo: true,
  quality: 'max'
}

export function buildDolaWebSubmitEnvelope(params: {
  text: string
  userInputContent?: string
  model?: string
  duration?: number
  ratio?: string
  chatMode?: 'fast' | 'pro'
  conversationId?: string | null
  attachments?: Array<Record<string, any>> | null
}): Record<string, any> {
  const msgId = crypto.randomUUID()
  const blockId = crypto.randomUUID()
  const nowMs = Date.now()
  const convId =
    params.conversationId && params.conversationId !== '0' ? String(params.conversationId) : ''
  const isNew = !convId
  const isPro = params.chatMode === 'pro'
  const ratioStr = params.ratio || '16:9'
  const durationNum = Number(params.duration) || 15
  const modelStr = params.model || 'seedance_v2.5'
  const rawUserPrompt = String(params.userInputContent || params.text || '').trim()

  const displayPrompt =
    isNew &&
    !isPro &&
    rawUserPrompt &&
    !/^(?:生成された動画[:：]|Video generated[:：])/i.test(params.text.trim())
      ? `生成された動画：${rawUserPrompt}、${ratioStr}`
      : params.text

  const localConvId =
    'local_' +
    (BigInt('0x' + crypto.randomBytes(8).toString('hex')) % 0x2386f26fc10000n)
      .toString()
      .padStart(16, '0')

  const convInitOption: Record<string, any> = isPro
    ? { need_ack_conversation: isNew }
    : { need_ack_conversation: isNew, ...DOLA_KHAN_EXTRA }

  const abilityParamObj: Record<string, any> = {
    model: modelStr,
    duration: durationNum,
    ratio: ratioStr,
    ...(isNew && !isPro
      ? {
          input_box_content: {
            user_input_content: rawUserPrompt,
            reply_message_format: '生成された動画：%s'
          }
        }
      : {}),
    ...(!isPro ? DOLA_KHAN_EXTRA : {})
  }

  const envelope: Record<string, any> = {
    client_meta: {
      local_conversation_id: localConvId,
      conversation_id: convId,
      bot_id: DOLA_BOT_ID,
      last_section_id: '',
      last_message_index: null
    },
    messages: [
      {
        local_message_id: msgId,
        content_block: [
          {
            block_type: 10000,
            content: {
              text_block: {
                text: displayPrompt,
                icon_url: '',
                icon_url_dark: '',
                summary: ''
              },
              pc_event_block: ''
            },
            block_id: blockId,
            parent_id: '',
            meta_info: [],
            append_fields: []
          }
        ],
        message_status: 0
      }
    ],
    option: {
      send_message_scene: '',
      create_time_ms: nowMs,
      collect_id: '',
      is_audio: false,
      answer_with_suggest: false,
      agent_mode: 1,
      tts_switch: false,
      need_deep_think: isPro ? 4 : 0,
      click_clear_context: false,
      from_suggest: false,
      is_regen: false,
      is_replace: false,
      is_from_click_option: false,
      is_from_click_softlink: false,
      disable_sse_cache: false,
      select_text_action: '',
      is_select_text: false,
      resend_for_regen: false,
      scene_type: 0,
      unique_key: msgId,
      start_seq: 0,
      need_create_conversation: isNew,
      conversation_init_option: convInitOption,
      conversation_init_ext: {},
      model_config: {},
      aggregate_params: {
        provider_id: ''
      },
      regen_query_id: [],
      edit_query_id: [],
      regen_instruction: '',
      no_replace_for_regen: false,
      message_from: 0,
      shared_app_name: '',
      shared_app_id: '',
      sse_recv_event_options: {
        support_chunk_delta: true
      },
      is_ai_playground: false,
      is_old_user: false,
      general_task_param: {
        action: 0,
        thread_local_message_id: [msgId]
      },
      recovery_option: {
        is_recovery: false,
        req_create_time_sec: 0,
        append_sse_event_scene: 0
      },
      message_storage_type: 0,
      related_deleted_message_ids: {},
      connector_info_list: []
    },
    chat_ability: {
      ability_type: 17,
      ability_param: JSON.stringify(abilityParamObj),
      ...(!isPro ? DOLA_KHAN_EXTRA : {})
    },
    user_context: [],
    ext: {
      sub_conv_firstmet_type: '1',
      collection_id: '',
      conversation_init_option: JSON.stringify(convInitOption),
      commerce_credit_config_enable: '0',
      answer_with_suggest: '0',
      is_finish: '1'
    }
  }

  if (!isPro) {
    Object.assign(envelope, DOLA_KHAN_EXTRA)
  }

  if (isPro) {
    envelope.option.agent_mode = 1
    envelope.option.need_deep_think = 4
    envelope.ext.agent_mode = '1'
    envelope.ext.use_deep_think = '4'
    envelope.ext.is_finish = '1'
    delete envelope.chat_ability
  }

  if (Array.isArray(params.attachments) && params.attachments.length > 0) {
    const attachMsgId = crypto.randomUUID()
    const attachBlockId = crypto.randomUUID()
    const attachmentMsg = {
      local_message_id: attachMsgId,
      content_block: [
        {
          block_type: 10052,
          content: {
            attachment_block: {
              attachments: params.attachments
            },
            pc_event_block: ''
          },
          block_id: attachBlockId,
          parent_id: '',
          meta_info: [],
          append_fields: []
        }
      ],
      message_status: 0
    }
    envelope.messages.unshift(attachmentMsg)
    envelope.option.general_task_param.thread_local_message_id = [attachMsgId, msgId]
  }

  return envelope
}

/**
 * Manages hidden Electron `BrowserWindow`s per account partition (`maxLive = 4`).
 * Executes `window.fetch` inside `https://www.dola.com/chat` so ByteDance's `window.bdms` (`webmssdk`)
 * signs every request with a genuine `a_bogus` and reads real `device_id`/`web_id` from `localStorage`.
 */
/** Close a pooled Dola window this long after its last task released it. */
const NATIVE_WINDOW_IDLE_CLOSE_MS = 5_000

export class DolaNativeBrowserPool {
  private maxLive: number
  private windows = new Map<string, BrowserWindow>()
  private activity = new Map<string, { busyCount: number; lastActivityAt: number }>()

  constructor(maxLive = 4) {
    this.maxLive = Math.max(1, maxLive)
  }

  private getState(partition: string): { busyCount: number; lastActivityAt: number } {
    let st = this.activity.get(partition)
    if (!st) {
      st = { busyCount: 0, lastActivityAt: Date.now() }
      this.activity.set(partition, st)
    }
    return st
  }

  private enforceCapacity(excludePartition: string): void {
    while (this.windows.size >= this.maxLive) {
      let oldestIdleKey: string | null = null
      let oldestIdleTime = Infinity
      let oldestAnyKey: string | null = null
      let oldestAnyTime = Infinity

      for (const [key] of this.windows.entries()) {
        if (key === excludePartition) continue
        const st = this.getState(key)
        if (st.lastActivityAt < oldestAnyTime) {
          oldestAnyTime = st.lastActivityAt
          oldestAnyKey = key
        }
        if (st.busyCount === 0 && st.lastActivityAt < oldestIdleTime) {
          oldestIdleTime = st.lastActivityAt
          oldestIdleKey = key
        }
      }

      // Evict idle windows above maxLive (4), or oldest window if hitting hard RAM ceiling (6)
      const targetToClose = oldestIdleKey || (this.windows.size >= 6 ? oldestAnyKey : null)
      if (targetToClose) {
        this.closeWindow(targetToClose)
      } else {
        break
      }
    }
  }

  public acquireWindow(partition: string, showWorker = false): BrowserWindow {
    const existing = this.windows.get(partition)
    if (existing && !existing.isDestroyed()) {
      const st = this.getState(partition)
      st.busyCount += 1
      st.lastActivityAt = Date.now()
      return existing
    }

    this.enforceCapacity(partition)

    const win = new BrowserWindow({
      width: 1120,
      height: 760,
      show: showWorker,
      skipTaskbar: true,
      focusable: showWorker,
      title: `ViraAI Native Engine [${partition}]`,
      webPreferences: {
        partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        webSecurity: true,
        backgroundThrottling: false
      }
    })

    try {
      win.webContents.setMaxListeners(40)
    } catch {}

    if (!showWorker) {
      try {
        win.setOpacity(0)
      } catch {}
      try {
        win.setPosition(-32000, -32000, false)
      } catch {}
      win.hide()
    }

    try {
      win.webContents.setAudioMuted(true)
    } catch {}
    win.webContents.on('media-started-playing', () => {
      try {
        win.webContents.setAudioMuted(true)
      } catch {}
    })
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    applyAntiDetectToWindow(win, partition).catch(() => {})

    this.windows.set(partition, win)
    const st = this.getState(partition)
    st.busyCount += 1
    st.lastActivityAt = Date.now()

    win.on('closed', () => {
      this.windows.delete(partition)
      this.activity.delete(partition)
    })

    return win
  }

  public getExistingWindow(partition?: string): BrowserWindow | null {
    if (!partition) return null
    const win = this.windows.get(partition)
    return win && !win.isDestroyed() ? win : null
  }

  public releaseWindow(partition?: string): void {
    if (!partition) return
    const st = this.activity.get(partition)
    if (st) {
      st.busyCount = Math.max(0, st.busyCount - 1)
      st.lastActivityAt = Date.now()
      if (st.busyCount === 0) {
        const releasedAt = st.lastActivityAt
        setTimeout(() => {
          const now = this.activity.get(partition)
          if (now && now.busyCount === 0 && now.lastActivityAt === releasedAt) this.closeWindow(partition)
        }, NATIVE_WINDOW_IDLE_CLOSE_MS)
      }
    }
  }

  public closeWindow(partition: string): void {
    const win = this.windows.get(partition)
    if (win && !win.isDestroyed()) {
      try {
        win.destroy()
      } catch {}
    }
    this.windows.delete(partition)
    this.activity.delete(partition)
  }
}

export const globalDolaNativePool = new DolaNativeBrowserPool(4)

/**
 * Hybrid In-Page Direct Signed API Client for Dola (`https://www.dola.com`):
 * - Uses an Electron partition session (so per-account Proxies configured via `applyProxyToPartition` are respected).
 * - When `ensureNativeWindowReady()` is called, runs all `/chat/completion`, `/alice/message/pre_handle_v2_without_conv`,
 *   `/im/chain/single`, and `/im/chain/recent_conv` requests **inside a hidden `dola.com/chat` BrowserWindow**
 *   where `window.bdms` (`webmssdk`) attaches a real `a_bogus` signature and `localStorage` provides the profile's
 *   genuine `samantha_web_web_id` (`device_id`) and `_tea_cache_tokens_495671` (`web_id`).
 */
export class DolaHttpClient {
  private ses: Electron.Session
  private baseUrl: string
  private cookieMap: Record<string, string>
  private webTabId: string
  private partition?: string
  private nativeWin: BrowserWindow | null = null
  private acquiredFromPool = false

  constructor(
    ses: Electron.Session,
    cookieMap: Record<string, string>,
    baseUrl = 'https://www.dola.com',
    partition?: string
  ) {
    this.ses = ses
    this.baseUrl = baseUrl.replace(/\/+$/, '')
    this.cookieMap = { ...cookieMap }
    this.webTabId = crypto.randomUUID()
    this.partition = partition
  }

  public getCookieHeader(): string {
    return Object.entries(this.cookieMap)
      .filter(([k, v]) => Boolean(k && v))
      .map(([k, v]) => `${k}=${v}`)
      .join('; ')
  }

  /**
   * Acquires a hidden `BrowserWindow` for this account's partition, navigates to `https://www.dola.com/chat`,
   * and waits for ByteDance's `window.bdms` (`webmssdk`) signer AND `localStorage` (`samantha_web_web_id`) to initialize.
   */
  public async ensureNativeWindowReady(showWorker = false): Promise<BrowserWindow> {
    if (!this.partition) {
      throw new Error('DolaHttpClient cần partition để khởi tạo Native Engine Window.')
    }
    if (!this.nativeWin || this.nativeWin.isDestroyed()) {
      this.nativeWin = globalDolaNativePool.acquireWindow(this.partition, showWorker)
      this.acquiredFromPool = true
    }

    const fp = await applyAntiDetectToWindow(
      this.nativeWin,
      this.partition,
      this.cookieMap['_web_id'] || ''
    ).catch(() => getAccountFingerprint(this.partition || 'default'))

    if (!this.cookieMap['_web_id'] && fp.fallbackWebId) {
      this.cookieMap['_web_id'] = fp.fallbackWebId
    }

    const currentUrl = this.nativeWin.webContents.getURL()
    const initialCheck = currentUrl.includes('dola.com')
      ? await execJsWithTimeout(this.nativeWin, SIGNER_CHECK_SCRIPT, 3500)
      : null

    if (!currentUrl.includes('dola.com/chat') || !initialCheck || initialCheck.isErrorPage) {
      const loadedOk = await loadUrlWithTimeout(this.nativeWin, `${this.baseUrl}/chat`, 7500)
      if (!loadedOk && this.nativeWin && !this.nativeWin.isDestroyed()) {
        // Proxy dropped connection mid-handshake (ERR_CONNECTION_RESET) — bypass dead proxy immediately
        try {
          await this.ses.setProxy({ mode: 'direct' })
        } catch {}
        await loadUrlWithTimeout(this.nativeWin, `${this.baseUrl}/chat`, 7500)
      }
      await new Promise((r) => setTimeout(r, 1200))
    }

    // Wait up to 20s for window.bdms + localStorage samantha_web_web_id hydration
    const startWait = Date.now()
    const deadline = startWait + 20_000
    let signerReady = false
    let retriedReloadOnError = false
    while (Date.now() < deadline) {
      if (!this.nativeWin || this.nativeWin.isDestroyed()) {
        throw new Error('Cửa sổ Native Engine đã bị đóng.')
      }
      const check = await execJsWithTimeout(this.nativeWin, SIGNER_CHECK_SCRIPT, 3500)
      const elapsed = Date.now() - startWait
      if ((!check || check.isErrorPage) && !retriedReloadOnError && elapsed > 3000) {
        retriedReloadOnError = true
        try {
          await this.ses.setProxy({ mode: 'direct' })
        } catch {}
        await loadUrlWithTimeout(this.nativeWin, `${this.baseUrl}/chat`, 6500)
        await new Promise((r) => setTimeout(r, 1200))
        continue
      }
      if (check && check.ready && (check.hasSamanthaId || elapsed > 4000)) {
        signerReady = true
        break
      }
      await new Promise((r) => setTimeout(r, 800))
    }

    if (!signerReady) {
      this.closeNativeWindow()
      throw new Error(
        'PROXY_ERROR: Chữ ký bảo mật ByteDance (window.bdms / webmssdk) chưa sẵn sàng sau 20s (Proxy nghẽn hoặc trang lỗi).'
      )
    }

    // Proactively confirm 18+ age gate inside the page (non-blocking with 3s timeout)
    if (this.nativeWin && !this.nativeWin.isDestroyed()) {
      await execJsWithTimeout(
        this.nativeWin,
        `(() => {
          try {
            fetch('/alice/age_gate/report?aid=495671&device_platform=web', {
              method: 'POST',
              credentials: 'include',
              headers: { 'Content-Type': 'application/json', 'agw-js-conv': 'str' },
              body: JSON.stringify({ scene: 1, pass: true })
            }).catch(() => {});
          } catch (_) {}
        })()`,
        3000
      )
    }

    await this.syncFromPartition()
    return this.nativeWin
  }

  public async reloadNativeWindow(): Promise<void> {
    const win = this.getActiveNativeWindow()
    if (win && !win.isDestroyed()) {
      await loadUrlWithTimeout(win, `${this.baseUrl}/chat`, 7500)
      await new Promise((r) => setTimeout(r, 1500))
      await this.ensureNativeWindowReady(false)
    }
  }

  public releaseNativeWindow(): void {
    if (this.acquiredFromPool && this.partition) {
      globalDolaNativePool.releaseWindow(this.partition)
      this.acquiredFromPool = false
    }
  }

  public closeNativeWindow(): void {
    if (this.partition) {
      globalDolaNativePool.closeWindow(this.partition)
      this.acquiredFromPool = false
      this.nativeWin = null
    }
  }

  private getActiveNativeWindow(): BrowserWindow | null {
    if (this.nativeWin && !this.nativeWin.isDestroyed()) return this.nativeWin
    return globalDolaNativePool.getExistingWindow(this.partition)
  }

  /**
   * Synchronize `this.cookieMap` with live cookies from `this.ses.cookies` (including rotated `sessionid`, `sid_guard`, `msToken`, `ttwid`).
   */
  public async syncFromPartition(): Promise<void> {
    try {
      const all = await this.ses.cookies.get({})
      for (const c of all) {
        if (/dola\.com$/i.test(c.domain || '') && c.name && c.value) {
          this.cookieMap[c.name] = c.value
        }
      }
    } catch {}
  }

  public buildQueryParams(extra?: Record<string, string>): string {
    const canonicalWebId = this.cookieMap['_web_id'] || ''
    const region = (
      this.cookieMap['flow_user_country'] ||
      this.cookieMap['store-country-code'] ||
      'VN'
    ).toUpperCase()
    const p = new URLSearchParams({
      aid: DOLA_WEB_AID,
      real_aid: DOLA_WEB_AID,
      device_platform: 'web',
      doubao_device_platform: 'web',
      web_platform: 'browser',
      language: 'en',
      region,
      sys_region: region,
      pkg_type: 'release_version',
      version_code: '20800',
      samantha_web: '1',
      'use-olympus-account': '1',
      web_tab_id: this.webTabId
    })
    if (canonicalWebId) {
      p.set('device_id', canonicalWebId)
      p.set('web_id', canonicalWebId)
      p.set('tea_uuid', canonicalWebId)
    }
    if (this.cookieMap['msToken']) p.set('msToken', this.cookieMap['msToken'])
    if (this.cookieMap['s_v_web_id']) p.set('fp', this.cookieMap['s_v_web_id'])
    if (extra) {
      for (const [k, v] of Object.entries(extra)) {
        if (v !== undefined && v !== null) p.set(k, String(v))
      }
    }
    return p.toString()
  }

  public buildHeaders(
    accept = 'application/json, text/plain, */*',
    referer?: string,
    contentType = 'application/json'
  ): Record<string, string> {
    const cookieStr = this.getCookieHeader()
    const fp = getAccountFingerprint(this.partition || 'default')
    const headers: Record<string, string> = {
      Accept: accept,
      'Accept-Encoding': 'identity',
      'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
      'Content-Type': contentType,
      Origin: this.baseUrl,
      Referer: referer || `${this.baseUrl}/chat/`,
      'User-Agent': fp.userAgent || DEFAULT_UA,
      'agw-js-conv': 'str'
    }
    if (cookieStr) headers['Cookie'] = cookieStr
    return headers
  }

  /**
   * Step 1: Verify login status via `POST /alice/profile/self_brief`.
   * Uses in-page signed `fetch` when the account's Native Engine window is open.
   */
  public async selfBrief(useInPage = false): Promise<{
    ok: boolean
    id?: string
    nickname?: string
    code?: number
    isGuest?: boolean
    message?: string
  }> {
    try {
      await this.syncFromPartition()
      let win = this.getActiveNativeWindow()
      if (useInPage && !win && this.partition) {
        win = await this.ensureNativeWindowReady(false)
      }

      if (win && !win.isDestroyed()) {
        const inPageRes = await execJsWithTimeout(win, SESSION_VERIFY_SCRIPT, 10000)
        await this.syncFromPartition()
        if (inPageRes && inPageRes.authenticated) {
          return {
            ok: true,
            id: String(inPageRes.id || ''),
            nickname: String(inPageRes.nickname || ''),
            isGuest: false
          }
        }
        if (inPageRes && inPageRes.code !== undefined && inPageRes.code !== null) {
          return {
            ok: false,
            code: Number(inPageRes.code),
            isGuest: Boolean(inPageRes.isGuest),
            message: 'Phiên Dola đã hết hạn hoặc ở chế độ khách'
          }
        }
      }

      const resp = await this.ses.fetch(
        `${this.baseUrl}/alice/profile/self_brief?${this.buildQueryParams()}`,
        {
          method: 'POST',
          credentials: 'include',
          headers: this.buildHeaders(),
          body: '{}'
        }
      )
      await this.syncFromPartition()
      const data = (await resp.json().catch(() => null)) as Record<string, any> | null
      if (!data || typeof data !== 'object') {
        return {
          ok: false,
          code: undefined,
          isGuest: false,
          message: `HTTP ${resp.status} (Empty/Non-JSON response)`
        }
      }
      const brief = data?.data?.profile_brief || data?.data?.user || data?.data || {}
      const uid = String(brief?.id || brief?.user_id || brief?.user_id_str || '')
      const codeNum = data?.code !== undefined ? Number(data.code) : undefined
      const isGuest = Boolean(
        brief?.is_guest === true ||
          brief?.isGuest === true ||
          codeNum === 710012014 ||
          codeNum === 710012003 ||
          codeNum === 710012001
      )
      if (data?.code === 0 && uid && uid !== '0' && !isGuest) {
        return {
          ok: true,
          id: uid,
          nickname: String(brief.nickname || brief.user_name || brief.name || ''),
          isGuest: false
        }
      }
      return {
        ok: false,
        code: codeNum,
        isGuest,
        message: String(data?.message || data?.msg || 'Not logged in')
      }
    } catch (err: any) {
      return {
        ok: false,
        code: undefined,
        isGuest: false,
        message: err?.message || String(err)
      }
    }
  }

  /**
   * Step 2: Upload a local reference image to ByteDance ImageX.
   * Primary path: In-page `/alice/message/pre_handle_v2_without_conv` + AWS4 `ApplyImageUpload` + `/upload/v1/` + `CommitImageUpload` (HaLi AI engine).
   * Fallback path: `/alice/resource/prepare_upload`.
   */
  public async uploadImage(filePath: string): Promise<DolaUploadedAttachment> {
    if (!filePath || !fs.existsSync(filePath)) {
      throw new Error(`Không tìm thấy ảnh tham chiếu: ${filePath}`)
    }
    await this.syncFromPartition()
    const raw = fs.readFileSync(filePath)
    const ext = (path.extname(filePath) || '.png').toLowerCase()
    const fileName = path.basename(filePath)
    const { width, height } = probeImageDimensions(raw)

    let win = this.getActiveNativeWindow()
    if (!win && this.partition) {
      win = await this.ensureNativeWindowReady(false)
    }

    if (win && !win.isDestroyed()) {
      try {
        const preHandleRes = await win.webContents.executeJavaScript(`
          (async () => {
            const res = await fetch('/alice/message/pre_handle_v2_without_conv?aid=495671&device_platform=web', {
              method: 'POST',
              headers: { 'content-type': 'application/json', 'Agw-Js-Conv': 'str' },
              body: JSON.stringify({
                scene: 1,
                need_upload_credential: true
              }),
              credentials: 'include'
            });
            return await res.json();
          })()
        `)

        const credData =
          preHandleRes?.data?.upload_credential ||
          preHandleRes?.upload_credential ||
          preHandleRes?.data?.upload_auth_token ||
          preHandleRes?.upload_auth_token
        const ak = credData?.access_key_id || credData?.access_key
        const sk = credData?.secret_access_key || credData?.secret_key
        if (credData && ak && sk) {
          const region = credData.region || 'ap-southeast-1'
          const serviceId =
            credData.service_id || preHandleRes?.data?.service_id || 'k2431jgw'
          const imagexHost =
            credData.imagex_host ||
            preHandleRes?.data?.upload_host ||
            `imagex-${region}.bytevcloudapi.com`
          const credentials = {
            accessKey: String(ak),
            secretKey: String(sk),
            sessionToken: credData.session_token ? String(credData.session_token) : null,
            region
          }

          // 1. ApplyImageUpload
          const applyQuery = {
            Action: 'ApplyImageUpload',
            Version: '2018-08-01',
            ServiceId: String(serviceId),
            FileSize: String(raw.length),
            FileExtension: ext,
            s: crypto.randomBytes(6).toString('hex').slice(0, 11)
          }
          const applyHeaders = signImagexRequest({
            method: 'GET',
            host: imagexHost,
            query: applyQuery,
            credentials
          })
          const applyUrl = `https://${imagexHost}/?${canonicalQuery(applyQuery)}`
          const applyBuf = await fetchViaElectronNet(applyUrl, {
            method: 'GET',
            headers: applyHeaders,
            ses: this.ses
          })
          const applyJson = JSON.parse(applyBuf.toString('utf8'))
          const storeInfo = applyJson?.Result?.UploadAddress?.StoreInfos?.[0]
          const uploadHost = applyJson?.Result?.UploadAddress?.UploadHosts?.[0]
          const sessionKey = applyJson?.Result?.UploadAddress?.SessionKey

          if (storeInfo?.StoreUri && storeInfo?.Auth && uploadHost) {
            // 2. Binary Upload (/upload/v1/<StoreUri>)
            const binaryUrl = `https://${String(uploadHost)
              .replace(/^https?:\/\//i, '')
              .replace(/\/+$/, '')}/upload/v1/${String(storeInfo.StoreUri).replace(/^\/+/, '')}`
            await fetchViaElectronNet(binaryUrl, {
              method: 'POST',
              headers: {
                Authorization: String(storeInfo.Auth),
                'Content-Type': 'application/octet-stream'
              },
              body: raw,
              ses: this.ses
            })

            // 3. CommitImageUpload
            const commitQuery = {
              Action: 'CommitImageUpload',
              Version: '2018-08-01',
              ServiceId: String(serviceId)
            }
            const commitBody = JSON.stringify({ SessionKey: sessionKey })
            const commitHeaders = signImagexRequest({
              method: 'POST',
              host: imagexHost,
              query: commitQuery,
              body: commitBody,
              credentials
            })
            const commitUrl = `https://${imagexHost}/?${canonicalQuery(commitQuery)}`
            const commitBuf = await fetchViaElectronNet(commitUrl, {
              method: 'POST',
              headers: commitHeaders,
              body: commitBody,
              ses: this.ses
            })
            const commitJson = JSON.parse(commitBuf.toString('utf8'))
            const imageUri =
              commitJson?.Result?.Results?.[0]?.Uri ||
              commitJson?.Result?.Results?.[0]?.ImageUri ||
              String(storeInfo.StoreUri)

            return {
              uri: String(imageUri),
              url: `https://${uploadHost}/${imageUri}`,
              width,
              height,
              name: fileName,
              nativeAttachment: {
                type: 1,
                identifier: crypto.randomUUID(),
                image: {
                  name: fileName,
                  uri: String(imageUri),
                  image_ori: {
                    url: '',
                    width: 0,
                    height: 0,
                    format: '',
                    url_formats: {}
                  }
                },
                parse_state: 0,
                review_state: 1,
                upload_status: 1,
                progress: 100,
                src: ''
              }
            }
          }
        }
      } catch {}
    }

    // Fallback: /alice/resource/prepare_upload (use fetchViaElectronNet so Chromium never cancels cross-origin ImageX requests over Referer policy)
    const prepBuf = await fetchViaElectronNet(
      `${this.baseUrl}/alice/resource/prepare_upload?${this.buildQueryParams()}`,
      {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify({
          tenant_id: '5',
          scene_id: '4',
          resource_type: 2
        }),
        ses: this.ses
      }
    )
    const prepJson = (JSON.parse(prepBuf.toString('utf8') || '{}') || {}) as Record<string, any>
    if (prepJson?.code !== 0 || !prepJson?.data) {
      throw new Error(
        `prepare_upload thất bại (code=${prepJson?.code}): ${prepJson?.message || 'Unknown error'}`
      )
    }

    const info = prepJson.data
    const tok = info.upload_auth_token || {}
    const uploadHost = String(info.upload_host || '').trim()
    const serviceId = String(info.service_id || '').trim()
    if (!uploadHost || !serviceId || !tok.access_key || !tok.secret_key) {
      throw new Error('Dola prepare_upload thiếu thông tin ImageX token.')
    }

    const applyQs = new URLSearchParams({
      Action: 'ApplyImageUpload',
      Version: '2018-08-01',
      ServiceId: serviceId,
      FileSize: String(raw.length),
      FileExtension: ext,
      s: crypto.randomBytes(5).toString('hex')
    })
    const applyUrl = `https://${uploadHost}/?${applyQs.toString()}`
    const detectedRegionMatch = /^imagex-([a-z0-9-]+)\.bytevcloudapi\.com$/i.exec(uploadHost)
    const awsRegion = detectedRegionMatch?.[1] || 'ap-southeast-1'
    const awsHeaders = buildAws4Headers({
      accessKey: tok.access_key,
      secretKey: tok.secret_key,
      sessionToken: tok.session_token || '',
      region: awsRegion,
      service: 'imagex',
      method: 'GET',
      url: applyUrl
    })

    const applyBuf = await fetchViaElectronNet(applyUrl, {
      method: 'GET',
      headers: {
        ...awsHeaders,
        Accept: '*/*',
        'User-Agent': DEFAULT_UA
      },
      ses: this.ses
    })
    const applyJson = (JSON.parse(applyBuf.toString('utf8') || '{}') || {}) as Record<string, any>
    const addr = applyJson?.Result?.UploadAddress
    const storeInfo = addr?.StoreInfos?.[0]
    const storeHost = addr?.UploadHosts?.[0]
    if (!addr || !storeInfo?.StoreUri || !storeHost) {
      throw new Error(
        `ApplyImageUpload thất bại: ${JSON.stringify(applyJson?.ResponseMetadata || applyJson).slice(0, 200)}`
      )
    }

    const uri = String(storeInfo.StoreUri)
    const crc = crc32Hex(raw)
    const putUrl = `https://${storeHost}/${uri}`

    const putBuf = await fetchViaElectronNet(putUrl, {
      method: 'PUT',
      headers: {
        Authorization: String(storeInfo.Auth || ''),
        'Content-Type': 'application/octet-stream',
        'content-crc32': crc,
        'Content-Disposition': `attachment; filename="${encodeURIComponent(fileName)}"`,
        'User-Agent': DEFAULT_UA
      },
      body: raw,
      ses: this.ses
    })
    const putJson = (JSON.parse(putBuf.toString('utf8') || '{}') || {}) as Record<string, any>
    if (putJson?.code !== 2000) {
      throw new Error(`ImageX PUT thất bại: ${JSON.stringify(putJson).slice(0, 200)}`)
    }

    return {
      uri,
      url: `https://${storeHost}/${uri}`,
      width,
      height,
      name: fileName,
      nativeAttachment: {
        type: 1,
        identifier: crypto.randomUUID(),
        image: {
          name: fileName,
          uri,
          image_ori: {
            url: '',
            width: 0,
            height: 0,
            format: '',
            url_formats: {}
          }
        },
        parse_state: 0,
        review_state: 1,
        upload_status: 1,
        progress: 100,
        src: ''
      }
    }
  }

  /**
   * Reconciles the most recently created conversation ID via `POST /im/chain/recent_conv` (`cmd: 3200`)
   * inside the page when `/chat/completion` SSE did not return `conversation_id` immediately.
   * Strictly checks that the conversation contains a snippet of `promptText` so old unrelated conversations are never returned.
   */
  public async reconcileRecentConversation(
    promptText?: string,
    localMsgId?: string,
    localConvId?: string
  ): Promise<string | null> {
    const win = this.getActiveNativeWindow()
    if (!win || win.isDestroyed()) return null
    try {
      const res = await win.webContents.executeJavaScript(`
        (async () => {
          const url = new URL('/im/chain/recent_conv', location.origin);
          const params = {
            version_code: '20800',
            language: 'en',
            device_platform: 'web',
            doubao_device_platform: 'web',
            aid: '495671',
            real_aid: '495671',
            pkg_type: 'release_version',
            samantha_web: '1',
            web_platform: 'browser',
            'use-olympus-account': '1'
          };
          for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
          const res = await fetch(url, {
            method: 'POST',
            headers: {
              'accept': 'application/json, text/plain, */*',
              'content-type': 'application/json; encoding=utf-8',
              'Agw-Js-Conv': 'str'
            },
            body: JSON.stringify({
              cmd: 3200,
              uplink_body: {
                pull_recent_conv_chain_uplink_body: {
                  limit: 10,
                  message_count_per_conv: 5,
                  api_version: 1,
                  conv_version: 0,
                  direction: 3,
                  option: { not_need_message: false, need_complete_conversation: true }
                }
              },
              sequence_id: crypto.randomUUID(),
              channel: 2,
              version: '1'
            }),
            credentials: 'include'
          });
          if (!res.ok) return null;
          return await res.json();
        })()
      `)
      if (!res) return null

      const msgIdLower = String(localMsgId || '').trim().toLowerCase()
      const convIdLower = String(localConvId || '').trim().toLowerCase()
      const snippet = String(promptText || '')
        .replace(/\[Reference images:[\s\S]*$/i, '')
        .replace(/\[Seamless continuation[\s\S]*$/i, '')
        .replace(/^Seedance\s*-\s*Đây là hình ảnh[^.]*\.\s*/i, '')
        .replace(/^\s*Làm video[^:]*:\s*/i, '')
        .trim()
        .slice(0, 42)
        .toLowerCase()

      for (const obj of walkDolaNestedObjects(res)) {
        const cid = String(obj.conversation_id || obj.conv_id || '')
        if (!/^\d{12,}$/.test(cid) || cid === '0') continue
        const objStr = JSON.stringify(obj).toLowerCase()
        if (msgIdLower && objStr.includes(msgIdLower)) {
          return cid
        }
        if (convIdLower && objStr.includes(convIdLower)) {
          return cid
        }
      }
    } catch {}
    return null
  }

  /**
   * Step 3: Send prompt + `chat_ability` (`ability_type: 17`) + optional `imageBlocks`
   * via In-Page Direct Signed Fetch (`window.bdms` `a_bogus` + real `localStorage` `device_id`/`web_id` + `aid=495671`).
   */
  public async sendCompletion(params: {
    prompt: string
    abilityParam?: Record<string, any>
    imageBlocks?: Array<Record<string, any>>
    conversationId?: string
    chatMode?: 'fast' | 'pro'
  }): Promise<{
    conversationId: string
    events: Array<Record<string, any>>
    streamErrors: string[]
    sseText: string
    rawLen: number
  }> {
    let win = this.getActiveNativeWindow()
    if (!win && this.partition) {
      win = await this.ensureNativeWindowReady(false)
    }

    if (win && !win.isDestroyed()) {
      const identityData = await execJsWithTimeout(win, IDENTITY_READER_SCRIPT, 5000)
      const ident = identityData?.identity || {}
      const deviceId = String(ident.deviceId || this.cookieMap['_web_id'] || '')
      const webId = String(ident.webId || deviceId || '')

      const submitUrl = new URL(`${this.baseUrl}/chat/completion`)
      submitUrl.searchParams.set('aid', DOLA_WEB_AID)
      submitUrl.searchParams.set('device_platform', 'web')
      submitUrl.searchParams.set('doubao_device_platform', 'web')
      submitUrl.searchParams.set('language', 'en')
      submitUrl.searchParams.set('pc_version', '2.51.0')
      submitUrl.searchParams.set('pkg_type', 'release_version')
      submitUrl.searchParams.set('real_aid', DOLA_WEB_AID)
      submitUrl.searchParams.set('samantha_web', '1')
      submitUrl.searchParams.set('use-olympus-account', '1')
      submitUrl.searchParams.set('version_code', '20800')
      submitUrl.searchParams.set('web_platform', 'browser')
      if (deviceId) submitUrl.searchParams.set('device_id', deviceId)
      if (webId) {
        submitUrl.searchParams.set('web_id', webId)
        submitUrl.searchParams.set('tea_uuid', webId)
      }
      if (ident.webTabId) submitUrl.searchParams.set('web_tab_id', String(ident.webTabId))
      if (ident.s_v_web_id) submitUrl.searchParams.set('fp', String(ident.s_v_web_id))
      if (ident.region) {
        submitUrl.searchParams.set('region', String(ident.region))
        submitUrl.searchParams.set('sys_region', String(ident.region))
      }
      if (ident.timezone) submitUrl.searchParams.set('tz_name', String(ident.timezone))

      const nativeAttachments: Array<Record<string, any>> = []
      for (const blk of params.imageBlocks || []) {
        if (blk && typeof blk._nativeAttachment === 'object') {
          nativeAttachments.push(blk._nativeAttachment)
        } else if (blk?.UniqueKey) {
          nativeAttachments.push({
            type: 1,
            identifier: crypto.randomUUID(),
            image: {
              name: blk?.content?.attachment_block?.name || 'ref.png',
              uri: String(blk.UniqueKey),
              image_ori: { url: '', width: 0, height: 0, format: '', url_formats: {} }
            },
            parse_state: 0,
            review_state: 1,
            upload_status: 1,
            progress: 100,
            src: ''
          })
        }
      }

      const envelope = buildDolaWebSubmitEnvelope({
        text: params.prompt,
        userInputContent: params.abilityParam?.userInputContent,
        model: params.abilityParam?.model || 'seedance_v2.5',
        duration: Number(params.abilityParam?.duration) || 15,
        ratio: params.abilityParam?.ratio || '16:9',
        chatMode: params.chatMode || 'fast',
        conversationId: params.conversationId,
        attachments: nativeAttachments
      })
      const isNewFastConv = !params.conversationId && params.chatMode !== 'pro'
      const skillUpdateUrl = new URL(`${this.baseUrl}/samantha/skill/update_order`)
      submitUrl.searchParams.forEach((v, k) => skillUpdateUrl.searchParams.set(k, v))
      const localMsgId = String(
        envelope?.messages?.[envelope.messages.length - 1]?.local_message_id ||
          envelope?.messages?.[0]?.local_message_id ||
          ''
      )
      const localConvId = String(
        envelope?.client_meta?.local_conversation_id || envelope?.local_conversation_id || ''
      )
      const bodyJson = JSON.stringify(envelope)

      const fetchCode = `
      (async () => {
        const fuseKey = ${JSON.stringify(localMsgId || localConvId)};
        window.__viraSendFuseSet = window.__viraSendFuseSet || new Set();
        if (fuseKey && window.__viraSendFuseSet.has(fuseKey)) {
          return {
            status: 499,
            ok: false,
            conversationId: null,
            rawText: 'BlockedByClient: duplicate /chat/completion prevented by armSendFuse',
            rawLen: 0,
            errorMsg: 'BlockedByClient'
          };
        }
        if (fuseKey) window.__viraSendFuseSet.add(fuseKey);
        const bodyText = ${JSON.stringify(bodyJson)};
        const targetUrl = ${JSON.stringify(submitUrl.toString())};
        const shouldUpdateSkill = ${JSON.stringify(isNewFastConv)};
        const skillUrl = ${JSON.stringify(skillUpdateUrl.toString())};
        if (shouldUpdateSkill) {
          try {
            await fetch(skillUrl, {
              method: 'POST',
              headers: {
                'accept': 'application/json, text/plain, */*',
                'content-type': 'application/json',
                'Agw-Js-Conv': 'str'
              },
              body: JSON.stringify({
                input_skill: [
                  { skill_type: 17 },
                  { skill_type: 2 },
                  { skill_type: 3 },
                  { skill_type: 5 },
                  { skill_type: 11 }
                ],
                latest_used_skill: 17
              }),
              credentials: 'include'
            });
          } catch (_) {}
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 600000);
        let keepStreamAliveInBg = false;
        try {
          const response = await fetch(targetUrl, {
            method: 'POST',
            headers: {
              'accept': 'text/event-stream',
              'content-type': 'application/json',
              'Agw-Js-Conv': 'str'
            },
            body: bodyText,
            credentials: 'include',
            signal: controller.signal
          });
          const reader = response.body && response.body.getReader ? response.body.getReader() : null;
          const decoder = new TextDecoder();
          let text = '';
          let conversationId = null;
          let errorMsg = null;
          let ackSeenAt = 0;

          if (reader) {
            while (text.length < 5000000) {
              const part = await reader.read();
              if (part.done) break;
              const chunk = decoder.decode(part.value, { stream: true });
              text += chunk;

              const convMatch = text.match(/"conversation_id"\\s*:\\s*\\\\?"?(\\d{8,})\\\\?"?/);
              if (convMatch && convMatch[1] !== '0') {
                conversationId = convMatch[1];
              }

              const errEvtIdx = text.search(/event:\\s*STREAM_ERROR/i);
              if (errEvtIdx >= 0 || /"error_code"\\s*:\\s*[1-9]\\d*/.test(text)) {
                errorMsg = 'STREAM_ERROR';
                if (/data:\\s*\\{[^\\r\\n]*\\}/i.test(text.slice(Math.max(0, errEvtIdx)))) {
                  break;
                }
              }

              if (/event:\\s*SSE_ACK/i.test(text) && conversationId) {
                if (!ackSeenAt) ackSeenAt = Date.now();
                // Wait until Dola sends follow-up chunks (creation/tool call/heartbeat) or 3.5s without error,
                // then hand off the reader to drain in background WITHOUT cancelling the HTTP stream!
                if (
                  Date.now() - ackSeenAt >= 3500 ||
                  /creation_block|seedance|SSE_HEARTBEAT|message_stream/i.test(text)
                ) {
                  keepStreamAliveInBg = true;
                  (async () => {
                    try {
                      while (true) {
                        const next = await reader.read();
                        if (next.done) break;
                      }
                    } catch (_) {
                    } finally {
                      clearTimeout(timer);
                    }
                  })();
                  break;
                }
              }
            }
            if (!keepStreamAliveInBg) {
              try { await reader.cancel(); } catch (_) {}
            }
          } else {
            text = await response.text();
            const convMatch = text.match(/"conversation_id"\\s*:\\s*\\\\?"?(\\d{8,})\\\\?"?/);
            if (convMatch && convMatch[1] !== '0') conversationId = convMatch[1];
          }

          return {
            status: response.status,
            ok: response.ok,
            conversationId,
            rawText: text.slice(0, 32000),
            rawLen: text.length,
            errorMsg
          };
        } finally {
          if (!keepStreamAliveInBg) {
            clearTimeout(timer);
          }
        }
      })()
      `

      let submitRes: any = null
      try {
        submitRes = await execJsWithTimeout(win, fetchCode, 45000)
        if (!submitRes) throw new Error('In-page fetch quá thời gian phản hồi (45s)')
      } catch (err: any) {
        const reconciledId = await this.reconcileRecentConversation(
          params.prompt,
          localMsgId,
          localConvId
        )
        if (reconciledId) {
          submitRes = {
            ok: true,
            status: 200,
            conversationId: reconciledId,
            rawText: '',
            rawLen: 0
          }
        } else {
          throw new Error(`Gửi yêu cầu In-Page thất bại: ${err?.message || String(err)}`)
        }
      }

      await this.syncFromPartition()

      if (!submitRes || !submitRes.ok) {
        const errDetail = submitRes
          ? `HTTP ${submitRes.status}: ${String(submitRes.rawText || '').slice(0, 200)}`
          : 'Không có phản hồi'
        throw new Error(`/chat/completion từ chối yêu cầu: ${errDetail}`)
      }

      const rawText = String(submitRes.rawText || '')
      let extractedCid = String(
        submitRes.conversationId ||
          (params.conversationId && params.conversationId !== '0' ? params.conversationId : '')
      )
      const events: Array<Record<string, any>> = []
      const streamErrors: string[] = []
      const sseTextParts: string[] = []

      for (const line of rawText.split(/\r?\n/)) {
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (!payload) continue
        if (payload.includes('error_code')) {
          streamErrors.push(payload)
        }
        if (!extractedCid) {
          const m = /conversation_id\\*"\s*:\s*\\*"(\d{6,})/.exec(payload)
          if (m && m[1] && m[1] !== '0') extractedCid = m[1]
        }
        try {
          const ev = JSON.parse(payload)
          if (ev && typeof ev === 'object') {
            events.push(ev)
            if (ev.event_type === 2001 && typeof ev.event_data === 'string') {
              const ed = JSON.parse(ev.event_data)
              for (const p of ed?.patch_op || []) {
                for (const b of p?.patch_value?.content_block || []) {
                  const t = b?.content?.text_block?.text
                  if (t) sseTextParts.push(String(t))
                }
              }
            }
          }
        } catch {}
      }

      if (!extractedCid && (streamErrors.length === 0 || rawText.includes('"ack":"1"'))) {
        const reconciled = await this.reconcileRecentConversation(
          params.prompt,
          localMsgId,
          localConvId
        )
        if (reconciled) extractedCid = reconciled
      }

      return {
        conversationId: extractedCid,
        events,
        streamErrors,
        sseText: sseTextParts.join('').trim(),
        rawLen: Number(submitRes.rawLen || rawText.length)
      }
    }

    // Fallback when no partition window is available
    const convId = params.conversationId || '0'
    const blocks: Array<Record<string, any>> = [...(params.imageBlocks || [])]
    blocks.push({
      local_block_id: crypto.randomUUID(),
      block_type: 10000,
      content: {
        text_block: {
          text: params.prompt,
          icon_url: '',
          icon_url_dark: '',
          summary: ''
        },
        pc_event_block: ''
      }
    })

    const body = {
      messages: [
        {
          local_message_id: crypto.randomUUID(),
          content_block: blocks,
          message_status: 0
        }
      ],
      completion_option: {
        is_regen: false,
        with_suggest: false,
        need_create_conversation: convId === '0',
        launch_stage: 1,
        is_replace: false,
        is_delete: false,
        message_from: 0,
        use_auto_cot: false,
        resend_for_regen: false,
        enable_commerce_credit: false,
        event_id: '0',
        chat_ability: params.abilityParam
          ? {
              ability_type: 17,
              ability_param: JSON.stringify(params.abilityParam)
            }
          : {}
      },
      evaluate_option: { web_ab_params: '' },
      section_id: '0',
      conversation_id: convId,
      local_conversation_id: `local_${Date.now()}${Math.floor(Math.random() * 900 + 100)}`,
      bot_id: DOLA_BOT_ID,
      ext: {
        loc_time: new Date().toISOString().slice(0, 19),
        use_deep_think: '0',
        fp: this.cookieMap['s_v_web_id'] || '',
        answer_with_suggest: '0',
        sub_conv_firstmet_type: '1',
        collection_id: '',
        conversation_init_option: JSON.stringify({ need_ack_conversation: true }),
        commerce_credit_config_enable: '0'
      }
    }

    await this.syncFromPartition()
    const resp = await this.ses.fetch(
      `${this.baseUrl}/chat/completion?${this.buildQueryParams()}`,
      {
        method: 'POST',
        credentials: 'include',
        headers: this.buildHeaders('text/event-stream'),
        body: JSON.stringify(body)
      }
    )
    await this.syncFromPartition()

    const rawText = await resp.text()
    if (!resp.ok) {
      throw new Error(`/chat/completion HTTP ${resp.status}: ${rawText.slice(0, 180)}`)
    }

    let extractedCid = convId !== '0' ? convId : ''
    const events: Array<Record<string, any>> = []
    const streamErrors: string[] = []
    const sseTextParts: string[] = []

    for (const line of rawText.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (!payload) continue
      if (payload.includes('error_code')) {
        streamErrors.push(payload)
      }
      if (!extractedCid) {
        const m = /conversation_id\\*"\s*:\s*\\*"(\d{6,})/.exec(payload)
        if (m && m[1]) extractedCid = m[1]
      }
      try {
        const ev = JSON.parse(payload)
        if (ev && typeof ev === 'object') {
          events.push(ev)
          if (ev.event_type === 2001 && typeof ev.event_data === 'string') {
            const ed = JSON.parse(ev.event_data)
            for (const p of ed?.patch_op || []) {
              for (const b of p?.patch_value?.content_block || []) {
                const t = b?.content?.text_block?.text
                if (t) sseTextParts.push(String(t))
              }
            }
          }
        }
      } catch {}
    }

    if (!extractedCid) {
      const mFallback = /conversation_id\\*"\s*:\s*\\*"(\d{6,})/.exec(rawText)
      if (mFallback && mFallback[1]) extractedCid = mFallback[1]
    }

    return {
      conversationId: extractedCid,
      events,
      streamErrors,
      sseText: sseTextParts.join('').trim(),
      rawLen: rawText.length
    }
  }

  /**
   * Step 4: Poll conversation chain via `POST /im/chain/single` (`cmd: 3100`).
   * Executes inside the `dola.com/chat` page context with `samantha_web_web_id` (`device_id`)
   * and `_tea_cache_tokens_495671` (`web_id`) when the Native Engine window is active.
   */
  public async pullChain(
    conversationId: string,
    limit = 100
  ): Promise<{ messages: DolaChainMessage[]; rawText: string; cleanVideoUrls: string[] }> {
    const win = this.getActiveNativeWindow()
    if (win && !win.isDestroyed()) {
      const chainPayload = {
        cmd: 3100,
        uplink_body: {
          pull_singe_chain_uplink_body: {
            conversation_id: String(conversationId),
            anchor_index: 999999999,
            conversation_type: 3,
            direction: 1,
            limit,
            ext: {},
            filter: { index_list: [] }
          }
        },
        sequence_id: crypto.randomUUID(),
        channel: 2,
        version: '1'
      }

      const pollScript = `
      (async () => {
        const url = new URL('/im/chain/single', location.origin);
        const readJson = (key) => { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (_) { return null; } };
        const cookieStr = document.cookie || '';
        const readCookie = (name) => {
          const m = cookieStr.match(new RegExp('(?:^|;\\\\s*)' + name + '=([^;]+)'));
          return m ? decodeURIComponent(m[1]) : '';
        };
        const samantha = readJson('samantha_web_web_id');
        const tea = readJson('_tea_cache_tokens_495671');
        const canonicalWebId = readCookie('_web_id') || (samantha && samantha.web_id) || (tea && tea.web_id) || '';
        const region = localStorage.getItem('flow_user_country') || readCookie('flow_user_country') || (readCookie('store-country-code') || 'VN').toUpperCase();
        const params = {
          version_code: '20800',
          language: 'en',
          device_platform: 'web',
          doubao_device_platform: 'web',
          aid: '495671',
          real_aid: '495671',
          pkg_type: 'release_version',
          device_id: canonicalWebId,
          web_id: canonicalWebId,
          tea_uuid: canonicalWebId,
          region,
          sys_region: region,
          samantha_web: '1',
          web_platform: 'browser',
          'use-olympus-account': '1'
        };
        for (const [k, v] of Object.entries(params)) if (v) url.searchParams.set(k, v);
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'accept': 'application/json, text/plain, */*',
            'content-type': 'application/json; encoding=utf-8',
            'Agw-Js-Conv': 'str'
          },
          body: JSON.stringify(${JSON.stringify(chainPayload)}),
          credentials: 'include'
        });
        if (!res.ok) return { ok: false, status: res.status };
        const data = await res.json();
        return { ok: true, data };
      })()
      `

      const pollRes = await execJsWithTimeout(win, pollScript, 12000)
      if (pollRes && pollRes.ok && pollRes.data) {
        const rawText = JSON.stringify(pollRes.data)
        return {
          messages: parseDolaChainMessages(pollRes.data),
          rawText,
          cleanVideoUrls: extractCleanVideoUrlsFromJson(rawText)
        }
      }
    }

    const body = {
      cmd: 3100,
      uplink_body: {
        pull_singe_chain_uplink_body: {
          conversation_id: String(conversationId),
          anchor_index: 999999999,
          conversation_type: 3,
          direction: 1,
          limit,
          ext: {},
          filter: { index_list: [] }
        }
      },
      sequence_id: crypto.randomUUID(),
      channel: 2,
      version: '1'
    }

    await this.syncFromPartition()
    const resp = await this.ses.fetch(
      `${this.baseUrl}/im/chain/single?${this.buildQueryParams()}`,
      {
        method: 'POST',
        credentials: 'include',
        headers: this.buildHeaders(
          'application/json, text/plain, */*',
          `${this.baseUrl}/chat/${conversationId}`,
          'application/json; encoding=utf-8'
        ),
        body: JSON.stringify(body)
      }
    )

    const rawText = await resp.text()
    let data: Record<string, any> = {}
    try {
      data = JSON.parse(rawText)
    } catch {}

    if (data?.status_code) {
      throw new Error(
        `im/chain/single status ${data.status_code} ${data.status_desc || ''}`.trim()
      )
    }

    return {
      messages: parseDolaChainMessages(data),
      rawText,
      cleanVideoUrls: extractCleanVideoUrlsFromJson(rawText)
    }
  }

  /**
   * Step 5: Extract unwatermarked URL (`lr=unwatermarked`) via:
   * 1. `fallback_api` (`logo_type=unwatermarked`) + AES-128-CBC `qAAB` decryption
   * 2. `POST /creativity/resource/get_without_watermark?device_platform=web` (`body: JSON.stringify({ vid: [vid] })`)
   * 3. `POST /samantha/video/get_play_info?aid=495671&device_platform=web` (`{ vid }`)
   */
  public async getNoLogoUrl(
    videoModel: Record<string, any>,
    vidHint?: string
  ): Promise<{ url: string; info?: Record<string, any> }> {
    const fb = String(videoModel?.fallback_api || '').trim()
    const keySeed = String(videoModel?.key_seed || '').trim()
    const resolvedVid = String(
      vidHint || videoModel?.video_id || videoModel?.vid || ''
    ).trim()

    if (fb) {
      await this.syncFromPartition()
      const res = await fetchDolaNoLogoUrlFromFallbackApi(
        this.ses,
        fb,
        this.getCookieHeader(),
        this.baseUrl,
        keySeed
      )
      if (res.url) return res
    }

    const directExtracted = extractDecryptedUrlsFromDolaPayload(
      videoModel,
      keySeed ? [keySeed] : [],
      false
    )
    if (directExtracted.unwatermarkedUrls[0]) {
      return { url: directExtracted.unwatermarkedUrls[0], info: directExtracted.bestInfo }
    }

    // Query `/creativity/resource/get_without_watermark?device_platform=web` with `{ vid: [resolvedVid] }` (`playInfoExpr`)
    if (resolvedVid) {
      const win = this.getActiveNativeWindow()
      if (win && !win.isDestroyed()) {
        try {
          const playInfoRes = await execJsWithTimeout(
            win,
            `(async () => {
              const vid = ${JSON.stringify(resolvedVid)};
              try {
                const wres = await fetch('/creativity/resource/get_without_watermark?device_platform=web', {
                  method: 'POST',
                  credentials: 'include',
                  headers: { 'content-type': 'application/json', 'agw-js-conv': 'str' },
                  body: JSON.stringify({ vid: [vid] })
                });
                if (wres.ok) {
                  const wjson = await wres.json();
                  const cleanUrl =
                    wjson?.data?.download_video?.[vid]?.download_url ||
                    wjson?.data?.download_video?.[vid]?.main_url ||
                    wjson?.data?.[vid]?.download_url;
                  if (cleanUrl && typeof cleanUrl === 'string' && cleanUrl.startsWith('http')) {
                    return { url: cleanUrl, withoutWatermark: Boolean(wjson?.data?.without_watermark) };
                  }
                }
              } catch (_) {}
              try {
                const pres = await fetch('/samantha/video/get_play_info?aid=495671&device_platform=web', {
                  method: 'POST',
                  credentials: 'include',
                  headers: { 'content-type': 'application/json', 'agw-js-conv': 'str' },
                  body: JSON.stringify({ vid })
                });
                if (pres.ok) {
                  const pjson = await pres.json();
                  return { playInfoJson: JSON.stringify(pjson) };
                }
              } catch (_) {}
              return null;
            })()`,
            10000
          )
          if (playInfoRes?.url) {
            return { url: String(playInfoRes.url) }
          }
          if (playInfoRes?.playInfoJson) {
            const pExtracted = extractDecryptedUrlsFromDolaPayload(
              String(playInfoRes.playInfoJson),
              keySeed ? [keySeed] : [],
              false
            )
            if (pExtracted.unwatermarkedUrls[0]) {
              return { url: pExtracted.unwatermarkedUrls[0], info: pExtracted.bestInfo }
            }
          }
        } catch {}
      }
    }

    return { url: '' }
  }

  public getWatermarkedUrl(videoModel: Record<string, any>, fallback = ''): string {
    const extracted = extractDecryptedUrlsFromDolaPayload(videoModel)
    if (extracted.unwatermarkedUrls[0]) return extracted.unwatermarkedUrls[0]
    if (extracted.allDecryptedUrls[0]) return extracted.allDecryptedUrls[0]
    return fallback
  }
}

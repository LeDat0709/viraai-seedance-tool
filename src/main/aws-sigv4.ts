/**
 * Pure pieces of AWS SigV4 used to sign ByteDance ImageX upload requests (no electron imports, so tests run).
 */

/**
 * AWS SigV4 sorts by code point — uppercase before lowercase. `localeCompare` is case-insensitive and put
 * ImageX's lowercase `s` param before `ServiceId`, so every upload was rejected as SignatureDoesNotMatch.
 */
export function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

export function rfc3986(str: string): string {
  return encodeURIComponent(String(str)).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()
  )
}

export function canonicalQuery(params: Record<string, string>): string {
  return Object.entries(params || {})
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => [rfc3986(k), rfc3986(v)])
    .sort((a, b) => byCodePoint(a[0], b[0]))
    .map(([k, v]) => k + '=' + v)
    .join('&')
}

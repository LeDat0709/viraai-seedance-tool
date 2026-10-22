/** Longest an IP is reused when the provider didn't report a TTL. */
export const DEFAULT_PROXY_KEEP_MS = 60 * 60_000
/** Rotate this long before the provider's TTL runs out, so a render never starts on a dying IP. */
export const PROXY_TTL_SAFETY_MS = 90_000

/** Longest we'll block a login/render waiting out a provider's rotate cooldown. */
export const MAX_ROTATE_WAIT_SEC = 70

/**
 * Seconds TopProxy says to wait before it hands out a new IP ("Con 42s moi co the doi proxy"),
 * or 0 if the message isn't a cooldown we're willing to wait for.
 */
export function rotateCooldownSec(message: string | undefined): number {
  const sec = Number(/C[oò]n\s+(\d+)\s*s/i.exec(message || '')?.[1])
  return sec > 0 && sec <= MAX_ROTATE_WAIT_SEC ? sec : 0
}

/**
 * How long the current rotating-proxy IP may be reused. TopProxy IPs live only for the TTL it reports
 * ("TTL 1187s" in the status message); past it the proxy resets every connection and Dola never loads.
 */
export function proxyKeepMs(statusMessage: string | undefined): number {
  const ttlSec = Number(/TTL\s+(\d+)s/i.exec(statusMessage || '')?.[1])
  if (!ttlSec) return DEFAULT_PROXY_KEEP_MS
  return Math.max(0, Math.min(DEFAULT_PROXY_KEEP_MS, ttlSec * 1000 - PROXY_TTL_SAFETY_MS))
}

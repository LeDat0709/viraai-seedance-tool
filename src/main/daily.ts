// Pure daily-rollover helpers (no electron imports → unit-testable in isolation).

/** Local calendar day as YYYY-MM-DD. Uses LOCAL time so "hôm nay" matches the user's clock. */
export function localDayKey(d: Date = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

type DailyCounted = { videosToday: number; videosTodayDate?: string }

/**
 * Returns a new copy with videosToday reset to 0 when it belongs to a past day;
 * returns the SAME reference when nothing needs to change (stable for change-detection).
 */
export function rolledOver<T extends DailyCounted>(acc: T, today: string): T {
  if (acc.videosToday !== 0 && acc.videosTodayDate !== today) {
    return { ...acc, videosToday: 0, videosTodayDate: today }
  }
  return acc
}

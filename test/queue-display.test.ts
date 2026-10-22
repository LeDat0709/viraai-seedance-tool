import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  cleanProgressText,
  errorLabelOf,
  DAILY_VIDEO_LIMIT_ESTIMATE,
  estimateCapacity,
  failureKindOf,
  findPromptRisk,
  groupFailures,
  localDayKeyOf,
  stepIndexOf
} from '../src/renderer/src/components/queue-display.ts'

test('stepIndexOf maps engine statuses to card steps, queued = waiting', () => {
  assert.equal(stepIndexOf('queued'), -1)
  assert.equal(stepIndexOf('preparing'), 0)
  assert.equal(stepIndexOf('uploading'), 0)
  assert.equal(stepIndexOf('submitting'), 1)
  assert.equal(stepIndexOf('polling'), 2)
  assert.equal(stepIndexOf('downloading'), 3)
})

test('errorLabelOf gives a short label per error code, generic fallback otherwise', () => {
  assert.equal(errorLabelOf({ status: 'failed', errorCode: 'QUOTA_EXHAUSTED' }), 'Nick hết lượt')
  assert.equal(errorLabelOf({ status: 'failed', errorCode: 'PROXY_ERROR' }), 'Lỗi kết nối Proxy')
  assert.equal(errorLabelOf({ status: 'failed', errorCode: 'WHATEVER' }), 'Tạo video thất bại')
  assert.equal(errorLabelOf({ status: 'cancelled' }), 'Đã dừng')
})

test('cleanProgressText drops the engine tag and trailing conversation id', () => {
  assert.equal(
    cleanProgressText('[Native Engine] Đang dựng 10s trên Dola (61s) — #496209…'),
    'Đang dựng 10s trên Dola (61s)'
  )
  assert.equal(cleanProgressText('Đang chờ trong hàng đợi…'), 'Đang chờ trong hàng đợi…')
  assert.equal(cleanProgressText(undefined), '')
})

test('failureKindOf: refused → edit, sent + timed out → recover, the rest → retry', () => {
  assert.equal(failureKindOf({ status: 'failed', errorCode: 'CONTENT_REFUSED' }), 'edit')
  assert.equal(
    failureKindOf({
      status: 'failed',
      errorCode: 'GENERAL_ERROR',
      conversationId: '384182',
      errorMessage: '[Native Engine] Quá thời gian chờ (12 phút) khi dựng 10s.'
    }),
    'recover'
  )
  // timed out but never reached Dola: nothing to collect
  assert.equal(
    failureKindOf({ status: 'failed', errorCode: 'GENERAL_ERROR', errorMessage: 'Quá thời gian chờ (12 phút)' }),
    'retry'
  )
  assert.equal(failureKindOf({ status: 'failed', errorCode: 'PRO_BUSY' }), 'retry')
  assert.equal(
    errorLabelOf({ status: 'failed', errorCode: 'GENERAL_ERROR', conversationId: 'x', errorMessage: 'Quá thời gian chờ' }),
    'Hết thời gian chờ'
  )
})

test('groupFailures buckets only failed tasks', () => {
  const g = groupFailures([
    { id: 'a', status: 'failed', errorCode: 'PRO_BUSY' },
    { id: 'b', status: 'failed', errorCode: 'CONTENT_REFUSED' },
    { id: 'c', status: 'queued', errorCode: 'PRO_BUSY' }
  ] as any)
  assert.deepEqual(g.retry.map((t) => t.id), ['a'])
  assert.deepEqual(g.edit.map((t) => t.id), ['b'])
  assert.equal(g.recover.length, 0)
})

test('estimateCapacity sums today credits of ready accounts and counts unknown ones apart', () => {
  const today = '2026-10-20'
  const r = estimateCapacity(
    [
      { enabled: true, status: 'ready', creditsLeft: 3, creditsLeftDate: today },
      { enabled: true, status: 'ready', creditsLeft: 5, creditsLeftDate: '2026-10-19' }, // stale → unknown
      { enabled: true, status: 'ready' },
      { enabled: true, status: 'expired', creditsLeft: 9, creditsLeftDate: today },
      { enabled: false, status: 'ready', creditsLeft: 9, creditsLeftDate: today }
    ] as any,
    today
  )
  assert.equal(r.knownCredits, 3)
  assert.equal(r.unknownAccounts, 2)
  assert.equal(localDayKeyOf(new Date(2026, 0, 5)), '2026-01-05')
})

test('estimateCapacity guesses unknown accounts from the observed daily limit minus today usage', () => {
  const today = '2026-10-20'
  const r = estimateCapacity(
    [
      { enabled: true, status: 'ready', creditsLeft: 2, creditsLeftDate: today, videosToday: 4 }, // known → 2
      { enabled: true, status: 'ready', videosToday: 1 }, // unknown → limit - 1
      { enabled: true, status: 'ready', videosToday: DAILY_VIDEO_LIMIT_ESTIMATE + 3 }, // never negative
      { enabled: true, status: 'quota_exhausted', videosToday: 0 } // spent → 0
    ] as any,
    today
  )
  assert.equal(r.estimatedCredits, 2 + (DAILY_VIDEO_LIMIT_ESTIMATE - 1))
})

test('findPromptRisk flags a child with distress, not either alone', () => {
  assert.ok(findPromptRisk('pale-skinned White girl, 5 years old, abandoned in the snow, crying'))
  assert.ok(findPromptRisk('Một bé gái bị bỏ rơi giữa trời lạnh cóng'))
  assert.equal(findPromptRisk('A girl dances happily in a sunny park'), undefined)
  assert.equal(findPromptRisk('An old man is crying in the rain'), undefined)
})

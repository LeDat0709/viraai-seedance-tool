import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BURST_WINDOW_MS,
  describeAllLoggedOut,
  isMultiAccountBurst,
  isSessionDead,
  readSelfBrief,
  recordAccountEvent
} from '../src/main/auth-guard.ts'

test('readSelfBrief: uid means logged in', () => {
  assert.equal(readSelfBrief({ code: 0, data: { profile_brief: { user_id_str: '7412' } } }), 'logged_in')
  assert.equal(readSelfBrief({ code: 0, data: { user_id: 7412 } }), 'logged_in')
})

test('readSelfBrief: error code or empty identity means logged out', () => {
  assert.equal(readSelfBrief({ code: 710012001, msg: 'not login' }), 'logged_out')
  assert.equal(readSelfBrief({ code: 0, data: { profile_brief: { user_id_str: '0' } } }), 'logged_out')
  assert.equal(readSelfBrief({ code: 0, data: {} }), 'logged_out')
})

test('readSelfBrief: unreadable answers stay unknown', () => {
  assert.equal(readSelfBrief(null), 'unknown')
  assert.equal(readSelfBrief('<html>'), 'unknown')
  assert.equal(readSelfBrief({ code: 0 }), 'unknown')
})

test('isSessionDead: server verdict beats stale cookies, unknown falls back', () => {
  assert.equal(isSessionDead('logged_out', false), true)
  assert.equal(isSessionDead('logged_in', true), false)
  assert.equal(isSessionDead('unknown', true), true)
  assert.equal(isSessionDead('unknown', false), false)
})

test('isMultiAccountBurst needs 2 different accounts inside the window', () => {
  const t0 = 1_000_000
  const one = recordAccountEvent([], 'a', t0)
  assert.equal(isMultiAccountBurst(one, t0), false)

  const sameAcc = recordAccountEvent(one, 'a', t0 + 1000)
  assert.equal(isMultiAccountBurst(sameAcc, t0 + 1000), false)

  const two = recordAccountEvent(one, 'b', t0 + 2000)
  assert.equal(isMultiAccountBurst(two, t0 + 2000), true)
  assert.equal(isMultiAccountBurst(two, t0 + 2000 + BURST_WINDOW_MS + 1), false)
})

test('isMultiAccountBurst honours a custom window and account threshold', () => {
  const t0 = 1_000_000
  const evs = [
    { accountId: 'a', at: t0 },
    { accountId: 'b', at: t0 + 1000 },
    { accountId: 'c', at: t0 + 2000 }
  ]
  assert.equal(isMultiAccountBurst(evs.slice(0, 2), t0 + 2000, 120_000, 3), false)
  assert.equal(isMultiAccountBurst(evs, t0 + 2000, 120_000, 3), true)
  // 'a' falls outside a 2-minute window → only 2 recent accounts
  assert.equal(isMultiAccountBurst(evs, t0 + 120_500, 120_000, 3), false)
})

test('recordAccountEvent drops old events and does not mutate its input', () => {
  const old = [{ accountId: 'a', at: 0 }]
  const next = recordAccountEvent(old, 'b', BURST_WINDOW_MS + 5)
  assert.deepEqual(next, [{ accountId: 'b', at: BURST_WINDOW_MS + 5 }])
  assert.deepEqual(old, [{ accountId: 'a', at: 0 }])
})

test('describeAllLoggedOut only speaks up when every enabled account is logged out', () => {
  assert.match(describeAllLoggedOut(['expired', 'expired', 'expired']) ?? '', /cả 3 tài khoản/)
  assert.equal(describeAllLoggedOut(['expired', 'ready']), null)
  assert.equal(describeAllLoggedOut([]), null)
})

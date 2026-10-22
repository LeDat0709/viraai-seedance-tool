import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  canResumeAfterRestart,
  chooseAccount,
  isUnderCap,
  perAccountCap,
  resumeAccountDecision,
  shouldWaitLongerAfterTimeout,
  TIMEOUT_EXTRA_WAITS,
  failureCooldownMs,
  BASE_FAILURE_COOLDOWN_MS,
  MAX_FAILURE_COOLDOWN_MS,
  nextConcurrency,
  MIN_ADAPTIVE_CONCURRENCY
} from '../src/main/allocation.ts'

test('canResumeAfterRestart: only a single-clip task Dola is already rendering, on a live account', () => {
  const sent = { status: 'polling', conversationId: '7562230259985', duration: 10 }
  assert.equal(canResumeAfterRestart(sent, true), true)
  assert.equal(canResumeAfterRestart({ ...sent, status: 'downloading' }, true), true)
  // not sent yet → nothing paid for, restart normally
  assert.equal(canResumeAfterRestart({ ...sent, status: 'preparing' }, true), false)
  assert.equal(canResumeAfterRestart({ ...sent, status: 'submitting' }, true), false)
  // no conversation to resume, or its account is gone (only that session can fetch it)
  assert.equal(canResumeAfterRestart({ ...sent, conversationId: undefined }, true), false)
  assert.equal(canResumeAfterRestart(sent, false), false)
  // 30s = two parts in two conversations → restart as before
  assert.equal(canResumeAfterRestart({ ...sent, duration: 30 }, true), false)
  assert.equal(canResumeAfterRestart({ ...sent, duration: 15 }, true), true)
})

test('resumeAccountDecision: run on its own account, wait while busy, restart if it died', () => {
  assert.equal(resumeAccountDecision(true, true), 'run')
  assert.equal(resumeAccountDecision(false, true), 'wait')
  assert.equal(resumeAccountDecision(false, false), 'restart')
})

test('perAccountCap maps each mode to its cap (even_split = no cap)', () => {
  assert.equal(perAccountCap('20_per_acc'), 20)
  assert.equal(perAccountCap('10_per_acc'), 10)
  assert.equal(perAccountCap('even_split'), 0)
})

test('isUnderCap: 0 means no cap', () => {
  assert.equal(isUnderCap(999, 0), true)
  assert.equal(isUnderCap(19, 20), true)
  assert.equal(isUnderCap(20, 20), false)
})

test('shouldWaitLongerAfterTimeout: a sent render that timed out is watched once more, not re-sent', () => {
  const timedOut = {
    errorCode: 'GENERAL_ERROR',
    errorMessage: '[Native Engine] Quá thời gian chờ (12 phút) khi dựng 10s.',
    sentToDola: true,
    conversationId: '7712',
    retryCount: 0
  }
  assert.equal(shouldWaitLongerAfterTimeout(timedOut), true)
  // already waited once → give up waiting, normal failover
  assert.equal(shouldWaitLongerAfterTimeout({ ...timedOut, retryCount: TIMEOUT_EXTRA_WAITS }), false)
  // never reached Dola / no conversation → nothing to wait for
  assert.equal(shouldWaitLongerAfterTimeout({ ...timedOut, sentToDola: false }), false)
  assert.equal(shouldWaitLongerAfterTimeout({ ...timedOut, conversationId: undefined }), false)
  // other general errors are not timeouts
  assert.equal(shouldWaitLongerAfterTimeout({ ...timedOut, errorMessage: 'Lỗi Native Engine: socket' }), false)
})

test('failureCooldownMs doubles per consecutive failure and is capped', () => {
  assert.equal(failureCooldownMs(1), BASE_FAILURE_COOLDOWN_MS)
  assert.equal(failureCooldownMs(2), BASE_FAILURE_COOLDOWN_MS * 2)
  assert.equal(failureCooldownMs(3), BASE_FAILURE_COOLDOWN_MS * 4)
  assert.equal(failureCooldownMs(50), MAX_FAILURE_COOLDOWN_MS)
  assert.equal(failureCooldownMs(0), BASE_FAILURE_COOLDOWN_MS)
})

test('nextConcurrency halves on a Dola-wide overload and climbs back by one per success', () => {
  assert.equal(nextConcurrency(8, 8, 'overload'), 4)
  assert.equal(nextConcurrency(4, 8, 'overload'), 2)
  assert.equal(nextConcurrency(2, 8, 'overload'), MIN_ADAPTIVE_CONCURRENCY)
  assert.equal(nextConcurrency(2, 8, 'success'), 3)
  assert.equal(nextConcurrency(8, 8, 'success'), 8)
  // user lowered the setting below the current level → clamp to it
  assert.equal(nextConcurrency(8, 3, 'success'), 3)
  // a 1-thread setting is never pushed above 1
  assert.equal(nextConcurrency(1, 1, 'overload'), 1)
})

const A = (id: string, videosToday = 0) => ({ id, videosToday })

test('assigned home, usable and under cap → stays on home (lô binding)', () => {
  const r = chooseAccount({
    assignedId: 'a',
    available: [A('a', 5), A('b', 0)],
    homeBusy: false,
    cap: 20
  })
  assert.deepEqual(r, { use: 'a' })
})

test('assigned home busy → wait (do not jump to a free account)', () => {
  const r = chooseAccount({
    assignedId: 'a',
    available: [A('b', 0)], // a is not here because it is busy
    homeBusy: true,
    cap: 20
  })
  assert.deepEqual(r, { wait: true })
})

test('assigned home dead (gone, not busy) → failover to fewest-videosToday', () => {
  const r = chooseAccount({
    assignedId: 'a',
    available: [A('b', 3), A('c', 1)], // a absent and not busy → dead
    homeBusy: false,
    cap: 20
  })
  assert.deepEqual(r, { use: 'c' })
})

test('assigned home over cap → failover (soft "hết lượt")', () => {
  const r = chooseAccount({
    assignedId: 'a',
    available: [A('a', 20), A('b', 4)],
    homeBusy: false,
    cap: 20
  })
  assert.deepEqual(r, { use: 'b' })
})

test('every available account at cap → none (queue must wait for cap reset)', () => {
  const r = chooseAccount({
    assignedId: 'a',
    available: [A('a', 20), A('b', 20)],
    homeBusy: false,
    cap: 20
  })
  assert.deepEqual(r, {})
})

test('unassigned task → fewest videosToday under cap', () => {
  const r = chooseAccount({
    available: [A('a', 7), A('b', 2), A('c', 2)],
    homeBusy: false,
    cap: 20
  })
  assert.equal(r.use, 'b')
})

test('cap 0 (even_split) never blocks on usage', () => {
  const r = chooseAccount({
    assignedId: 'a',
    available: [A('a', 999)],
    homeBusy: false,
    cap: 0
  })
  assert.deepEqual(r, { use: 'a' })
})

test('cap 0 (even_split) + busy home → failover to a free account, not wait', () => {
  const r = chooseAccount({
    assignedId: 'a',
    available: [A('b', 0), A('c', 2)], // a absent because busy
    homeBusy: true,
    cap: 0
  })
  assert.deepEqual(r, { use: 'b' })
})

test('capped mode + busy home → still waits (lô binding preserved)', () => {
  const r = chooseAccount({
    assignedId: 'a',
    available: [A('b', 0)],
    homeBusy: true,
    cap: 10
  })
  assert.deepEqual(r, { wait: true })
})

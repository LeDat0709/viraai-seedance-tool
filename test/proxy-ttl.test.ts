

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_PROXY_KEEP_MS,
  MAX_ROTATE_WAIT_SEC,
  PROXY_TTL_SAFETY_MS,
  proxyKeepMs,
  rotateCooldownSec
} from '../src/main/proxy-ttl.ts'

test('rotateCooldownSec reads the TopProxy wait, ignoring absurd values', () => {
  assert.equal(rotateCooldownSec('Con 42s moi co the doi proxy'), 42)
  assert.equal(rotateCooldownSec('Còn 5s mới có thể đổi proxy'), 5)
  assert.equal(rotateCooldownSec(`Con ${MAX_ROTATE_WAIT_SEC + 1}s moi co the doi proxy`), 0)
  assert.equal(rotateCooldownSec('key het han'), 0)
})

test('proxyKeepMs rotates before the reported TopProxy TTL runs out', () => {
  const msg = 'Hoạt động (160.250.166.27:10142 · VIETTEL · BinhDinh1 · TTL 1187s)'
  assert.equal(proxyKeepMs(msg), 1187_000 - PROXY_TTL_SAFETY_MS)
})

test('proxyKeepMs falls back to the default when no TTL is reported', () => {
  assert.equal(proxyKeepMs('Hoạt động (1.2.3.4:8080)'), DEFAULT_PROXY_KEEP_MS)
  assert.equal(proxyKeepMs(undefined), DEFAULT_PROXY_KEEP_MS)
})

test('proxyKeepMs never exceeds the default nor goes negative', () => {
  assert.equal(proxyKeepMs('TTL 99999s'), DEFAULT_PROXY_KEEP_MS)
  assert.equal(proxyKeepMs('TTL 30s'), 0)
})

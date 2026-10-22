import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toRendererAccounts } from '../src/main/renderer-state.ts'

test('toRendererAccounts strips secrets but keeps presence flags and does not mutate input', () => {
  const acc = {
    id: 'a1',
    name: 'FB 1',
    cookieHeader: 'sessionid=secret',
    fbCookie: 'c_user=1; xs=2',
    fbToken: 'EAAB',
    password: 'pw',
    twoFactorSecret: 'TOTP',
    status: 'ready'
  } as any

  const [out] = toRendererAccounts([acc])

  assert.equal(out.cookieHeader, undefined)
  assert.equal(out.fbToken, undefined)
  assert.equal(out.twoFactorSecret, undefined)
  assert.ok(out.fbCookie && out.fbCookie !== acc.fbCookie)
  assert.ok(out.password && out.password !== acc.password)
  assert.equal(out.status, 'ready')
  assert.equal(acc.cookieHeader, 'sessionid=secret')
})

test('toRendererAccounts leaves missing secrets falsy', () => {
  const [out] = toRendererAccounts([{ id: 'a2', name: 'x' } as any])
  assert.equal(out.fbCookie, undefined)
  assert.equal(out.password, undefined)
})

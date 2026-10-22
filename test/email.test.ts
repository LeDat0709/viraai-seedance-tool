import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractEmail } from '../src/main/email.ts'

test('extractEmail keeps a plain email as is', () => {
  assert.equal(extractEmail('3rtnco2enog1b@j8z.forum'), '3rtnco2enog1b@j8z.forum')
})

test('extractEmail pulls the address out of a hotmail token blob and drops the token', () => {
  const blob = '91VFkG5jeoRefreshToken=M.C529_BAY.0.U.MsaArtifacts.-Cod*k2!Ys-b8be-63364c29d753MailKP=kelsey@boxnt.com'
  assert.equal(extractEmail(blob), 'kelsey@boxnt.com')
})

test('extractEmail returns undefined for empty or non-email values', () => {
  assert.equal(extractEmail(undefined), undefined)
  assert.equal(extractEmail('   '), undefined)
  assert.equal(extractEmail('RefreshToken=M.C529_BAY.0.U'), undefined)
})

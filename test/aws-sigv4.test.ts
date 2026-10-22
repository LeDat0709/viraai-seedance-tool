import { test } from 'node:test'
import assert from 'node:assert/strict'
import { byCodePoint, canonicalQuery } from '../src/main/aws-sigv4.ts'

test('canonicalQuery sorts by code point: uppercase keys before the lowercase `s` (ImageX signature)', () => {
  const applyQuery = {
    Action: 'ApplyImageUpload',
    Version: '2018-08-01',
    ServiceId: 'svc1',
    FileSize: '2048',
    FileExtension: '.png',
    s: 'abc123'
  }
  assert.equal(
    canonicalQuery(applyQuery),
    'Action=ApplyImageUpload&FileExtension=.png&FileSize=2048&ServiceId=svc1&Version=2018-08-01&s=abc123'
  )
})

test('canonicalQuery RFC3986-encodes and drops empty values', () => {
  assert.equal(canonicalQuery({ b: "x!'()*", a: 'y z', empty: '' }), 'a=y%20z&b=x%21%27%28%29%2A')
})

test('byCodePoint orders like AWS SigV4 (not locale-aware)', () => {
  assert.deepEqual(['s', 'ServiceId', 'Version', 'Action'].sort(byCodePoint), ['Action', 'ServiceId', 'Version', 's'])
})

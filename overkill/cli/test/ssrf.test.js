// Host discovery must never point the CLI at this machine's network: directories and Nostr
// feeds are untrusted, and a probe sends real requests (docs: overkill/cli/docs/HOSTS.md).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as parse from '../src/hosts/parse.js'

const INTERNAL = [
  'https://169.254.169.254', 'https://169.254.169.254/latest/meta-data', 'https://10.0.0.1', 'https://10.255.1.2/paste',
  'https://172.16.0.1', 'https://172.31.255.254', 'https://192.168.1.1', 'https://127.0.0.1', 'https://127.1.2.3',
  'https://0.0.0.0', 'https://100.64.0.1', 'https://224.0.0.1', 'https://255.255.255.255',
  // the URL parser turns these into dotted IPv4
  'https://2852039166', 'https://0xa9.0xfe.0xa9.0xfe', 'https://0177.0.0.1',
  'https://[::1]', 'https://[fe80::1]', 'https://[fd00::1]', 'https://[::ffff:169.254.169.254]',
  'https://localhost', 'https://localhost.', 'https://paste.localhost', 'https://nas.local', 'https://metadata.google.internal',
  'https://router.lan', 'https://box.home.arpa'
]

test('normalize refuses private, loopback, link-local and local-only hosts', () => {
  for (const url of INTERNAL) {
    for (const type of ['privatebin', 'cryptpad', 'blossom']) assert.equal(parse.normalize(type, url), null, `${type} ${url}`)
    assert.equal(parse.normalize('nostr', url.replace('https', 'wss')), null, `nostr ${url}`)
  }
})

test('a directory entry for the cloud metadata address is dropped, public hosts stay', () => {
  const list = JSON.stringify([{ url: 'https://169.254.169.254' }, { url: 'https://192.168.0.10/bin' }, { url: 'https://paste.example.org' }])
  assert.deepEqual(parse.privatebinJson(list), ['https://paste.example.org'])
  const ev = (d) => ({ kind: 30166, pubkey: 'p', tags: [['d', d]] })
  assert.deepEqual(parse.nip66([ev('wss://10.1.1.1'), ev('wss://relay.example.org')]), ['wss://relay.example.org'])
  // public addresses that only look close to a private range
  assert.equal(parse.normalize('privatebin', 'https://172.32.0.1'), 'https://172.32.0.1')
  assert.equal(parse.normalize('privatebin', 'https://11.0.0.1'), 'https://11.0.0.1')
  assert.equal(parse.normalize('privatebin', 'https://local.example.org'), 'https://local.example.org')
})

test('127.0.0.1 only with the test-only loopback flag', () => {
  const before = process.env.OVERKILL_HOSTS_ALLOW_LOOPBACK
  try {
    process.env.OVERKILL_HOSTS_ALLOW_LOOPBACK = '1'
    assert.equal(parse.normalize('privatebin', 'http://127.0.0.1:8080'), 'http://127.0.0.1:8080')
    assert.equal(parse.normalize('nostr', 'ws://127.0.0.1:7000'), 'ws://127.0.0.1:7000')
    assert.equal(parse.normalize('privatebin', 'https://169.254.169.254'), null)
    assert.equal(parse.normalize('privatebin', 'http://10.0.0.1'), null)
  } finally {
    if (before === undefined) delete process.env.OVERKILL_HOSTS_ALLOW_LOOPBACK
    else process.env.OVERKILL_HOSTS_ALLOW_LOOPBACK = before
  }
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WORDS, generatePassphrase, estimateBits, isStrongEnough, MIN_BITS, generateVaultName } from '../src/passphrase.js'
import { validVaultName } from '../src/defaults.js'

test('wordlist is the EFF large list', () => {
  assert.equal(WORDS.length, 7776)
  assert.equal(new Set(WORDS).size, 7776)
  assert.equal(WORDS[0], 'abacus')
})

test('generated passphrases: 6 list words, at least 77 bits, all different', () => {
  const seen = new Set()
  for (let i = 0; i < 200; i++) {
    const p = generatePassphrase()
    const words = p.split(' ')
    assert.equal(words.length, 6)
    for (const w of words) assert.ok(WORDS.includes(w))
    seen.add(p)
  }
  assert.equal(seen.size, 200)
  assert.ok(6 * Math.log2(7776) >= MIN_BITS)
})

test('strength check rejects the classics and accepts real entropy', () => {
  for (const weak of ['correct horse battery staple', 'Tr0ub4dor&3', 'password1234567890', 'a'.repeat(60),
    'abacus abdomen abacus abdomen abacus abdomen', 'trowel strewn naturist cause flashback', 'hunter2 but longer']) {
    assert.equal(isStrongEnough(weak), false, weak)
  }
  for (const strong of ['smite idealism emphasis overeater canal fever', 'Xk9#mQ2!vL7@pR4$wZ8^', generatePassphrase(7)]) {
    assert.equal(isStrongEnough(strong), true, strong)
  }
  assert.ok(estimateBits('correct horse battery staple') < 60)
})

test('generated vault names: 4 list words joined by "-", valid, different each time', () => {
  const list = new Set(WORDS)
  const names = new Set()
  for (let i = 0; i < 50; i++) {
    const name = generateVaultName()
    const words = name.split('-')
    assert.equal(words.length, 4, name)
    for (const w of words) assert.ok(list.has(w), `${w} is a list word`)
    assert.ok(validVaultName(name), name)
    names.add(name)
  }
  assert.equal(names.size, 50)
})

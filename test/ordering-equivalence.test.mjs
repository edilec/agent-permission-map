import assert from 'node:assert/strict'
import test from 'node:test'

import { APPROVALS, CAPABILITIES, RULE_SEVERITY, SENSITIVITIES, VERDICTS, byCodeUnit } from '../src/index.mjs'

/**
 * The sort sites whose real values cannot be made to disagree.
 *
 * `test/ordering.test.mjs` pins every site whose values a caller can choose.
 * Three sites order values this package generates itself -- rule ids, the JSON
 * Pointers on findings, and this package's own vocabulary -- and for those the
 * question is not "what order is emitted" but "could the two comparators ever
 * differ here at all". Enumerating the value space answers that, and leaves no
 * site unaccounted for.
 *
 * If a future rule id or pointer shape lands in a spelling where collation and
 * code unit disagree, this test fails and the site needs a behavioural case
 * instead.
 */

const collator = new Intl.Collator('en')

function agreeOnEveryPair(values, label) {
  const sorted = [...values].sort(byCodeUnit)
  for (let index = 0; index < sorted.length; index += 1) {
    for (let other = index + 1; other < sorted.length; other += 1) {
      assert.equal(
        collator.compare(sorted[index], sorted[other]) < 0,
        true,
        `${label}: a collator disagrees about ${sorted[index]} before ${sorted[other]}`,
      )
    }
  }
  assert.equal(sorted.length > 1, true, `${label}: there is something to order`)
}

test('every rule id pair is ordered the same way by both comparators', () => {
  agreeOnEveryPair(Object.keys(RULE_SEVERITY), 'rule ids')
})

test('every pointer this package emits is ordered the same way by both comparators', () => {
  const pointers = ['']
  for (const index of [0, 1, 2, 9, 10, 11, 100]) {
    pointers.push(`/tools/${index}`)
    for (const field of ['approval', 'capability', 'dataClasses', 'id', 'roles', 'scopes']) {
      pointers.push(`/tools/${index}/${field}`)
      for (const member of [0, 1, 9, 10]) pointers.push(`/tools/${index}/${field}/${member}`)
    }
    pointers.push(`/roles/${index}`, `/roles/${index}/id`, `/roles/${index}/maxCapability`, `/roles/${index}/maxSensitivity`)
    pointers.push(`/dataClasses/${index}`, `/dataClasses/${index}/id`, `/dataClasses/${index}/sensitivity`)
    pointers.push(`/requirements/${index}`, `/requirements/${index}/maxScopeWildcards`)
  }
  pointers.push('/schemaVersion', '/version', '/tools', '/roles', '/dataClasses', '/requirements')

  agreeOnEveryPair([...new Set(pointers)], 'pointers')
})

test('every vocabulary word this package orders is ordered the same way by both comparators', () => {
  agreeOnEveryPair([...CAPABILITIES, ...SENSITIVITIES, ...APPROVALS, ...VERDICTS], 'vocabulary')
})

test('the comparator itself is the code-unit one, on the pair the catalog measured', () => {
  // The real ordering difference this catalog hit: `S` (0x53) precedes `_`
  // (0x5F) by code point, while collation treats the underscore as ignorable.
  assert.equal(byCodeUnit('MAX_DUPLICATE_URLS', 'MAX_DUPLICATE_URL_ENTRIES') < 0, true)
  assert.equal(collator.compare('MAX_DUPLICATE_URLS', 'MAX_DUPLICATE_URL_ENTRIES') > 0, true)
})

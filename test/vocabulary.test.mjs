import assert from 'node:assert/strict'
import test from 'node:test'

import {
  APPROVALS,
  CAPABILITIES,
  SENSITIVITIES,
  UNBOUNDED_SCOPE_POSITIONS,
  UNBOUNDED_SEGMENT,
  compileScope,
  rankOf,
} from '../src/index.mjs'

/**
 * The closed ladders, and how a scope is measured.
 *
 * The ladders are ordered conventions of this build, so their order is asserted
 * as a literal sequence rather than compared against itself: moving a word
 * changes which grants are reported as exceeding a role ceiling, which is a
 * breaking change and should fail a test when it happens by accident.
 */

test('each ladder is the documented sequence, weakest first', () => {
  assert.deepEqual(CAPABILITIES, ['read', 'write', 'execute', 'delete', 'admin'])
  assert.deepEqual(SENSITIVITIES, ['public', 'internal', 'confidential', 'restricted'])
  assert.deepEqual(APPROVALS, ['none', 'per-session', 'per-action', 'two-person'])
  assert.deepEqual(UNBOUNDED_SCOPE_POSITIONS, ['allowed', 'forbidden'])
})

test('rankOf places a word or says it is not on the ladder at all', () => {
  assert.equal(rankOf(CAPABILITIES, 'read'), 0)
  assert.equal(rankOf(CAPABILITIES, 'admin'), CAPABILITIES.length - 1)
  assert.equal(rankOf(CAPABILITIES, 'telepathy'), -1)
  // Not a string, not on the ladder. A non-string that slipped through would
  // otherwise compare as `indexOf` sees fit.
  assert.equal(rankOf(CAPABILITIES, 42), -1)
  assert.equal(rankOf(CAPABILITIES, null), -1)
})

test('a scope is measured by wildcard segments and by whether it is unbounded', () => {
  assert.deepEqual(compileScope('helpdesk://acme/tickets/42').scope, {
    pattern: 'helpdesk://acme/tickets/42', segments: 3, wildcards: 0, unbounded: false,
  })
  assert.deepEqual(compileScope('helpdesk://acme/tickets/*').scope, {
    pattern: 'helpdesk://acme/tickets/*', segments: 3, wildcards: 1, unbounded: false,
  })
  assert.deepEqual(compileScope('helpdesk://*/tickets/*').scope, {
    pattern: 'helpdesk://*/tickets/*', segments: 3, wildcards: 2, unbounded: false,
  })
  assert.deepEqual(compileScope(`helpdesk://acme/${UNBOUNDED_SEGMENT}`).scope, {
    pattern: 'helpdesk://acme/**', segments: 2, wildcards: 1, unbounded: true,
  })
  assert.equal(compileScope('helpdesk:acme/tickets/*').scope.segments, 3, 'the two realm spellings measure the same')
  assert.equal(compileScope('/srv/app/**').scope.unbounded, true)
  // A partial wildcard reaches an unknown number of resources at one level, so
  // it counts as a wildcard segment rather than as a literal.
  assert.equal(compileScope('helpdesk://acme/ticket-*').scope.wildcards, 1)
})

test('a scope this build cannot measure is refused with a reason, never guessed at', () => {
  assert.deepEqual(compileScope(''), { ok: false, reason: 'empty' })
  assert.deepEqual(compileScope(42), { ok: false, reason: 'shape' })
  assert.deepEqual(compileScope('a//b'), { ok: false, reason: 'empty-segment' })
  assert.deepEqual(compileScope('a/b/'), { ok: false, reason: 'empty-segment' })
  assert.deepEqual(compileScope('docs://'), { ok: false, reason: 'empty-segment' })
  assert.deepEqual(compileScope('a/x**y'), { ok: false, reason: 'partial-unbounded' })
  assert.deepEqual(compileScope('a/b c'), { ok: false, reason: 'alphabet' })
  assert.deepEqual(compileScope(`a${String.fromCharCode(0x2028)}b`), { ok: false, reason: 'forbidden-character' })
  assert.deepEqual(compileScope('x'.repeat(201)), { ok: false, reason: 'too-long', detail: 201 })
})

test('measuring a scope never expands it against anything', async () => {
  // This tool has no resource list and never acquires one: it reads
  // declarations. A scope is measured, and what it would match is not a
  // question this package can answer or pretends to.
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../src/vocabulary.mjs', import.meta.url), 'utf8')

  assert.equal(/new RegExp\s*\(/.test(source), false, 'no pattern is compiled out of input')
  assert.equal(source.includes('minimatch'), false)
  assert.equal(source.includes('glob'), false)
})

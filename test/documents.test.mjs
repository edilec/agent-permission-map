import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DATA_CLASS_KEYS,
  MAX_DESCRIPTION_LENGTH,
  MAX_SCOPE_WILDCARDS,
  REQUIREMENT_KEYS,
  ROLE_KEYS,
  TOOL_KEYS,
  describeValue,
} from '../src/index.mjs'
import {
  apiReport,
  clean,
  dataClass,
  findingsFor,
  fixture,
  raisedRules,
  requirement,
  role,
  rowFor,
  tool,
} from './support.mjs'

/**
 * Document shape and vocabulary.
 *
 * The dialect is small and declared rather than approximated: a word this build
 * does not implement is refused, and a key it does not know is refused rather
 * than ignored so that a typo cannot disable a check. Both refusals describe
 * the offending value instead of reproducing it, because the input is arbitrary
 * content from a file this tool did not write and the pointer already says
 * where to read it.
 */

test('an unknown key on an entry is refused, and its name is counted rather than named', async () => {
  const report = await apiReport(fixture(
    [tool('tickets.reply', 'write', 'per-action', { secretHandle: 'ZQXJVBMP7W' })],
    [role('support-agent', 'write', 'internal')],
    [dataClass('support.tickets', 'internal')],
    [requirement('write', 'internal', 'per-action', 1, 'forbidden')],
  ))

  const finding = findingsFor(report, 'tool-invalid')[0]
  assert.match(finding.message, /1 unknown key\(s\)/)
  assert.equal(finding.message.includes('secretHandle'), false, 'the key name is not reproduced')
  assert.equal(JSON.stringify(report).includes('ZQXJVBMP7W'), false)
  assert.equal(report.matrix.rows.length, 0, 'the entry was refused, not read with the key ignored')
})

test('an unknown key on a document is refused the same way', async () => {
  const files = clean()
  files['tools.json'].extraSection = []
  const report = await apiReport(files)

  const finding = findingsFor(report, 'document-invalid')[0]
  assert.match(finding.message, /1 unknown key\(s\)/)
  assert.equal(finding.message.includes('extraSection'), false)
})

test('the documented key lists are exactly what the compilers accept', async () => {
  // Each list is asserted by behaviour: every documented key is accepted on a
  // real entry, so a key removed from the code fails here rather than only in
  // the docs.
  const report = await apiReport(fixture(
    [tool('tickets.reply', 'write', 'per-action', { description: 'a tool' })],
    [role('support-agent', 'write', 'internal', { description: 'a role' })],
    [dataClass('support.tickets', 'internal', { description: 'a class' })],
    [requirement('write', 'internal', 'per-action', 1, 'forbidden', { description: 'a requirement' })],
  ))

  assert.deepEqual(report.findings, [])
  assert.deepEqual(TOOL_KEYS, ['approval', 'capability', 'dataClasses', 'description', 'id', 'roles', 'scopes'])
  assert.deepEqual(ROLE_KEYS, ['description', 'id', 'maxCapability', 'maxSensitivity'])
  assert.deepEqual(DATA_CLASS_KEYS, ['description', 'id', 'sensitivity'])
  assert.deepEqual(REQUIREMENT_KEYS, [
    'approval', 'capability', 'description', 'maxScopeWildcards', 'sensitivity', 'unboundedScope',
  ])
})

test('a duplicate id refuses the second copy and says neither is authoritative', async () => {
  const report = await apiReport(fixture(
    [tool('tickets.reply', 'write', 'per-action'), tool('tickets.reply', 'admin', 'none')],
    [role('support-agent', 'write', 'internal')],
    [dataClass('support.tickets', 'internal')],
    [requirement('write', 'internal', 'per-action', 1, 'forbidden')],
  ))

  const finding = findingsFor(report, 'tool-duplicate')[0]
  assert.match(finding.message, /declared twice/)
  assert.equal(finding.location.pointer, '/tools/1/id')
  assert.equal(report.status, 'incomplete', 'the refused copy is evidence this run did not read')
})

test('a description longer than the documented bound is refused, not truncated into a report', async () => {
  const report = await apiReport(fixture(
    [tool('tickets.reply', 'write', 'per-action', { description: 'x'.repeat(MAX_DESCRIPTION_LENGTH + 1) })],
    [role('support-agent', 'write', 'internal')],
    [dataClass('support.tickets', 'internal')],
    [requirement('write', 'internal', 'per-action', 1, 'forbidden')],
  ))

  assert.equal(raisedRules(report).includes('tool-invalid'), true)
  assert.match(findingsFor(report, 'tool-invalid')[0].message, /a string of 301 character\(s\)/)
  assert.equal(report.matrix.rows.length, 0, 'the entry was refused rather than read with a cut description')
})

test('a requirement wildcard bound outside its range is refused rather than clamped', async () => {
  for (const value of [-1, MAX_SCOPE_WILDCARDS + 1, 1.5, '1']) {
    const report = await apiReport(fixture(
      [tool('tickets.reply', 'write', 'per-action')],
      [role('support-agent', 'write', 'internal')],
      [dataClass('support.tickets', 'internal')],
      [requirement('write', 'internal', 'per-action', value, 'forbidden')],
    ))
    assert.equal(raisedRules(report).includes('requirement-invalid'), true, String(value))
    assert.equal(report.status, 'incomplete', String(value))
  }
})

test('an unsupported position on unbounded scopes is refused rather than read as permissive', async () => {
  const report = await apiReport(fixture(
    [tool('tickets.reply', 'write', 'per-action')],
    [role('support-agent', 'write', 'internal')],
    [dataClass('support.tickets', 'internal')],
    [requirement('write', 'internal', 'per-action', 1, 'discouraged')],
  ))

  assert.equal(raisedRules(report).includes('requirement-invalid'), true)
  assert.equal(report.status, 'incomplete')
  assert.equal(rowFor(report, 'tickets.reply').verdict, 'undecided')
})

test('an omitted reference list is refused rather than read as an empty one', async () => {
  // "No roles declared" and "the roles field is missing" are different facts,
  // and reading the second as the first is how an absent declaration becomes a
  // permissive one.
  const files = fixture(
    [tool('tickets.reply', 'write', 'per-action')],
    [role('support-agent', 'write', 'internal')],
    [dataClass('support.tickets', 'internal')],
    [requirement('write', 'internal', 'per-action', 1, 'forbidden')],
  )
  delete files['tools.json'].tools[0].roles
  const report = await apiReport(files)

  assert.equal(raisedRules(report).includes('tool-invalid'), true)
  assert.match(findingsFor(report, 'tool-invalid')[0].message, /not read as "none"/)
  assert.equal(report.status, 'incomplete')
})

test('describeValue says what a refused value was without reproducing it', () => {
  assert.equal(describeValue(undefined), 'nothing')
  assert.equal(describeValue(null), 'null')
  assert.equal(describeValue(true), 'true')
  assert.equal(describeValue(7), 'an integer')
  assert.equal(describeValue(7.5), 'a number')
  assert.equal(describeValue('ZQXJVBMP7W'), 'a string of 10 character(s)')
  assert.equal(describeValue(['a', 'b']), 'an array of 2 item(s)')
  assert.equal(describeValue({ a: 1 }), 'an object')
})

test('a document that is an array, or a list that is not one, is refused', async () => {
  const asArray = await apiReport({ ...clean(), 'roles.json': [] })
  assert.equal(raisedRules(asArray).includes('document-invalid'), true)

  const files = clean()
  files['roles.json'].roles = { 'support-agent': {} }
  const asObject = await apiReport(files)
  assert.match(findingsFor(asObject, 'document-invalid')[0].message, /must be an array/)
})

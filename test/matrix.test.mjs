import assert from 'node:assert/strict'
import test from 'node:test'

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
 * The acceptance criterion this tool exists for: an overly broad declared tool
 * scope is visible.
 *
 * "Visible" is pinned as four observable things rather than as one: a finding
 * with a rule id, a message that says how broad the scope is and how broad the
 * policy allows, a row verdict that is no longer `within-policy`, and a summary
 * count a reader can see without reading the findings. A test that asserted
 * only the first would pass on a tool that reported the scope and then called
 * the run green.
 */

const withScope = (pattern, req) => fixture(
  [tool('tickets.reply', 'write', 'per-action', { scopes: [pattern] })],
  [role('support-agent', 'write', 'internal')],
  [dataClass('support.tickets', 'internal')],
  [req],
)

test('an unbounded scope is visible when the requirement forbids one', async () => {
  const report = await apiReport(withScope('helpdesk://**', requirement('write', 'internal', 'per-action', 4, 'forbidden')))

  assert.deepEqual(raisedRules(report), ['scope-unbounded'])
  const finding = findingsFor(report, 'scope-unbounded')[0]
  assert.equal(finding.severity, 'error')
  assert.equal(finding.location.pointer, '/tools/0/scopes')
  assert.match(finding.message, /helpdesk:\/\/\*\*/)

  assert.equal(rowFor(report, 'tickets.reply').verdict, 'outside-policy')
  assert.deepEqual(rowFor(report, 'tickets.reply').reasons, ['scope-unbounded'])
  assert.equal(report.summary.overbroadScopes, 1)
  assert.equal(report.status, 'fail')
})

test('a scope with more wildcard segments than the requirement allows is visible, with both numbers', async () => {
  const report = await apiReport(withScope('helpdesk://*/tickets/*', requirement('write', 'internal', 'per-action', 1, 'forbidden')))

  assert.deepEqual(raisedRules(report), ['scope-too-broad'])
  const finding = findingsFor(report, 'scope-too-broad')[0]
  // The declared breadth and the allowed breadth both appear, because "too
  // broad" with neither number is a sentence a reader cannot act on.
  assert.match(finding.message, /2 wildcard segment\(s\)/)
  assert.match(finding.message, /above the 1 the policy allows/)
  assert.equal(report.summary.overbroadScopes, 1)
  assert.equal(rowFor(report, 'tickets.reply').verdict, 'outside-policy')
})

test('the measured breadth of every scope reaches the matrix row whether or not it is refused', async () => {
  const report = await apiReport(withScope('helpdesk://*/tickets/*', requirement('write', 'internal', 'per-action', 8, 'allowed')))

  assert.deepEqual(report.findings, [])
  assert.deepEqual(rowFor(report, 'tickets.reply').scopes, [
    { pattern: 'helpdesk://*/tickets/*', segments: 3, wildcards: 2, unbounded: false },
  ])
})

/**
 * The other half of a breadth guard, and the half that is easy to leave out: a
 * guard that refuses every wide scope passes every test above while making the
 * tool useless. A policy that has decided a wide read is fine has to be able to
 * say so.
 */
test('a wide scope the policy permits raises nothing at all', async () => {
  const report = await apiReport(fixture(
    [tool('docs.search', 'read', 'none', { scopes: ['docs://public/**'], dataClasses: ['public.docs'], roles: ['docs-reader'] })],
    [role('docs-reader', 'read', 'public')],
    [dataClass('public.docs', 'public')],
    [requirement('read', 'public', 'none', 2, 'allowed')],
  ))

  assert.deepEqual(report.findings, [])
  assert.equal(report.status, 'pass')
  assert.equal(rowFor(report, 'docs.search').verdict, 'within-policy')
  assert.equal(report.summary.overbroadScopes, 0)
})

test('an approval weaker than the requirement is reported with both words', async () => {
  const report = await apiReport(fixture(
    [tool('tickets.reply', 'write', 'per-session')],
    [role('support-agent', 'write', 'internal')],
    [dataClass('support.tickets', 'internal')],
    [requirement('write', 'internal', 'two-person', 1, 'forbidden')],
  ))

  assert.deepEqual(raisedRules(report), ['approval-below-requirement'])
  const finding = findingsFor(report, 'approval-below-requirement')[0]
  assert.match(finding.message, /"per-session"/)
  assert.match(finding.message, /"two-person"/)
  const row = rowFor(report, 'tickets.reply')
  assert.equal(row.declaredApproval, 'per-session')
  assert.equal(row.requiredApproval, 'two-person')
  assert.equal(row.verdict, 'outside-policy')
})

test('an approval stronger than the requirement is not a finding', async () => {
  const report = await apiReport(fixture(
    [tool('tickets.reply', 'write', 'two-person')],
    [role('support-agent', 'write', 'internal')],
    [dataClass('support.tickets', 'internal')],
    [requirement('write', 'internal', 'per-action', 1, 'forbidden')],
  ))

  assert.deepEqual(report.findings, [])
  assert.equal(rowFor(report, 'tickets.reply').verdict, 'within-policy')
})

test('a tool above the capability ceiling of a role it is granted to is reported', async () => {
  const report = await apiReport(fixture(
    [tool('tickets.purge', 'delete', 'two-person')],
    [role('support-agent', 'write', 'internal')],
    [dataClass('support.tickets', 'internal')],
    [requirement('delete', 'internal', 'two-person', 1, 'forbidden')],
  ))

  assert.deepEqual(raisedRules(report), ['role-capability-exceeded'])
  assert.match(findingsFor(report, 'role-capability-exceeded')[0].message, /"delete".+"support-agent".+"write"/)
})

test('a tool reaching data above the sensitivity ceiling of a role it is granted to is reported', async () => {
  const report = await apiReport(fixture(
    [tool('tickets.reply', 'write', 'per-action', { dataClasses: ['payroll.records'] })],
    [role('support-agent', 'write', 'internal')],
    [dataClass('payroll.records', 'restricted')],
    [requirement('write', 'restricted', 'per-action', 1, 'forbidden')],
  ))

  assert.deepEqual(raisedRules(report), ['role-sensitivity-exceeded'])
  assert.equal(rowFor(report, 'tickets.reply').sensitivity, 'restricted')
})

test('sensitivity is the highest of the classes a tool touches, never the first or the mildest', async () => {
  const report = await apiReport(fixture(
    [tool('mixed.export', 'read', 'two-person', { dataClasses: ['public.docs', 'payroll.records', 'support.tickets'] })],
    [role('support-agent', 'read', 'restricted')],
    [dataClass('public.docs', 'public'), dataClass('payroll.records', 'restricted'), dataClass('support.tickets', 'internal')],
    [requirement('read', 'restricted', 'two-person', 1, 'forbidden')],
  ))

  assert.deepEqual(report.findings, [])
  assert.equal(rowFor(report, 'mixed.export').sensitivity, 'restricted')
})

test('a warning does not put a row outside the policy, and does not fail the run', async () => {
  const report = await apiReport(fixture(
    [tool('tickets.reply', 'write', 'per-action', { roles: [] })],
    [role('support-agent', 'write', 'internal')],
    [dataClass('support.tickets', 'internal')],
    [requirement('write', 'internal', 'per-action', 1, 'forbidden')],
  ))

  assert.deepEqual(raisedRules(report), ['role-grants-nothing', 'tool-grants-no-role'])
  for (const finding of report.findings) assert.equal(finding.severity, 'warning')
  assert.equal(rowFor(report, 'tickets.reply').verdict, 'within-policy')
  assert.deepEqual(rowFor(report, 'tickets.reply').reasons, ['tool-grants-no-role'])
  assert.equal(report.status, 'pass')
  assert.equal(report.summary.warnings, 2)
})

test('a role no tool is granted is reported once, against the role document', async () => {
  const report = await apiReport(fixture(
    [tool('tickets.reply', 'write', 'per-action')],
    [role('support-agent', 'write', 'internal'), role('unused-role', 'read', 'public')],
    [dataClass('support.tickets', 'internal')],
    [requirement('write', 'internal', 'per-action', 1, 'forbidden')],
  ))

  const findings = findingsFor(report, 'role-grants-nothing')
  assert.equal(findings.length, 1)
  assert.equal(findings[0].location.file, 'roles.json')
  assert.equal(findings[0].location.pointer, '/roles/1')
})

test('the clean fixture really is clean, so every case above broke exactly one thing', async () => {
  const report = await apiReport(clean())

  assert.deepEqual(report.findings, [])
  assert.equal(report.status, 'pass')
  assert.equal(report.summary.checked, 1)
  assert.equal(report.summary.withinPolicy, 1)
})

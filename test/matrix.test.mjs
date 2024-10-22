import assert from 'node:assert/strict'
import test from 'node:test'

import {
  apiReport,
  clean,
  cliReport,
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

test('the measured breadth of every scope reaches the matrix row', async () => {
  const report = await apiReport(withScope('helpdesk://*/tickets/*', requirement('write', 'internal', 'per-action', 8, 'allowed')))

  assert.deepEqual(report.findings, [])
  assert.deepEqual(rowFor(report, 'tickets.reply').scopes, [
    { pattern: 'helpdesk://*/tickets/*', segments: 3, wildcards: 2, unbounded: false },
  ])
  assert.equal(rowFor(report, 'tickets.reply').scopesRefused, 0)
})

/**
 * A refused scope has no breadth to report -- measuring it is exactly what
 * failed -- so it cannot appear among the measured scopes. What it must not do
 * is vanish: a row listing one scope, for a tool declaring two, tells a
 * reviewer the tool reaches less than it does. The count beside the list is the
 * honest form of that, and this case plants a genuinely refused scope rather
 * than asserting the property over a fixture where nothing was refused.
 */
test('a refused scope is counted on the row rather than dropped from it without trace', async () => {
  const report = await apiReport(fixture(
    [tool('tickets.reply', 'write', 'per-action', {
      scopes: ['helpdesk://acme/tickets/*', 'helpdesk://acme//tickets'],
    })],
    [role('support-agent', 'write', 'internal')],
    [dataClass('support.tickets', 'internal')],
    [requirement('write', 'internal', 'per-action', 8, 'allowed')],
  ))
  const row = rowFor(report, 'tickets.reply')

  assert.deepEqual(raisedRules(report), ['scope-invalid'])
  assert.deepEqual(row.scopes, [
    { pattern: 'helpdesk://acme/tickets/*', segments: 3, wildcards: 1, unbounded: false },
  ])
  assert.equal(row.scopesRefused, 1, 'the row says its scope list is partial')
  assert.equal(row.verdict, 'undecided', 'and a partly unread reach is not a verdict')
  assert.equal(report.status, 'incomplete')
})

test('a refused data class or role reference is counted on the row too', async () => {
  const report = await apiReport(fixture(
    [tool('tickets.reply', 'write', 'per-action', {
      dataClasses: ['support.tickets', 42],
      roles: ['support-agent', 42],
    })],
    [role('support-agent', 'write', 'internal')],
    [dataClass('support.tickets', 'internal')],
    [requirement('write', 'internal', 'per-action', 1, 'forbidden')],
  ))
  const row = rowFor(report, 'tickets.reply')

  assert.deepEqual(raisedRules(report), ['class-reference-invalid', 'role-reference-invalid'])
  assert.deepEqual(row.dataClasses, ['support.tickets'])
  assert.equal(row.dataClassesRefused, 1)
  assert.deepEqual(row.roles, ['support-agent'])
  assert.equal(row.rolesRefused, 1)
  assert.equal(row.verdict, 'undecided')
})

/**
 * The other half of the absent/unreadable split, and the half that is easy to
 * leave out: two different facts must not share one sentence.
 */
test('a tool whose every scope was refused is not reported as declaring none', async () => {
  const refused = await apiReport(withScope('helpdesk://acme//tickets', requirement('write', 'internal', 'per-action', 8, 'allowed')))
  const absent = await apiReport(fixture(
    [tool('tickets.reply', 'write', 'per-action', { scopes: [] })],
    [role('support-agent', 'write', 'internal')],
    [dataClass('support.tickets', 'internal')],
    [requirement('write', 'internal', 'per-action', 8, 'allowed')],
  ))

  assert.deepEqual(raisedRules(refused), ['scope-invalid', 'tool-scopes-unreadable'])
  assert.deepEqual(raisedRules(absent), ['tool-declares-no-scope'])
  assert.notEqual(
    findingsFor(refused, 'tool-scopes-unreadable')[0].message,
    findingsFor(absent, 'tool-declares-no-scope')[0].message,
  )
  assert.match(findingsFor(refused, 'tool-scopes-unreadable')[0].message, /not the same as declaring none/)
  assert.deepEqual(
    refused.matrix.assumptions.map((entry) => entry.assumption),
    [
      // Ordered by pointer: `/tools/0` before `/tools/0/scopes`.
      'part of this tool declaration could not be read, so its reach is only partly known',
      'every scope this tool declares was refused, so what it reaches is unknown',
    ],
  )
  assert.deepEqual(
    absent.matrix.assumptions.map((entry) => entry.assumption),
    ['no resource scope is declared, so what this tool reaches is unknown'],
  )
})

test('a tool whose every data class reference was refused is not reported as declaring none', async () => {
  const refused = await apiReport(fixture(
    [tool('tickets.reply', 'write', 'per-action', { dataClasses: [42] })],
    [role('support-agent', 'write', 'internal')],
    [dataClass('support.tickets', 'internal')],
    [requirement('write', 'internal', 'per-action', 1, 'forbidden')],
  ))
  const absent = await apiReport(fixture(
    [tool('tickets.reply', 'write', 'per-action', { dataClasses: [] })],
    [role('support-agent', 'write', 'internal')],
    [dataClass('support.tickets', 'internal')],
    [requirement('write', 'internal', 'per-action', 1, 'forbidden')],
  ))

  assert.deepEqual(raisedRules(refused), ['class-reference-invalid', 'tool-data-classes-unreadable'])
  assert.deepEqual(raisedRules(absent), ['tool-declares-no-data-class'])
  assert.match(findingsFor(refused, 'tool-data-classes-unreadable')[0].message, /not the same as declaring none/)
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

/**
 * Sensitivity is the highest of the classes a tool touches.
 *
 * This is the load-bearing input to the whole acceptance criterion: the
 * sensitivity picks the requirement, the requirement supplies
 * `maxScopeWildcards`, `unboundedScope` and the approval, and the role ceiling
 * is compared against it. Get it wrong in the permissive direction and a tool
 * reaching payroll is measured against the rule for published documentation.
 *
 * The first version of this test could not fail. `compileTools` sorts a tool's
 * `dataClasses` by code unit, and its fixture ids happened to sort so that the
 * MOST sensitive class was already first -- so "highest" and "first" named the
 * same member, and replacing `Math.max` with first-wins left the suite green
 * while the same declarations flipped from exit 1 to exit 0.
 *
 * Two cases, with the sorted position of the strongest class deliberately
 * opposite in each, and the verdict driven through the real binary:
 *
 * - the strongest class sorts LAST, which first-wins and a minimum both get
 *   wrong;
 * - the strongest class sorts FIRST, which last-wins gets wrong.
 *
 * Both policies declare a requirement for the mild pair as well as the strong
 * one, so a wrong answer is a clean `pass` at exit 0 rather than a missing
 * requirement -- the mutant has to produce the dangerous outcome, not a
 * different complaint.
 */
const mixedSensitivity = (classes) => fixture(
  [tool('mixed.export', 'read', 'two-person', { dataClasses: classes.map(([id]) => id) })],
  [role('support-agent', 'read', 'internal')],
  classes.map(([id, sensitivity]) => dataClass(id, sensitivity)),
  [
    requirement('read', 'public', 'none', 2, 'allowed'),
    requirement('read', 'restricted', 'two-person', 2, 'forbidden'),
  ],
)

test('sensitivity is the highest of the classes a tool touches when the strongest sorts last', async () => {
  const run = await cliReport(mixedSensitivity([
    ['a.public', 'public'], ['m.tickets', 'internal'], ['z.payroll', 'restricted'],
  ]))
  const row = rowFor(run.report, 'mixed.export')

  // The premise, asserted rather than assumed: the mildest class really is
  // first in the row, so "highest" and "first" are different answers here.
  assert.deepEqual(row.dataClasses, ['a.public', 'm.tickets', 'z.payroll'])
  assert.equal(row.sensitivity, 'restricted')

  // And the consequence, which is what a first-wins or minimum reading would
  // turn into a green build.
  assert.deepEqual(raisedRules(run.report), ['role-sensitivity-exceeded'])
  assert.equal(row.verdict, 'outside-policy')
  assert.equal(run.report.status, 'fail')
  assert.equal(run.code, 1)
})

test('sensitivity is the highest of the classes a tool touches when the strongest sorts first', async () => {
  const run = await cliReport(mixedSensitivity([
    ['a.payroll', 'restricted'], ['z.public', 'public'],
  ]))
  const row = rowFor(run.report, 'mixed.export')

  assert.deepEqual(row.dataClasses, ['a.payroll', 'z.public'])
  assert.equal(row.sensitivity, 'restricted')

  assert.deepEqual(raisedRules(run.report), ['role-sensitivity-exceeded'])
  assert.equal(row.verdict, 'outside-policy')
  assert.equal(run.report.status, 'fail')
  assert.equal(run.code, 1)
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

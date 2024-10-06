import assert from 'node:assert/strict'
import test from 'node:test'

import {
  apiReport,
  clean,
  cliReport,
  dataClass,
  fixture,
  raisedRules,
  requirement,
  role,
  rowFor,
  scriptedClock,
  tool,
} from './support.mjs'

/**
 * Unknown is never a pass.
 *
 * Every case here withholds one piece of evidence and asserts three things: the
 * row for the affected tool is `undecided`, the report status is `incomplete`,
 * and the process exit code is 2. The third is what makes this suite hard to
 * satisfy by accident -- a status string can be edited, a verdict can be
 * edited, and both can be edited together, but the exit code is produced by the
 * real binary from the real report.
 *
 * The permissive reading is the dangerous one here in a way it is not for most
 * tools: a data class nobody declared read as "public", or a missing
 * requirement read as "unrestricted", turns an unreviewed permission into a
 * green build, which is the exact failure this tool exists to catch.
 */

const cases = [
  [
    'a data class the policy does not declare',
    fixture(
      [tool('tickets.reply', 'write', 'per-action', { dataClasses: ['nowhere.declared'] })],
      [role('support-agent', 'write', 'internal')],
      [dataClass('support.tickets', 'internal')],
      [requirement('write', 'internal', 'per-action', 1, 'forbidden')],
    ),
    'data-class-unknown',
  ],
  [
    'a role the role document does not declare',
    fixture(
      [tool('tickets.reply', 'write', 'per-action', { roles: ['ghost-role'] })],
      [role('support-agent', 'write', 'internal')],
      [dataClass('support.tickets', 'internal')],
      [requirement('write', 'internal', 'per-action', 1, 'forbidden')],
    ),
    'role-unknown',
  ],
  [
    'no requirement governing the capability and sensitivity the tool declares',
    fixture(
      [tool('tickets.reply', 'write', 'per-action')],
      [role('support-agent', 'write', 'internal')],
      [dataClass('support.tickets', 'internal')],
      [requirement('read', 'internal', 'per-session', 1, 'forbidden')],
    ),
    'requirement-missing',
  ],
  [
    'two requirements governing the same pair, so neither is authoritative',
    fixture(
      [tool('tickets.reply', 'write', 'per-action')],
      [role('support-agent', 'write', 'internal')],
      [dataClass('support.tickets', 'internal')],
      [
        requirement('write', 'internal', 'per-action', 1, 'forbidden'),
        requirement('write', 'internal', 'none', 8, 'allowed'),
      ],
    ),
    'requirement-duplicate',
  ],
  [
    'a tool declaring no data class at all',
    fixture(
      [tool('tickets.reply', 'write', 'per-action', { dataClasses: [] })],
      [role('support-agent', 'write', 'internal')],
      [dataClass('support.tickets', 'internal')],
      [requirement('write', 'internal', 'per-action', 1, 'forbidden')],
    ),
    'tool-declares-no-data-class',
  ],
  [
    'a tool declaring no scope at all',
    fixture(
      [tool('tickets.reply', 'write', 'per-action', { scopes: [] })],
      [role('support-agent', 'write', 'internal')],
      [dataClass('support.tickets', 'internal')],
      [requirement('write', 'internal', 'per-action', 1, 'forbidden')],
    ),
    'tool-declares-no-scope',
  ],
  [
    'a scope this build could not measure',
    fixture(
      [tool('tickets.reply', 'write', 'per-action', { scopes: ['helpdesk://acme//tickets'] })],
      [role('support-agent', 'write', 'internal')],
      [dataClass('support.tickets', 'internal')],
      [requirement('write', 'internal', 'per-action', 1, 'forbidden')],
    ),
    'scope-invalid',
  ],
]

for (const [label, files, ruleId] of cases) {
  test(`${label} leaves the tool undecided, the run incomplete and the exit code 2`, async () => {
    const report = await apiReport(files)

    assert.equal(raisedRules(report).includes(ruleId), true, `${ruleId} was raised`)
    assert.equal(rowFor(report, 'tickets.reply').verdict, 'undecided', 'the row is undecided')
    assert.notEqual(rowFor(report, 'tickets.reply').verdict, 'within-policy')
    assert.equal(report.status, 'incomplete')
    assert.equal(report.summary.undecided, 1)
    assert.equal(report.summary.withinPolicy, 0)

    const run = await cliReport(files)
    assert.equal(run.code, 2, 'the real binary exits 2')
    assert.equal(run.report.status, 'incomplete')
  })
}

test('an undecided run lists the assumption it could not make, at the pointer that caused it', async () => {
  const report = await apiReport(fixture(
    [tool('crm.export', 'read', 'per-session', { dataClasses: ['customer.contacts'] })],
    [role('support-agent', 'read', 'internal')],
    [dataClass('support.tickets', 'internal')],
    [requirement('read', 'internal', 'per-session', 1, 'forbidden')],
  ))

  assert.deepEqual(report.matrix.assumptions, [{
    file: 'tools.json',
    pointer: '/tools/0/dataClasses',
    assumption: 'data class "customer.contacts" is not declared by the policy, so its sensitivity is unknown',
  }])
  assert.equal(report.summary.assumptions, 1)
})

test('an entry the compiler refused makes the run incomplete even when every row that survived is clean', async () => {
  // The surviving tool is fully within policy. The refused one is the whole
  // reason the run is not a pass, which is exactly the shape that let an
  // unread input report green elsewhere in this catalog.
  const report = await apiReport(fixture(
    [
      tool('tickets.reply', 'write', 'per-action'),
      tool('mystery.tool', 'telepathy', 'per-action'),
    ],
    [role('support-agent', 'write', 'internal')],
    [dataClass('support.tickets', 'internal')],
    [requirement('write', 'internal', 'per-action', 1, 'forbidden')],
  ))

  assert.deepEqual(raisedRules(report), ['capability-unsupported'])
  assert.equal(report.matrix.rows.length, 1)
  assert.equal(rowFor(report, 'tickets.reply').verdict, 'within-policy')
  assert.equal(report.status, 'incomplete', 'one unread entry is not a pass for the others')
  assert.equal(report.summary.undecided, 0, 'and it is not counted as a decided row either')
})

test('a document that could not be parsed produces an incomplete report on stdout, not an empty stdout', async () => {
  const run = await cliReport({ ...clean(), 'roles.json': 'not json at all' })

  assert.equal(run.code, 2)
  assert.equal(run.report.status, 'incomplete')
  assert.equal(raisedRules(run.report).includes('input-not-json'), true)
  // The run had a subject and failed to obtain evidence about it, so the
  // consumer gets the report that says which document was not read.
  assert.equal(run.report.findings.some((finding) => finding.location.file === 'roles.json'), true)
})

test('bytes that are not UTF-8 are refused by the decoder, never inferred from decoded text', async () => {
  const report = await apiReport({ ...clean(), 'policy.json': new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]) })

  assert.equal(raisedRules(report).includes('input-not-utf8'), true)
  assert.equal(report.status, 'incomplete')
})

test('three documents that compile with no tool left to map is not a pass', async () => {
  const report = await apiReport(fixture(
    [],
    [role('support-agent', 'write', 'internal')],
    [dataClass('support.tickets', 'internal')],
    [requirement('write', 'internal', 'per-action', 1, 'forbidden')],
  ))

  // Without this rule the report would be `pass` with `checked: 0`: green on no
  // evidence at all.
  assert.equal(raisedRules(report).includes('no-tools-evaluated'), true)
  assert.equal(report.summary.checked, 0)
  assert.equal(report.status, 'incomplete')
})

test('a policy with no version produces an unversioned matrix and an incomplete run', async () => {
  const files = clean()
  delete files['policy.json'].version
  const report = await apiReport(files)

  assert.deepEqual(raisedRules(report), ['policy-version-invalid'])
  assert.equal(report.matrix.version, null)
  assert.equal(report.status, 'incomplete')
  // The rows are still mapped -- the findings about the tools are worth having
  // -- but nobody is handed a matrix that looks authoritative and is not.
  assert.equal(report.summary.checked, 1)
})

test('a spent time budget withdraws every verdict the run had reached', async () => {
  const files = fixture(
    [tool('a.tool', 'write', 'per-action'), tool('b.tool', 'write', 'per-action')],
    [role('support-agent', 'write', 'internal')],
    [dataClass('support.tickets', 'internal')],
    [requirement('write', 'internal', 'per-action', 1, 'forbidden')],
  )

  // The first reading starts the clock and the rest stay inside the budget, so
  // the budget is only passed at the re-check *after* the loop has returned --
  // the exact shape that let a sibling tool fall through to its success branch
  // with a conclusion it had never finished checking.
  const clock = scriptedClock((call) => (call <= 3 ? 0 : 999999))
  const report = await apiReport(files, { clock, limits: { maxRuntimeMs: 1000 } })

  assert.equal(raisedRules(report).includes('time-budget-exceeded'), true)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.undecided, 2)
  assert.equal(report.summary.withinPolicy, 0)
  for (const row of report.matrix.rows) {
    assert.equal(row.verdict, 'undecided')
    assert.equal(row.reasons.includes('time-budget-exceeded'), true)
  }
})

test('a clean run is a pass, so the cases above are not passing on a tool that refuses everything', async () => {
  const run = await cliReport(clean())

  assert.equal(run.code, 0)
  assert.equal(run.report.status, 'pass')
  assert.equal(run.report.summary.undecided, 0)
})

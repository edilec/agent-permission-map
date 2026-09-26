import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_LIMITS, HARD_LIMITS, mapAgentPermissions } from '../src/index.mjs'
import {
  apiReport,
  clean,
  cliReport,
  cliRun,
  dataClass,
  findingsFor,
  fixture,
  raisedRules,
  requirement,
  role,
  tool,
  withRoot,
} from './support.mjs'

/**
 * Every documented limit is enforced, named when it is reached, and never a
 * silent truncation.
 *
 * A limit that is accepted and ignored is the defect this section of the
 * contract exists for: one tool in this catalog accepted a configuration key
 * and never wired it through, so the documented bound was decorative. Each case
 * below lowers one limit to the point where it must bite, and asserts that the
 * finding names the limit, that the run is `incomplete`, and that the exit code
 * is 2 rather than a partial reading reported as a whole one.
 */

const cases = [
  ['maxTools', ['--max-tools', '1'], 'too-many-tools', fixture(
    [tool('a.tool', 'write', 'per-action'), tool('b.tool', 'write', 'per-action')],
    [role('support-agent', 'write', 'internal')],
    [dataClass('support.tickets', 'internal')],
    [requirement('write', 'internal', 'per-action', 1, 'forbidden')],
  )],
  ['maxRoles', ['--max-roles', '1'], 'too-many-roles', fixture(
    [tool('a.tool', 'write', 'per-action')],
    [role('support-agent', 'write', 'internal'), role('other-agent', 'read', 'public')],
    [dataClass('support.tickets', 'internal')],
    [requirement('write', 'internal', 'per-action', 1, 'forbidden')],
  )],
  ['maxDataClasses', ['--max-data-classes', '1'], 'too-many-data-classes', fixture(
    [tool('a.tool', 'write', 'per-action')],
    [role('support-agent', 'write', 'internal')],
    [dataClass('support.tickets', 'internal'), dataClass('public.docs', 'public')],
    [requirement('write', 'internal', 'per-action', 1, 'forbidden')],
  )],
  ['maxRequirements', ['--max-requirements', '1'], 'too-many-requirements', fixture(
    [tool('a.tool', 'write', 'per-action')],
    [role('support-agent', 'write', 'internal')],
    [dataClass('support.tickets', 'internal')],
    [
      requirement('write', 'internal', 'per-action', 1, 'forbidden'),
      requirement('read', 'internal', 'none', 1, 'allowed'),
    ],
  )],
  ['maxScopes', ['--max-scopes', '1'], 'too-many-scopes', fixture(
    [tool('a.tool', 'write', 'per-action', { scopes: ['helpdesk:a', 'helpdesk:b'] })],
    [role('support-agent', 'write', 'internal')],
    [dataClass('support.tickets', 'internal')],
    [requirement('write', 'internal', 'per-action', 1, 'forbidden')],
  )],
  ['maxClassReferences', ['--max-class-references', '1'], 'too-many-class-references', fixture(
    [tool('a.tool', 'write', 'per-action', { dataClasses: ['support.tickets', 'public.docs'] })],
    [role('support-agent', 'write', 'internal')],
    [dataClass('support.tickets', 'internal'), dataClass('public.docs', 'public')],
    [requirement('write', 'internal', 'per-action', 1, 'forbidden')],
  )],
  ['maxRoleReferences', ['--max-role-references', '1'], 'too-many-role-references', fixture(
    [tool('a.tool', 'write', 'per-action', { roles: ['support-agent', 'other-agent'] })],
    [role('support-agent', 'write', 'internal'), role('other-agent', 'write', 'internal')],
    [dataClass('support.tickets', 'internal')],
    [requirement('write', 'internal', 'per-action', 1, 'forbidden')],
  )],
  ['maxFileBytes', ['--max-file-bytes', '2'], 'input-too-large', clean()],
]

for (const [limitKey, flags, ruleId, files] of cases) {
  test(`${limitKey} is enforced, named in the finding, and makes the run incomplete`, async () => {
    const run = await cliReport(files, flags)

    assert.equal(raisedRules(run.report).includes(ruleId), true)
    assert.match(findingsFor(run.report, ruleId)[0].message, new RegExp(limitKey))
    assert.equal(run.report.status, 'incomplete')
    assert.equal(run.code, 2)
  })

  test(`${limitKey} at its default does not bite on the same input`, async () => {
    // The other half: a limit that fired at any size would pass the case above
    // while refusing every real declaration set.
    const run = await cliReport(files)
    assert.equal(raisedRules(run.report).includes(ruleId), false)
  })
}

test('maxFindings truncates deliberately, says so, and is never a quiet cut', async () => {
  const report = await apiReport(fixture(
    [tool('a.tool', 'write', 'none'), tool('b.tool', 'write', 'none'), tool('c.tool', 'write', 'none')],
    [role('support-agent', 'write', 'internal')],
    [dataClass('support.tickets', 'internal')],
    [requirement('write', 'internal', 'per-action', 1, 'forbidden')],
  ), { limits: { maxFindings: 2 } })

  assert.equal(report.findings.length, 2)
  assert.equal(raisedRules(report).includes('too-many-findings'), true)
  assert.match(findingsFor(report, 'too-many-findings')[0].message, /maxFindings limit of 2/)
  assert.equal(report.status, 'incomplete', 'a partial report is not a pass and not a plain fail')
})

test('an unknown limit key is refused rather than ignored', async () => {
  await assert.rejects(() => mapAgentPermissions({ root: '.', limits: { maxTool: 4 } }), /Unknown limit "maxTool"/)
  // A one-character typo silently restoring the default is how a documented
  // bound stops being enforced.
  await withRoot(clean(), async (root) => {
    const run = await cliRun(['--root', root, '--max-tool', '1'])
    assert.equal(run.code, 2)
    assert.equal(run.stdout, '')
    assert.match(run.stderr, /Unknown option/)
  })
})

test('a limit outside its range is refused, at both ends', async () => {
  for (const key of Object.keys(DEFAULT_LIMITS)) {
    await assert.rejects(() => mapAgentPermissions({ root: '.', limits: { [key]: 0 } }), new RegExp(key))
    await assert.rejects(
      () => mapAgentPermissions({ root: '.', limits: { [key]: HARD_LIMITS[key] + 1 } }),
      new RegExp(key),
    )
    await assert.rejects(() => mapAgentPermissions({ root: '.', limits: { [key]: 1.5 } }), new RegExp(key))
  }
})

test('every documented default has a hard cap, and no default exceeds it', () => {
  assert.deepEqual(Object.keys(DEFAULT_LIMITS).sort(), Object.keys(HARD_LIMITS).sort())
  for (const [key, value] of Object.entries(DEFAULT_LIMITS)) {
    assert.equal(Number.isInteger(value) && value >= 1, true, key)
    assert.equal(value <= HARD_LIMITS[key], true, `${key} default is within its cap`)
  }
})

test('a limit flag that is not a positive integer is a configuration error', async () => {
  for (const value of ['0', 'abc', '-1', '1.5', '1e3']) {
    const run = await cliRun(['--root', '.', '--max-tools', value])
    assert.equal(run.code, 2, value)
    assert.equal(run.stdout, '')
  }
})

test('a repeated value flag is a configuration error rather than a silent last-wins', async () => {
  await withRoot(clean(), async (root) => {
    const run = await cliRun(['--root', root, '--max-tools', '5', '--max-tools', '500'])
    assert.equal(run.code, 2)
    assert.equal(run.stdout, '')
    assert.match(run.stderr, /given more than once/)

    const repeated = await cliRun(['--root', root, '--roles', 'roles.json', '--roles', 'other.json'])
    assert.equal(repeated.code, 2)
    assert.match(repeated.stderr, /given more than once/)
  })
})

/**
 * `maxFileBytes` at its exact boundary.
 *
 * Every other limit here is a count, and a count is bitten by a case that
 * declares one more item than the bound allows: shifting any of those
 * comparisons by one fails a named test. `maxFileBytes` was the exception --
 * `info.size > limits.maxFileBytes` could be moved to `+ 1` and the whole suite
 * stayed green, because "2 bytes" is so far below any document that the
 * boundary itself was never approached.
 *
 * So this case measures the real byte length of the file it writes and drives
 * the bound at exactly that number and at one below it. The rule is
 * `size > limit`: a document of exactly `maxFileBytes` bytes is read, and one
 * byte more is refused unread.
 */
test('maxFileBytes bites at exactly one byte over the bound, and not at the bound', async () => {
  const files = clean()
  // The bound applies per document, so the number that decides whether any of
  // them is refused is the size of the largest one, written exactly as
  // `withRoot` writes it.
  const size = Math.max(...Object.values(files)
    .map((document) => Buffer.byteLength(`${JSON.stringify(document, null, 2)}\n`, 'utf8')))

  const atBound = await cliReport(files, ['--max-file-bytes', String(size)])
  assert.equal(raisedRules(atBound.report).includes('input-too-large'), false, `a ${size}-byte document is not over a ${size}-byte limit`)

  const oneBelow = await cliReport(files, ['--max-file-bytes', String(size - 1)])
  assert.equal(raisedRules(oneBelow.report).includes('input-too-large'), true, `a ${size}-byte document is over a ${size - 1}-byte limit`)
  assert.match(findingsFor(oneBelow.report, 'input-too-large')[0].message, new RegExp(`is ${size} bytes`))
  assert.equal(oneBelow.report.status, 'incomplete')
  assert.equal(oneBelow.code, 2)
})

import assert from 'node:assert/strict'
import { symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { RULE_SEVERITY, exitCodeFor, mapAgentPermissions } from '../src/index.mjs'
import {
  apiReport,
  clean,
  cliReport,
  cliRun,
  dataClass,
  fixture,
  raisedRules,
  requirement,
  role,
  scriptedClock,
  tool,
  withRoot,
} from './support.mjs'

/**
 * Severity, pinned behaviourally.
 *
 * A test that compares the severity table against a hand-written expected map
 * is three declarations agreeing with each other: a coordinated edit of the
 * table, the docs and the map passes it, and in this catalog exactly that let
 * 40 of 52 error rules be demoted with a green suite. So every rule below is
 * driven through the **real binary** over a real input, and what is asserted is
 * the **process exit code**. Demote any error rule to `warning` and its case
 * fails, because a passing run exits 0.
 *
 * Two directions are covered, and the second is the one that is usually
 * missing: an error rule must not exit 0, and a warning rule must not exit
 * anything else. Without the second half, promoting a warning to an error to
 * make a test pass would go unnoticed.
 */

const base = clean()

/** `[ruleId, files, extra CLI arguments, expected exit code]`. */
const ERROR_CASES = [
  ['approval-below-requirement', fixture(
    [tool('tickets.reply', 'write', 'none')],
    [role('support-agent', 'write', 'internal')],
    [dataClass('support.tickets', 'internal')],
    [requirement('write', 'internal', 'per-action', 1, 'forbidden')],
  ), [], 1],
  ['approval-unsupported', fixture(
    [tool('tickets.reply', 'write', 'whenever')],
    [role('support-agent', 'write', 'internal')],
    [dataClass('support.tickets', 'internal')],
    [requirement('write', 'internal', 'per-action', 1, 'forbidden')],
  ), [], 2],
  ['capability-unsupported', fixture(
    [tool('tickets.reply', 'telepathy', 'per-action')],
    [role('support-agent', 'write', 'internal')],
    [dataClass('support.tickets', 'internal')],
    [requirement('write', 'internal', 'per-action', 1, 'forbidden')],
  ), [], 2],
  ['class-reference-invalid', fixture(
    [tool('tickets.reply', 'write', 'per-action', { dataClasses: [42] })],
    [role('support-agent', 'write', 'internal')],
    [dataClass('support.tickets', 'internal')],
    [requirement('write', 'internal', 'per-action', 1, 'forbidden')],
  ), [], 2],
  ['data-class-duplicate', fixture(
    [tool('tickets.reply', 'write', 'per-action')],
    [role('support-agent', 'write', 'internal')],
    [dataClass('support.tickets', 'internal'), dataClass('support.tickets', 'restricted')],
    [requirement('write', 'internal', 'per-action', 1, 'forbidden')],
  ), [], 2],
  ['data-class-invalid', fixture(
    [tool('tickets.reply', 'write', 'per-action')],
    [role('support-agent', 'write', 'internal')],
    [dataClass('support.tickets', 'internal', { owner: 'support' })],
    [requirement('write', 'internal', 'per-action', 1, 'forbidden')],
  ), [], 2],
  ['data-class-unknown', fixture(
    [tool('tickets.reply', 'write', 'per-action', { dataClasses: ['nowhere.declared'] })],
    [role('support-agent', 'write', 'internal')],
    [dataClass('support.tickets', 'internal')],
    [requirement('write', 'internal', 'per-action', 1, 'forbidden')],
  ), [], 2],
  ['document-invalid', { ...base, 'tools.json': [] }, [], 2],
  ['identifier-invalid', fixture(
    [tool(42, 'write', 'per-action')],
    [role('support-agent', 'write', 'internal')],
    [dataClass('support.tickets', 'internal')],
    [requirement('write', 'internal', 'per-action', 1, 'forbidden')],
  ), [], 2],
  ['input-not-json', { ...base, 'tools.json': '{' }, [], 2],
  ['input-not-utf8', { ...base, 'tools.json': new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]) }, [], 2],
  ['input-too-large', base, ['--max-file-bytes', '2'], 2],
  ['no-tools-evaluated', fixture(
    [],
    [role('support-agent', 'write', 'internal')],
    [dataClass('support.tickets', 'internal')],
    [requirement('write', 'internal', 'per-action', 1, 'forbidden')],
  ), [], 2],
  ['policy-version-invalid', fixture(
    [tool('tickets.reply', 'write', 'per-action')],
    [role('support-agent', 'write', 'internal')],
    [dataClass('support.tickets', 'internal')],
    [requirement('write', 'internal', 'per-action', 1, 'forbidden')],
    42,
  ), [], 2],
  ['requirement-duplicate', fixture(
    [tool('tickets.reply', 'write', 'per-action')],
    [role('support-agent', 'write', 'internal')],
    [dataClass('support.tickets', 'internal')],
    [
      requirement('write', 'internal', 'per-action', 1, 'forbidden'),
      requirement('write', 'internal', 'none', 4, 'allowed'),
    ],
  ), [], 2],
  ['requirement-invalid', fixture(
    [tool('tickets.reply', 'write', 'per-action')],
    [role('support-agent', 'write', 'internal')],
    [dataClass('support.tickets', 'internal')],
    [requirement('write', 'internal', 'per-action', -1, 'forbidden')],
  ), [], 2],
  ['requirement-missing', fixture(
    [tool('tickets.reply', 'write', 'per-action')],
    [role('support-agent', 'write', 'internal')],
    [dataClass('support.tickets', 'internal')],
    [requirement('read', 'internal', 'per-session', 1, 'forbidden')],
  ), [], 2],
  ['role-capability-exceeded', fixture(
    [tool('tickets.purge', 'delete', 'two-person')],
    [role('support-agent', 'write', 'internal')],
    [dataClass('support.tickets', 'internal')],
    [requirement('delete', 'internal', 'two-person', 1, 'forbidden')],
  ), [], 1],
  ['role-duplicate', fixture(
    [tool('tickets.reply', 'write', 'per-action')],
    [role('support-agent', 'write', 'internal'), role('support-agent', 'admin', 'restricted')],
    [dataClass('support.tickets', 'internal')],
    [requirement('write', 'internal', 'per-action', 1, 'forbidden')],
  ), [], 2],
  ['role-invalid', fixture(
    [tool('tickets.reply', 'write', 'per-action')],
    [role('support-agent', 'write', 'internal', { team: 'support' })],
    [dataClass('support.tickets', 'internal')],
    [requirement('write', 'internal', 'per-action', 1, 'forbidden')],
  ), [], 2],
  ['role-reference-invalid', fixture(
    [tool('tickets.reply', 'write', 'per-action', { roles: [42] })],
    [role('support-agent', 'write', 'internal')],
    [dataClass('support.tickets', 'internal')],
    [requirement('write', 'internal', 'per-action', 1, 'forbidden')],
  ), [], 2],
  ['role-sensitivity-exceeded', fixture(
    [tool('payroll.read', 'read', 'two-person', { dataClasses: ['payroll.records'] })],
    [role('support-agent', 'read', 'internal')],
    [dataClass('payroll.records', 'restricted')],
    [requirement('read', 'restricted', 'two-person', 1, 'forbidden')],
  ), [], 1],
  ['role-unknown', fixture(
    [tool('tickets.reply', 'write', 'per-action', { roles: ['ghost'] })],
    [role('support-agent', 'write', 'internal')],
    [dataClass('support.tickets', 'internal')],
    [requirement('write', 'internal', 'per-action', 1, 'forbidden')],
  ), [], 2],
  ['schema-version-unsupported', { ...base, 'roles.json': { ...base['roles.json'], schemaVersion: '2' } }, [], 2],
  ['scope-invalid', fixture(
    [tool('tickets.reply', 'write', 'per-action', { scopes: ['helpdesk://acme//tickets'] })],
    [role('support-agent', 'write', 'internal')],
    [dataClass('support.tickets', 'internal')],
    [requirement('write', 'internal', 'per-action', 1, 'forbidden')],
  ), [], 2],
  ['scope-too-broad', fixture(
    [tool('tickets.reply', 'write', 'per-action', { scopes: ['helpdesk://*/tickets/*'] })],
    [role('support-agent', 'write', 'internal')],
    [dataClass('support.tickets', 'internal')],
    [requirement('write', 'internal', 'per-action', 1, 'forbidden')],
  ), [], 1],
  ['scope-unbounded', fixture(
    [tool('tickets.reply', 'write', 'per-action', { scopes: ['helpdesk://**'] })],
    [role('support-agent', 'write', 'internal')],
    [dataClass('support.tickets', 'internal')],
    [requirement('write', 'internal', 'per-action', 4, 'forbidden')],
  ), [], 1],
  ['sensitivity-unsupported', fixture(
    [tool('tickets.reply', 'write', 'per-action')],
    [role('support-agent', 'write', 'internal')],
    [dataClass('support.tickets', 'sort-of-secret')],
    [requirement('write', 'internal', 'per-action', 1, 'forbidden')],
  ), [], 2],
  ['too-many-class-references', fixture(
    [tool('tickets.reply', 'write', 'per-action', { dataClasses: ['support.tickets', 'public.docs'] })],
    [role('support-agent', 'write', 'internal')],
    [dataClass('support.tickets', 'internal'), dataClass('public.docs', 'public')],
    [requirement('write', 'internal', 'per-action', 1, 'forbidden')],
  ), ['--max-class-references', '1'], 2],
  ['too-many-data-classes', fixture(
    [tool('tickets.reply', 'write', 'per-action')],
    [role('support-agent', 'write', 'internal')],
    [dataClass('support.tickets', 'internal'), dataClass('public.docs', 'public')],
    [requirement('write', 'internal', 'per-action', 1, 'forbidden')],
  ), ['--max-data-classes', '1'], 2],
  ['too-many-findings', fixture(
    [tool('a.tool', 'write', 'none'), tool('b.tool', 'write', 'none')],
    [role('support-agent', 'write', 'internal')],
    [dataClass('support.tickets', 'internal')],
    [requirement('write', 'internal', 'per-action', 1, 'forbidden')],
  ), ['--max-findings', '1'], 2],
  ['too-many-requirements', fixture(
    [tool('tickets.reply', 'write', 'per-action')],
    [role('support-agent', 'write', 'internal')],
    [dataClass('support.tickets', 'internal')],
    [
      requirement('write', 'internal', 'per-action', 1, 'forbidden'),
      requirement('read', 'internal', 'per-session', 1, 'forbidden'),
    ],
  ), ['--max-requirements', '1'], 2],
  ['too-many-role-references', fixture(
    [tool('tickets.reply', 'write', 'per-action', { roles: ['support-agent', 'second-agent'] })],
    [role('support-agent', 'write', 'internal'), role('second-agent', 'write', 'internal')],
    [dataClass('support.tickets', 'internal')],
    [requirement('write', 'internal', 'per-action', 1, 'forbidden')],
  ), ['--max-role-references', '1'], 2],
  ['too-many-roles', fixture(
    [tool('tickets.reply', 'write', 'per-action')],
    [role('support-agent', 'write', 'internal'), role('second-agent', 'read', 'public')],
    [dataClass('support.tickets', 'internal')],
    [requirement('write', 'internal', 'per-action', 1, 'forbidden')],
  ), ['--max-roles', '1'], 2],
  ['too-many-scopes', fixture(
    [tool('tickets.reply', 'write', 'per-action', { scopes: ['helpdesk://acme/a', 'helpdesk://acme/b'] })],
    [role('support-agent', 'write', 'internal')],
    [dataClass('support.tickets', 'internal')],
    [requirement('write', 'internal', 'per-action', 1, 'forbidden')],
  ), ['--max-scopes', '1'], 2],
  ['too-many-tools', fixture(
    [tool('a.tool', 'write', 'per-action'), tool('b.tool', 'write', 'per-action')],
    [role('support-agent', 'write', 'internal')],
    [dataClass('support.tickets', 'internal')],
    [requirement('write', 'internal', 'per-action', 1, 'forbidden')],
  ), ['--max-tools', '1'], 2],
  ['tool-declares-no-data-class', fixture(
    [tool('tickets.reply', 'write', 'per-action', { dataClasses: [] })],
    [role('support-agent', 'write', 'internal')],
    [dataClass('support.tickets', 'internal')],
    [requirement('write', 'internal', 'per-action', 1, 'forbidden')],
  ), [], 2],
  ['tool-declares-no-scope', fixture(
    [tool('tickets.reply', 'write', 'per-action', { scopes: [] })],
    [role('support-agent', 'write', 'internal')],
    [dataClass('support.tickets', 'internal')],
    [requirement('write', 'internal', 'per-action', 1, 'forbidden')],
  ), [], 2],
  ['tool-scopes-unreadable', fixture(
    [tool('tickets.reply', 'write', 'per-action', { scopes: ['helpdesk://acme//tickets'] })],
    [role('support-agent', 'write', 'internal')],
    [dataClass('support.tickets', 'internal')],
    [requirement('write', 'internal', 'per-action', 1, 'forbidden')],
  ), [], 2],
  ['tool-roles-unreadable', fixture(
    [tool('tickets.reply', 'write', 'per-action', { roles: [42] })],
    [role('support-agent', 'write', 'internal')],
    [dataClass('support.tickets', 'internal')],
    [requirement('write', 'internal', 'per-action', 1, 'forbidden')],
  ), [], 2],
  ['tool-data-classes-unreadable', fixture(
    [tool('tickets.reply', 'write', 'per-action', { dataClasses: [42] })],
    [role('support-agent', 'write', 'internal')],
    [dataClass('support.tickets', 'internal')],
    [requirement('write', 'internal', 'per-action', 1, 'forbidden')],
  ), [], 2],
  ['tool-duplicate', fixture(
    [tool('tickets.reply', 'write', 'per-action'), tool('tickets.reply', 'admin', 'none')],
    [role('support-agent', 'write', 'internal')],
    [dataClass('support.tickets', 'internal')],
    [requirement('write', 'internal', 'per-action', 1, 'forbidden')],
  ), [], 2],
  ['tool-invalid', fixture(
    [tool('tickets.reply', 'write', 'per-action', { owner: 'support' })],
    [role('support-agent', 'write', 'internal')],
    [dataClass('support.tickets', 'internal')],
    [requirement('write', 'internal', 'per-action', 1, 'forbidden')],
  ), [], 2],
  ['input-unreadable', { 'tools.json': base['tools.json'], 'roles.json': base['roles.json'] }, [], 2],
]

for (const [ruleId, files, extra, expected] of ERROR_CASES) {
  test(`${ruleId} fires and the binary exits ${expected}`, async () => {
    const run = await cliReport(files, extra)

    assert.equal(raisedRules(run.report).includes(ruleId), true, `${ruleId} was raised`)
    assert.equal(run.code, expected, `${ruleId} exits ${expected}`)
    assert.notEqual(run.code, 0, `${ruleId} never exits 0`)
  })
}

test('path-escapes-root fires and the binary exits 2', async () => {
  await withRoot(clean(), async (root) => {
    await withRoot({ 'stolen.json': '{}' }, async (outside) => {
      await writeFile(join(root, 'kept.json'), '{}')
      await symlink(join(outside, 'stolen.json'), join(root, 'linked.json'))

      const run = await cliRun(['--root', root, '--json', '--roles', 'linked.json'])
      const report = JSON.parse(run.stdout)

      assert.equal(raisedRules(report).includes('path-escapes-root'), true)
      assert.equal(run.code, 2)
    })
  })
})

/**
 * The time budget cannot be driven from the command line without waiting, so it
 * is pinned through the API and the same `exitCodeFor` the binary calls. Every
 * other error rule above is pinned by the process exit code itself.
 */
test('time-budget-exceeded fires and maps to exit 2', async () => {
  const report = await apiReport(clean(), {
    clock: scriptedClock((call) => (call === 1 ? 0 : 999999)),
    limits: { maxRuntimeMs: 1 },
  })

  assert.equal(raisedRules(report).includes('time-budget-exceeded'), true)
  assert.equal(exitCodeFor(report), 2)
})

/** Every error rule in the table has a case above. A new rule with no case fails here. */
test('every error rule in the table is pinned by an exit code above', () => {
  const pinned = new Set([...ERROR_CASES.map(([ruleId]) => ruleId), 'path-escapes-root', 'time-budget-exceeded'])
  const errorRules = Object.keys(RULE_SEVERITY).filter((ruleId) => RULE_SEVERITY[ruleId] === 'error')

  assert.deepEqual(errorRules.filter((ruleId) => !pinned.has(ruleId)), [])
})

const WARNING_CASES = [
  ['class-reference-duplicate', fixture(
    [tool('tickets.reply', 'write', 'per-action', { dataClasses: ['support.tickets', 'support.tickets'] })],
    [role('support-agent', 'write', 'internal')],
    [dataClass('support.tickets', 'internal')],
    [requirement('write', 'internal', 'per-action', 1, 'forbidden')],
  )],
  ['role-grants-nothing', fixture(
    [tool('tickets.reply', 'write', 'per-action')],
    [role('support-agent', 'write', 'internal'), role('spare-agent', 'read', 'public')],
    [dataClass('support.tickets', 'internal')],
    [requirement('write', 'internal', 'per-action', 1, 'forbidden')],
  )],
  ['role-reference-duplicate', fixture(
    [tool('tickets.reply', 'write', 'per-action', { roles: ['support-agent', 'support-agent'] })],
    [role('support-agent', 'write', 'internal')],
    [dataClass('support.tickets', 'internal')],
    [requirement('write', 'internal', 'per-action', 1, 'forbidden')],
  )],
  ['scope-duplicate', fixture(
    [tool('tickets.reply', 'write', 'per-action', { scopes: ['helpdesk://acme/tickets/*', 'helpdesk://acme/tickets/*'] })],
    [role('support-agent', 'write', 'internal')],
    [dataClass('support.tickets', 'internal')],
    [requirement('write', 'internal', 'per-action', 1, 'forbidden')],
  )],
  ['tool-grants-no-role', fixture(
    [tool('tickets.reply', 'write', 'per-action', { roles: [] })],
    [role('support-agent', 'write', 'internal')],
    [dataClass('support.tickets', 'internal')],
    [requirement('write', 'internal', 'per-action', 1, 'forbidden')],
  )],
]

for (const [ruleId, files] of WARNING_CASES) {
  test(`${ruleId} fires, the run still passes, and the binary exits 0`, async () => {
    const run = await cliReport(files)

    assert.equal(raisedRules(run.report).includes(ruleId), true, `${ruleId} was raised`)
    assert.equal(run.report.status, 'pass')
    assert.equal(run.code, 0, `${ruleId} is a warning, so the run passes`)
  })
}

test('every warning rule in the table is pinned by an exit code above', () => {
  const pinned = new Set(WARNING_CASES.map(([ruleId]) => ruleId))
  const warningRules = Object.keys(RULE_SEVERITY).filter((ruleId) => RULE_SEVERITY[ruleId] === 'warning')

  assert.deepEqual(warningRules.filter((ruleId) => !pinned.has(ruleId)), [])
})

test('a rule id outside the table throws rather than defaulting to a severity', async () => {
  // A finding with no severity is a finding with no verdict. Defaulting one in
  // would let a new rule ship silently as whatever the default happened to be.
  const { createFinding } = await import('../src/index.mjs')
  assert.throws(() => createFinding({ ruleId: 'not-a-real-rule', file: 'tools.json', message: 'x' }), /RULE_SEVERITY/)
})

test('the options the API refuses are refused before any evidence is read', async () => {
  await assert.rejects(() => mapAgentPermissions({ root: '.', nonsense: 1 }), /Unknown option/)
  await assert.rejects(() => mapAgentPermissions({ root: '.', limits: { maxTool: 5 } }), /Unknown limit/)
})

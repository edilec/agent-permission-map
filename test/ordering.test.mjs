import assert from 'node:assert/strict'
import test from 'node:test'

import {
  apiReport,
  cliRun,
  dataClass,
  fixture,
  policyDocument,
  requirement,
  role,
  roleDocument,
  rowFor,
  tool,
  toolDocument,
  withRoot,
} from './support.mjs'

/**
 * Ordering, pinned by what the tool emits.
 *
 * A source scan for `.localeCompare(` is not a determinism test: `Intl.Collator`
 * collates identically and spells differently, so the scan passes while the
 * output silently starts depending on the ICU data of whichever Node build is
 * running. Pinning the comparator itself is no better -- every call site can be
 * swapped on its own.
 *
 * Every case below chooses values an English collator orders the other way
 * round, pushes them through the real report path, and asserts the exact
 * emitted sequence. The sites whose real values collate exactly as they compare
 * are proved equivalent by enumeration in `test/ordering-equivalence.test.mjs`
 * rather than left as gaps.
 */

const collator = new Intl.Collator('en')
const disagrees = (left, right) => {
  assert.equal(left < right, true, `${left} precedes ${right} by code unit`)
  assert.equal(collator.compare(left, right) > 0, true, `a collator puts ${right} first, which is what makes this a case`)
}

test('the disagreements every case below relies on are real', () => {
  disagrees('Z.tool', 'a.tool')
  disagrees('Z-role', 'a-role')
  disagrees('Z.class', 'a.class')
  disagrees('Z.json', 'a.json')
  disagrees('helpdesk:Z/*', 'helpdesk:a/*')
  disagrees('role "Z-ghost"', 'role "a-ghost"')
})

test('matrix rows are ordered by code unit', async () => {
  const report = await apiReport(fixture(
    [
      tool('a.tool', 'read', 'none', { dataClasses: ['public.docs'], roles: ['reader'] }),
      tool('Z.tool', 'read', 'none', { dataClasses: ['public.docs'], roles: ['reader'] }),
      tool('README.tool', 'read', 'none', { dataClasses: ['public.docs'], roles: ['reader'] }),
    ],
    [role('reader', 'read', 'public')],
    [dataClass('public.docs', 'public')],
    [requirement('read', 'public', 'none', 1, 'allowed')],
  ))

  assert.deepEqual(report.matrix.rows.map((row) => row.id), ['README.tool', 'Z.tool', 'a.tool'])
  assert.notDeepEqual(
    report.matrix.rows.map((row) => row.id),
    [...report.matrix.rows.map((row) => row.id)].sort((left, right) => collator.compare(left, right)),
    'a collator would order these rows differently',
  )
})

test('the roles and data classes on a row are ordered by code unit', async () => {
  const report = await apiReport(fixture(
    [tool('mixed.tool', 'read', 'none', {
      roles: ['a-role', 'Z-role', 'README-role'],
      dataClasses: ['a.class', 'Z.class', 'README.class'],
    })],
    [role('a-role', 'read', 'public'), role('Z-role', 'read', 'public'), role('README-role', 'read', 'public')],
    [dataClass('a.class', 'public'), dataClass('Z.class', 'public'), dataClass('README.class', 'public')],
    [requirement('read', 'public', 'none', 1, 'allowed')],
  ))

  assert.deepEqual(rowFor(report, 'mixed.tool').roles, ['README-role', 'Z-role', 'a-role'])
  assert.deepEqual(rowFor(report, 'mixed.tool').dataClasses, ['README.class', 'Z.class', 'a.class'])
})

test('the scopes on a row are ordered by code unit', async () => {
  const report = await apiReport(fixture(
    [tool('scoped.tool', 'read', 'none', {
      dataClasses: ['public.docs'],
      roles: ['reader'],
      scopes: ['helpdesk:a/*', 'helpdesk:Z/*', 'helpdesk:README/*'],
    })],
    [role('reader', 'read', 'public')],
    [dataClass('public.docs', 'public')],
    [requirement('read', 'public', 'none', 1, 'allowed')],
  ))

  assert.deepEqual(
    rowFor(report, 'scoped.tool').scopes.map((scope) => scope.pattern),
    ['helpdesk:README/*', 'helpdesk:Z/*', 'helpdesk:a/*'],
  )
})

test('findings are ordered by the file they were found in, by code unit', async () => {
  // The file names come from the command line, which is the one place a caller
  // can choose values an English collator orders the other way round.
  const files = {
    'Z.json': toolDocument([tool('tickets.reply', 'write', 'per-action', { roles: ['ghost-role'] })]),
    'a.json': roleDocument([role('support-agent', 'write', 'internal')]),
    'p.json': policyDocument([dataClass('support.tickets', 'internal')], [requirement('write', 'internal', 'per-action', 1, 'forbidden')]),
  }

  await withRoot(files, async (root) => {
    const run = await cliRun(['--root', root, '--json', '--tools', 'Z.json', '--roles', 'a.json', '--policy', 'p.json'])
    const report = JSON.parse(run.stdout)

    assert.deepEqual(report.findings.map((finding) => finding.location.file), ['Z.json', 'a.json'])
    assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['role-unknown', 'role-grants-nothing'])
  })
})

test('two assumptions at the same pointer are ordered by code unit', async () => {
  const report = await apiReport(fixture(
    [tool('ghosted.tool', 'read', 'none', { dataClasses: ['public.docs'], roles: ['a-ghost', 'Z-ghost'] })],
    [role('reader', 'read', 'public')],
    [dataClass('public.docs', 'public')],
    [requirement('read', 'public', 'none', 1, 'allowed')],
  ))

  assert.deepEqual(
    report.matrix.assumptions.map((entry) => entry.assumption),
    [
      'role "Z-ghost" is not declared, so its capability and sensitivity ceilings are unknown',
      'role "a-ghost" is not declared, so its capability and sensitivity ceilings are unknown',
    ],
  )
})

test('two runs over the same declarations produce byte-identical stdout', async () => {
  // No clock, host, run id or enumeration order reaches the report, so the
  // second run of a pair is the same bytes as the first.
  const files = fixture(
    [tool('a.tool', 'read', 'none', { dataClasses: ['public.docs'], roles: ['reader'] })],
    [role('reader', 'read', 'public')],
    [dataClass('public.docs', 'public')],
    [requirement('read', 'public', 'none', 1, 'allowed')],
  )

  await withRoot(files, async (root) => {
    const first = await cliRun(['--root', root, '--json'])
    const second = await cliRun(['--root', root, '--json'])

    assert.equal(first.stdout, second.stdout)
    assert.equal(first.stdout.length > 0, true)
  })
})

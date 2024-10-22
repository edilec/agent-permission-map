import assert from 'node:assert/strict'
import test from 'node:test'

import {
  apiReport,
  clean,
  dataClass,
  fixture,
  requirement,
  role,
  tool,
} from './support.mjs'

/**
 * The matrix is versioned, and the version is usable.
 *
 * "Versioned" means two things a reviewer can act on: the policy revision the
 * matrix was produced from travels with it, and a digest identifies the matrix
 * itself so a later run can be compared against the one that was signed off.
 * The digest is computed from the matrix alone -- no clock, no host, no run id
 * -- which is what makes two runs over one input produce the same one.
 */

const digestOf = (report) => report.matrix.digest

test('the same declarations produce the same digest, twice', async () => {
  const first = await apiReport(clean())
  const second = await apiReport(clean())

  assert.equal(digestOf(first), digestOf(second))
  assert.match(digestOf(first), /^[0-9a-f]{64}$/)
})

test('a broader scope changes the digest', async () => {
  const narrow = await apiReport(clean())
  const wide = await apiReport(fixture(
    [tool('tickets.reply', 'write', 'per-action', { scopes: ['helpdesk://acme/tickets/**'] })],
    [role('support-agent', 'write', 'internal')],
    [dataClass('support.tickets', 'internal')],
    [requirement('write', 'internal', 'per-action', 1, 'forbidden')],
  ))

  assert.notEqual(digestOf(narrow), digestOf(wide))
})

test('a changed policy version changes the digest even when every row is identical', async () => {
  const before = await apiReport(clean())
  const files = clean()
  files['policy.json'].version = '2026-10-1'
  const after = await apiReport(files)

  assert.deepEqual(after.matrix.rows, before.matrix.rows, 'the rows really are identical')
  assert.notEqual(digestOf(after), digestOf(before))
  assert.equal(after.matrix.version, '2026-10-1')
})

test('an added assumption changes the digest', async () => {
  const decided = await apiReport(clean())
  const undecided = await apiReport(fixture(
    [tool('tickets.reply', 'write', 'per-action', { roles: ['ghost'] })],
    [role('support-agent', 'write', 'internal')],
    [dataClass('support.tickets', 'internal')],
    [requirement('write', 'internal', 'per-action', 1, 'forbidden')],
  ))

  assert.equal(undecided.matrix.assumptions.length, 1)
  assert.notEqual(digestOf(decided), digestOf(undecided))
})

test('the digest does not cover the digest field, and the matrix document carries both', async () => {
  const report = await apiReport(clean())
  const { serializeMatrix } = await import('../src/index.mjs')
  const written = JSON.parse(serializeMatrix(report))

  assert.equal(written.digest, report.matrix.digest)
  assert.equal(written.version, report.matrix.version)
  assert.equal(written.tool, 'agent-permission-map')
  assert.equal(written.schemaVersion, '1')
  assert.deepEqual(written.rows, report.matrix.rows)
})

test('an unversioned policy still produces a digest, and says the version is missing', async () => {
  const files = clean()
  delete files['policy.json'].version
  const report = await apiReport(files)

  assert.equal(report.matrix.version, null)
  assert.match(report.matrix.digest, /^[0-9a-f]{64}$/)
  // Null is not the empty string and not "unknown": a consumer can tell that
  // nothing was declared rather than reading a version that was invented.
  assert.equal(report.status, 'incomplete')
})

/**
 * The matrix document is read on its own, so it has to say so on its own.
 *
 * `--out` wrote a signed matrix of `within-policy` rows from a run that had
 * exited 2 with a declared tool refused, and nothing in the artefact said the
 * audit had not completed: the only warning was a stderr line that `--json`
 * suppresses and that a consumer reading the file never sees at all. The
 * README calls this document "the thing a review signs off and a later run is
 * compared against", which is precisely why it cannot be silent about that.
 */
test('the written matrix carries the run status, so an incomplete run cannot be read as a clean one', async () => {
  const { serializeMatrix } = await import('../src/index.mjs')

  const passing = await apiReport(clean())
  assert.equal(passing.status, 'pass')
  assert.equal(passing.matrix.status, 'pass')
  assert.equal(JSON.parse(serializeMatrix(passing)).status, 'pass')

  const refused = await apiReport(fixture(
    [tool('tickets.reply', 'write', 'per-action'), tool('mystery.tool', 'telepathy', 'per-action')],
    [role('support-agent', 'write', 'internal')],
    [dataClass('support.tickets', 'internal')],
    [requirement('write', 'internal', 'per-action', 1, 'forbidden')],
  ))
  const written = JSON.parse(serializeMatrix(refused))

  assert.equal(refused.status, 'incomplete')
  assert.equal(written.status, 'incomplete', 'the artefact must say what the exit code said')
  // And the refusal itself is in the document, not only in the findings the
  // artefact does not carry.
  assert.equal(written.rows.find((row) => row.id === 'mystery.tool').verdict, 'undecided')
  assert.equal(written.assumptions.length, 1)
})

test('the status is inside the digest, so approving the bytes approves the completeness claim', async () => {
  const { createMatrix } = await import('../src/index.mjs')
  const rows = []
  const assumptions = []

  const complete = createMatrix('pass', '2026-09-1', rows, assumptions)
  const partial = createMatrix('incomplete', '2026-09-1', rows, assumptions)

  assert.notEqual(complete.digest, partial.digest)
  assert.equal(complete.status, 'pass')
  assert.equal(partial.status, 'incomplete')
})

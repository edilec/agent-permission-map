import assert from 'node:assert/strict'
import test from 'node:test'

import {
  cliRun,
  dataClass,
  fixture,
  requirement,
  role,
  tool,
  withRoot,
} from './support.mjs'

/**
 * A value this tool refuses is described, never reproduced.
 *
 * The declarations this tool reads sit next to credentials in real exports, and
 * stdout is a stream that gets piped, logged and pasted somewhere more public
 * than the input ever was. So the canary below is planted in every field where
 * arbitrary content can arrive -- descriptions, an unknown key's name, a
 * refused scope, a refused word, a refused id, a whole document -- and the
 * assertion is that no prefix of it survives on either stream.
 *
 * The placeholder is the one from the AWS documentation. It is not a
 * credential and never was.
 */

const CANARY = 'AKIAIOSFODNN7EXAMPLE'

const sweeps = [
  ['a description', fixture(
    [tool('tickets.reply', 'write', 'per-action', { description: `notes ${CANARY}` })],
    [role('support-agent', 'write', 'internal')],
    [dataClass('support.tickets', 'internal')],
    [requirement('write', 'internal', 'per-action', 1, 'forbidden')],
  )],
  ['an unknown key name', fixture(
    [tool('tickets.reply', 'write', 'per-action', { [CANARY]: 'x' })],
    [role('support-agent', 'write', 'internal')],
    [dataClass('support.tickets', 'internal')],
    [requirement('write', 'internal', 'per-action', 1, 'forbidden')],
  )],
  ['an unknown key value', fixture(
    [tool('tickets.reply', 'write', 'per-action', { secret: CANARY })],
    [role('support-agent', 'write', 'internal')],
    [dataClass('support.tickets', 'internal')],
    [requirement('write', 'internal', 'per-action', 1, 'forbidden')],
  )],
  ['a refused scope', fixture(
    [tool('tickets.reply', 'write', 'per-action', { scopes: [`helpdesk://acme//${CANARY}`] })],
    [role('support-agent', 'write', 'internal')],
    [dataClass('support.tickets', 'internal')],
    [requirement('write', 'internal', 'per-action', 1, 'forbidden')],
  )],
  ['a refused capability word', fixture(
    [tool('tickets.reply', CANARY, 'per-action')],
    [role('support-agent', 'write', 'internal')],
    [dataClass('support.tickets', 'internal')],
    [requirement('write', 'internal', 'per-action', 1, 'forbidden')],
  )],
  ['a refused approval word', fixture(
    [tool('tickets.reply', 'write', CANARY)],
    [role('support-agent', 'write', 'internal')],
    [dataClass('support.tickets', 'internal')],
    [requirement('write', 'internal', 'per-action', 1, 'forbidden')],
  )],
  ['a refused sensitivity word', fixture(
    [tool('tickets.reply', 'write', 'per-action')],
    [role('support-agent', 'write', 'internal')],
    [dataClass('support.tickets', CANARY)],
    [requirement('write', 'internal', 'per-action', 1, 'forbidden')],
  )],
  ['a refused schema version', fixture(
    [tool('tickets.reply', 'write', 'per-action')],
    [role('support-agent', 'write', 'internal')],
    [dataClass('support.tickets', 'internal')],
    [requirement('write', 'internal', 'per-action', 1, 'forbidden')],
  )],
  ['a refused id', fixture(
    [tool({ nested: CANARY }, 'write', 'per-action')],
    [role('support-agent', 'write', 'internal')],
    [dataClass('support.tickets', 'internal')],
    [requirement('write', 'internal', 'per-action', 1, 'forbidden')],
  )],
]
sweeps[7][1]['roles.json'].schemaVersion = CANARY

for (const [label, files] of sweeps) {
  test(`the canary planted in ${label} reaches neither stream`, async () => {
    await withRoot(files, async (root) => {
      const run = await cliRun(['--root', root])
      const streams = run.stdout + run.stderr

      // Every prefix down to eight characters, so a truncation that keeps the
      // front of the value fails this too.
      for (let length = CANARY.length; length >= 8; length -= 1) {
        assert.equal(streams.includes(CANARY.slice(0, length)), false, `${label} leaked ${length} characters`)
      }
      assert.equal(run.stdout.length > 0, true, 'and the run really did report something')
    })
  })
}

test('a document that is nothing but the canary is not quoted back by its parse failure', async () => {
  // V8 answers `JSON.parse('AKIAIOSFODNN7EXAMPLE')` with
  // `Unexpected token 'A', "AKIAIOSFODNN7EXAMPLE" is not valid JSON`, which
  // reproduces the whole file in the error message.
  await withRoot({
    'tools.json': CANARY,
    'roles.json': { schemaVersion: '1', roles: [] },
    'policy.json': { schemaVersion: '1', version: '1', dataClasses: [], requirements: [] },
  }, async (root) => {
    const run = await cliRun(['--root', root])
    const streams = run.stdout + run.stderr

    assert.equal(run.code, 2)
    for (let length = CANARY.length; length >= 8; length -= 1) {
      assert.equal(streams.includes(CANARY.slice(0, length)), false, `the parse failure leaked ${length} characters`)
    }
    assert.match(run.stdout, /is not valid JSON/)
  })
})

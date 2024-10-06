import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import {
  clean,
  cliRun,
  dataClass,
  fixture,
  projectDirectory,
  requirement,
  role,
  tool,
  withRoot,
} from './support.mjs'

/**
 * "This tool modifies no account", proved as far as a local tool can prove it.
 *
 * The claim is the whole reason a team would be willing to point this at a real
 * export of their agent permissions, so it is checked several ways, because
 * each of them can hold while the property is false:
 *
 * 1. A byte-for-byte snapshot of the input tree around a real run of the real
 *    binary -- names, sizes, contents and modification times -- for a run that
 *    passes, one that fails and one that reports incomplete. "We only write on
 *    success" is a defect this shape of tool is prone to.
 * 2. A read of the shipped source: the file-system imports are named exactly,
 *    and the only writing verb in the package is the one guarded `writeFile` in
 *    the binary.
 * 3. The absence of every surface that could change something elsewhere: no
 *    child process, no `eval`, no credential read, no environment read.
 */

async function snapshot(root) {
  const rows = []
  for (const name of (await readdir(root)).sort()) {
    const info = await stat(join(root, name))
    const bytes = await readFile(join(root, name))
    rows.push({ name, size: info.size, mtimeMs: info.mtimeMs, digest: createHash('sha256').update(bytes).digest('hex') })
  }
  return rows
}

const failing = () => fixture(
  [tool('tickets.reply', 'write', 'none', { scopes: ['helpdesk://**'] })],
  [role('support-agent', 'write', 'internal')],
  [dataClass('support.tickets', 'internal')],
  [requirement('write', 'internal', 'per-action', 1, 'forbidden')],
)

test('a real run over a real root changes nothing in it, whatever the verdict', async () => {
  const cases = [
    ['a clean declaration set', clean(), 0],
    ['a set the policy refuses', failing(), 1],
    ['a document that could not be parsed', { ...clean(), 'roles.json': 'not json at all' }, 2],
  ]

  for (const [label, files, expected] of cases) {
    await withRoot(files, async (root) => {
      const before = await snapshot(root)
      const run = await cliRun(['--root', root, '--json'])

      assert.equal(run.code, expected, label)
      assert.deepEqual(await snapshot(root), before, `${label}: the input tree is byte-for-byte what it was`)
      assert.equal((await readdir(root)).length, 3, `${label}: all three documents are still there`)
    })
  }
})

async function shippedSource() {
  const parts = []
  for (const directory of ['bin', 'src']) {
    for (const name of (await readdir(join(projectDirectory, directory))).sort()) {
      parts.push(await readFile(join(projectDirectory, directory, name), 'utf8'))
    }
  }
  return parts.join(String.fromCharCode(10))
}

test('the shipped source imports exactly the file-system surfaces it needs, and no more', async () => {
  const source = await shippedSource()

  // Naming the bindings that are present is the assertion that means something:
  // a list of verbs that must be absent passes on a prose mention and fails on
  // one, while this line fails the moment another verb is imported at all.
  const imports = (source.match(/import \{[^}]*\} from 'node:fs[^']*'/g) ?? []).sort()
  assert.deepEqual(imports, [
    "import { lstat, realpath, stat } from 'node:fs/promises'",
    "import { readFile, realpath, stat } from 'node:fs/promises'",
    "import { writeFile } from 'node:fs/promises'",
  ])
  assert.equal(/from 'node:fs'/.test(source), false, 'no synchronous file-system surface either')
})

test('the one writing verb in the package is the guarded destination write', async () => {
  const source = await shippedSource()

  const writes = source.match(/\bwriteFile\s*\(/g) ?? []
  assert.equal(writes.length, 1)
  assert.match(source, /await writeFile\(destination,/)

  // Matched as calls rather than as substrings: "truncated" is an honest word
  // in a comment about limits and "truncate" is a way to destroy a file.
  for (const verb of [
    'appendFile', 'unlink', 'rm', 'rmdir', 'mkdir', 'rename', 'copyFile', 'truncate',
    'createWriteStream', 'opendir', 'chmod', 'chown', 'utimes', 'symlink', 'link', 'cp',
  ]) {
    assert.equal(new RegExp(`\\b${verb}\\s*\\(`).test(source), false, `the source calls ${verb}()`)
  }
})

test('nothing in the package could change something elsewhere on this machine', async () => {
  const source = await shippedSource()

  assert.equal(source.includes('node:child_process'), false, 'nothing could act on this package behalf')
  assert.equal(source.includes('node:worker_threads'), false)
  assert.equal(/\beval\s*\(/.test(source), false)
  assert.equal(/\bnew\s+Function\b/.test(source), false)
  // No credential, token or account surface is read, which is the other half of
  // "modifies no account": a tool that held one could be pointed at an API by a
  // later edit without anybody noticing the new import.
  assert.equal(/process\.env/.test(source), false, 'no environment is read')
  for (const word of ['Authorization', 'apiKey', 'accessToken', 'credentials']) {
    assert.equal(source.includes(word), false, `the source mentions ${word}`)
  }
})

test('the binary writes to the two streams the report contract allows, and reads no stream', async () => {
  const source = await readFile(join(projectDirectory, 'bin/agent-permission-map.mjs'), 'utf8')

  const writes = source.match(/[\w$.]*\.write\s*\(/g) ?? []
  assert.equal(writes.length > 0, true)
  for (const call of writes) {
    assert.equal(['process.stdout.write(', 'process.stderr.write('].includes(call.replace(/\s+/g, '')), true, call)
  }
  assert.equal(source.includes('process.stdin'), false)
})

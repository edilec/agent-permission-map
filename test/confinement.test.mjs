import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { isInside, mapAgentPermissions } from '../src/index.mjs'
import { clean, cliRun, findingsFor, raisedRules, withRoot } from './support.mjs'

/**
 * Path confinement resolves real paths on both sides.
 *
 * Rejecting `../` and absolute paths is not confinement: a symbolic link
 * planted inside the declared root contains no `..` at all, points anywhere,
 * and in this catalog was followed out of the tree with out-of-root content
 * echoed into a report. Both sides are resolved and then compared.
 *
 * The false-refusal direction matters too. Comparing a resolved root against an
 * unresolved target refuses every legitimate file whenever the root itself is
 * reached through a link -- on macOS `/var` is a link to `/private/var`, which
 * is where every temporary directory in this suite lives.
 */

test('a symbolic link inside the root that points outside it is refused unread', async () => {
  await withRoot(clean(), async (root) => {
    const outside = await mkdtemp(join(tmpdir(), 'agent-permission-map-outside-'))
    try {
      await writeFile(join(outside, 'stolen.json'), JSON.stringify({ secretPayload: 'ZQXJVBMP7W' }))
      await symlink(join(outside, 'stolen.json'), join(root, 'linked.json'))

      const run = await cliRun(['--root', root, '--json', '--roles', 'linked.json'])
      const report = JSON.parse(run.stdout)

      assert.equal(raisedRules(report).includes('path-escapes-root'), true)
      assert.equal(run.code, 2)
      assert.equal(report.status, 'incomplete')
      // Refused unread: nothing from the file outside the tree appears anywhere.
      assert.equal((run.stdout + run.stderr).includes('ZQXJVBMP7W'), false)
      assert.equal(findingsFor(report, 'path-escapes-root')[0].location.file, 'linked.json')
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })
})

test('a legitimate file under a symbolically linked root is read, not refused', async () => {
  // The guard that refuses everything passes the case above and is useless.
  const parent = await mkdtemp(join(tmpdir(), 'agent-permission-map-parent-'))
  try {
    const real = join(parent, 'real')
    await mkdir(real)
    for (const [name, content] of Object.entries(clean())) {
      await writeFile(join(real, name), `${JSON.stringify(content, null, 2)}\n`)
    }
    await symlink(real, join(parent, 'linked'))

    const run = await cliRun(['--root', join(parent, 'linked'), '--json'])
    assert.equal(run.code, 0)
    assert.equal(JSON.parse(run.stdout).status, 'pass')
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
})

test('an absolute or climbing input name is a configuration error, before any evidence is read', async () => {
  await withRoot(clean(), async (root) => {
    for (const name of ['/etc/passwd', '../outside.json', 'nested/../../outside.json']) {
      const run = await cliRun(['--root', root, '--json', '--roles', name])
      assert.equal(run.code, 2, name)
      assert.equal(run.stdout, '', `${name} put a report on stdout`)
    }
  })
})

test('a directory named as an input is reported as unreadable rather than walked', async () => {
  await withRoot(clean(), async (root) => {
    await mkdir(join(root, 'folder'))
    const run = await cliRun(['--root', root, '--json', '--roles', 'folder'])
    const report = JSON.parse(run.stdout)

    assert.equal(raisedRules(report).includes('input-unreadable'), true)
    assert.equal(run.code, 2)
  })
})

test('a root that is not a directory is a configuration error with an empty stdout', async () => {
  await withRoot(clean(), async (root) => {
    const run = await cliRun(['--root', join(root, 'tools.json'), '--json'])
    assert.equal(run.code, 2)
    assert.equal(run.stdout, '')
    assert.match(run.stderr, /--root must be a directory/)
  })
})

test('a root that does not exist is a configuration error with an empty stdout', async () => {
  const run = await cliRun(['--root', join(tmpdir(), 'agent-permission-map-does-not-exist'), '--json'])
  assert.equal(run.code, 2)
  assert.equal(run.stdout, '')
  assert.match(run.stderr, /--root could not be resolved/)
})

test('isInside compares whole path segments, not string prefixes', () => {
  assert.equal(isInside('/a/root', '/a/root'), true)
  assert.equal(isInside('/a/root', '/a/root/inner/file.json'), true)
  // The prefix trap: `/a/rootless` starts with `/a/root` as a string and is a
  // different directory entirely.
  assert.equal(isInside('/a/root', '/a/rootless/file.json'), false)
  assert.equal(isInside('/a/root', '/a'), false)
})

test('the API refuses a missing root rather than defaulting to the working directory', async () => {
  await assert.rejects(() => mapAgentPermissions({}), /root must be a non-empty string/)
  await assert.rejects(() => mapAgentPermissions({ root: '' }), /root must be a non-empty string/)
})

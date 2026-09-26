import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { cliRun, projectDirectory, raisedRules } from './support.mjs'

/**
 * The shipped examples run, and they demonstrate what the README says they do.
 *
 * `npm run check` runs the clean one on every build. An example that stopped
 * working, or that quietly started reporting something else, would otherwise be
 * documentation that nobody executes.
 */

const exampleRoot = (name) => join(projectDirectory, 'examples', name)

async function snapshot(root) {
  const rows = []
  for (const name of (await readdir(root)).sort()) {
    const info = await stat(join(root, name))
    const bytes = await readFile(join(root, name))
    rows.push({ name, size: info.size, mtimeMs: info.mtimeMs, digest: createHash('sha256').update(bytes).digest('hex') })
  }
  return rows
}

test('examples/clean maps every tool and exits 0', async () => {
  const run = await cliRun(['--root', exampleRoot('clean'), '--json'])
  const report = JSON.parse(run.stdout)

  assert.equal(run.code, 0)
  assert.equal(report.status, 'pass')
  assert.deepEqual(report.findings, [])
  assert.equal(report.summary.checked, 3)
  assert.equal(report.summary.withinPolicy, 3)
  assert.equal(report.matrix.version, '2026-09-1')
})

test('examples/broad shows an overly broad scope and exits 1', async () => {
  const run = await cliRun(['--root', exampleRoot('broad'), '--json'])
  const report = JSON.parse(run.stdout)

  assert.equal(run.code, 1)
  assert.equal(report.status, 'fail')
  assert.deepEqual(raisedRules(report), [
    'approval-below-requirement',
    'role-capability-exceeded',
    'role-sensitivity-exceeded',
    'scope-too-broad',
    'scope-unbounded',
  ])
  assert.equal(report.summary.overbroadScopes, 2)
  assert.equal(report.summary.outsidePolicy, 2)
  assert.equal(report.summary.undecided, 0, 'this example fails on evidence rather than on missing evidence')
})

test('examples/incomplete cannot pass, and says which assumption it could not make', async () => {
  const run = await cliRun(['--root', exampleRoot('incomplete'), '--json'])
  const report = JSON.parse(run.stdout)

  assert.equal(run.code, 2)
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(raisedRules(report), ['data-class-unknown'])
  assert.equal(report.summary.undecided, 1)
  assert.equal(report.matrix.assumptions.length, 1)
  assert.match(report.matrix.assumptions[0].assumption, /sensitivity is unknown/)
})

test('running an example changes nothing in it', async () => {
  for (const name of ['broad', 'clean', 'incomplete']) {
    const root = exampleRoot(name)
    const before = await snapshot(root)
    await cliRun(['--root', root, '--json'])
    assert.deepEqual(await snapshot(root), before, `examples/${name} is byte-for-byte what it was`)
  }
})

test('every example root holds exactly the three documents the README names', async () => {
  for (const name of ['broad', 'clean', 'incomplete']) {
    assert.deepEqual((await readdir(exampleRoot(name))).sort(), ['policy.json', 'roles.json', 'tools.json'])
  }
})

test('the README quick start commands are the ones that exist', async () => {
  const readme = await readFile(join(projectDirectory, 'README.md'), 'utf8')
  const manifest = JSON.parse(await readFile(join(projectDirectory, 'package.json'), 'utf8'))

  assert.equal(readme.includes('--root examples/clean'), true)
  assert.equal(manifest.scripts.example.includes('examples/clean'), true)
  assert.equal(manifest.bin['agent-permission-map'], './bin/agent-permission-map.mjs')
})

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import test from 'node:test'

import { TOOL_ID } from '../src/index.mjs'
import { clean, cliRun, projectDirectory, withRoot } from './support.mjs'

/** The CLI surface: help, version, streams, and the three exit codes. */

test('TOOL_ID is exported and equal to the directory name', () => {
  assert.equal(TOOL_ID, 'agent-permission-map')
  assert.equal(TOOL_ID, basename(projectDirectory))
})

test('--help prints to stdout, exits 0, and documents every option the parser accepts', async () => {
  const run = await cliRun(['--help'])

  assert.equal(run.code, 0)
  assert.equal(run.stderr, '')
  const source = await readFile(join(projectDirectory, 'bin/agent-permission-map.mjs'), 'utf8')
  // Every flag the parser knows, taken from the parser itself rather than from
  // a list this test keeps: a flag added without a help entry fails here.
  const flags = [...source.matchAll(/\['(--[a-z-]+)',/g)].map((match) => match[1])
  assert.equal(flags.length > 0, true)
  for (const flag of flags) assert.equal(run.stdout.includes(flag), true, `--help documents ${flag}`)
  for (const flag of ['--json', '-h', '--help', '-v', '--version']) {
    assert.equal(run.stdout.includes(flag), true, `--help documents ${flag}`)
  }
})

test('--help states what the tool does not do, and the exit codes it uses', async () => {
  const run = await cliRun(['--help'])

  assert.match(run.stdout, /MODIFIES NO ACCOUNT/)
  assert.match(run.stdout, /Unknown is never a pass/)
  assert.match(run.stdout, /0 {2}the declarations were mapped/)
  assert.match(run.stdout, /1 {2}they were mapped/)
  assert.match(run.stdout, /2 {2}invalid configuration/)
})

test('--version prints the version the package declares', async () => {
  const run = await cliRun(['--version'])
  const manifest = JSON.parse(await readFile(join(projectDirectory, 'package.json'), 'utf8'))

  assert.equal(run.code, 0)
  assert.equal(run.stdout.trim(), manifest.version)
})

test('an unknown option is a configuration error: empty stdout, help on stderr, exit 2', async () => {
  const run = await cliRun(['--root', '.', '--make-it-pass'])

  assert.equal(run.code, 2)
  assert.equal(run.stdout, '')
  assert.match(run.stderr, /Unknown option "--make-it-pass"/)
  assert.match(run.stderr, /Usage:/)
})

test('a missing --root is a configuration error rather than a scan of the working directory', async () => {
  const run = await cliRun([])

  assert.equal(run.code, 2)
  assert.equal(run.stdout, '')
  assert.match(run.stderr, /--root is required/)
})

test('stdout carries one JSON document and nothing else', async () => {
  await withRoot(clean(), async (root) => {
    const run = await cliRun(['--root', root])

    const report = JSON.parse(run.stdout)
    assert.equal(report.tool, TOOL_ID)
    assert.equal(run.stdout.trimEnd().endsWith('}'), true)
    assert.equal(run.stdout.trimStart().startsWith('{'), true)
    // The human summary is on the other stream, which is why a successful run
    // has a non-empty stderr.
    assert.equal(run.stderr.length > 0, true)
  })
})

test('--json suppresses the human summary and leaves stdout untouched', async () => {
  await withRoot(clean(), async (root) => {
    const quiet = await cliRun(['--root', root, '--json'])
    const loud = await cliRun(['--root', root])

    assert.equal(quiet.stderr, '')
    assert.equal(quiet.stdout, loud.stdout)
    assert.equal(quiet.code, 0)
  })
})

test('the human summary names the status, the digest and the no-account claim', async () => {
  await withRoot(clean(), async (root) => {
    const run = await cliRun(['--root', root])

    assert.match(run.stderr, /status pass/)
    assert.match(run.stderr, /matrix version 2026-09-1 digest [0-9a-f]{64}/)
    assert.match(run.stderr, /modifies no account/)
  })
})

test('an incomplete run says on stderr that it is not a pass', async () => {
  await withRoot({ ...clean(), 'roles.json': '{' }, async (root) => {
    const run = await cliRun(['--root', root])

    assert.equal(run.code, 2)
    assert.match(run.stderr, /this run is not a pass/)
  })
})

test('the report envelope is the shape the contract declares', async () => {
  await withRoot(clean(), async (root) => {
    const report = JSON.parse((await cliRun(['--root', root, '--json'])).stdout)

    assert.deepEqual(Object.keys(report), ['schemaVersion', 'tool', 'status', 'summary', 'matrix', 'findings'])
    assert.equal(report.schemaVersion, '1')
    assert.equal(['pass', 'fail', 'incomplete'].includes(report.status), true)
    for (const [key, value] of Object.entries(report.summary)) {
      assert.equal(Number.isInteger(value), true, `summary.${key} is an integer`)
    }
    assert.equal(Array.isArray(report.findings), true)
  })
})

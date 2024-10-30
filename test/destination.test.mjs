import assert from 'node:assert/strict'
import { link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { DestinationError, assertWritableDestination } from '../src/index.mjs'
import { CLI, clean, cliRun, withRoot } from './support.mjs'

/**
 * `--out` is the only path this tool writes to, and it is not a safe place to
 * put an unchecked path.
 *
 * Measured across this catalog rather than imagined: ten tools accepted a
 * destination that overwrote something they were never asked to touch, and four
 * of them exited 0 saying the write succeeded. The four holes are independent
 * and each needs its own case, because guarding one or two is what every one of
 * those tools had already done:
 *
 * 1. A **symlink at the destination** -- `realpath` resolves it, and resolving
 *    is the dangerous act, so it is refused on sight by `lstat`.
 * 2. A **symlinked parent** -- a lexical prefix check passes for
 *    `root/link/out`, so the parent is resolved and then compared.
 * 3. A **hard link to an input** -- no target and no shared path, so only
 *    device plus inode sees that it is the same file.
 * 4. A **dangling input link to a new output** -- no output inode exists yet;
 *    writing makes the previously unreadable input resolve to output bytes.
 *
 * The allowed cases matter just as much: a guard that refuses everything passes
 * every data-loss test above while making the tool useless, and a guard that
 * refuses every symlinked ancestor refuses every run under the macOS temp
 * directory, where `/var` is itself a link to `/private/var`.
 */

async function withTree(body) {
  const directory = await mkdtemp(join(tmpdir(), 'agent-permission-map-out-'))
  try {
    return await body(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test('hole 1: a symbolic link at the destination is refused, and what it points at is untouched', async () => {
  await withTree(async (outRoot) => {
    const victim = join(outRoot, 'precious.json')
    await writeFile(victim, 'do not overwrite me')
    await symlink(victim, join(outRoot, 'matrix.json'))

    await withRoot(clean(), async (root) => {
      const run = await cliRun([
        '--root', root, '--json', '--out', join(outRoot, 'matrix.json'), '--out-root', outRoot,
      ])

      assert.equal(run.code, 2)
      assert.equal(run.stdout, '', 'a refused destination is a configuration error, so stdout is empty')
      assert.match(run.stderr, /symbolic link/)
      assert.equal(await readFile(victim, 'utf8'), 'do not overwrite me')
    })
  })
})

test('hole 1: a symbolic link to a path that does not exist yet is refused before it creates one', async () => {
  await withTree(async (outRoot) => {
    await withTree(async (elsewhere) => {
      const target = join(elsewhere, 'not-yet.json')
      await symlink(target, join(outRoot, 'matrix.json'))

      await withRoot(clean(), async (root) => {
        const run = await cliRun([
          '--root', root, '--json', '--out', join(outRoot, 'matrix.json'), '--out-root', outRoot,
        ])

        assert.equal(run.code, 2)
        assert.equal(run.stdout, '')
        await assert.rejects(() => stat(target), 'nothing was created outside the tree')
      })
    })
  })
})

test('hole 2: a symlinked parent directory that leaves --out-root is refused', async () => {
  await withTree(async (outRoot) => {
    await withTree(async (elsewhere) => {
      await symlink(elsewhere, join(outRoot, 'escape'))

      await withRoot(clean(), async (root) => {
        const run = await cliRun([
          '--root', root, '--json', '--out', join(outRoot, 'escape/matrix.json'), '--out-root', outRoot,
        ])

        assert.equal(run.code, 2)
        assert.equal(run.stdout, '')
        assert.match(run.stderr, /outside the permitted root/)
        await assert.rejects(() => stat(join(elsewhere, 'matrix.json')), 'nothing was written through the link')
      })
    })
  })
})

test('hole 2, the other direction: a symlinked parent that stays inside --out-root is allowed', async () => {
  // Without this case a guard that refuses every symlinked ancestor would pass
  // the case above -- and would refuse every run under the macOS temp
  // directory, since /var is itself a link to /private/var.
  await withTree(async (outRoot) => {
    await mkdir(join(outRoot, 'real'))
    await symlink(join(outRoot, 'real'), join(outRoot, 'linked'))

    await withRoot(clean(), async (root) => {
      const run = await cliRun([
        '--root', root, '--json', '--out', join(outRoot, 'linked/matrix.json'), '--out-root', outRoot,
      ])

      assert.equal(run.code, 0)
      const written = JSON.parse(await readFile(join(outRoot, 'real/matrix.json'), 'utf8'))
      assert.equal(written.tool, 'agent-permission-map')
    })
  })
})

test('hole 3: a hard link to any of the three inputs is refused, not just the primary one', async () => {
  // A sibling tool passed only its primary input to the guard and destroyed
  // every other file it read, so every input the run may open is checked.
  for (const name of ['policy.json', 'roles.json', 'tools.json']) {
    await withTree(async (outRoot) => {
      await withRoot(clean(), async (root) => {
        const input = join(root, name)
        const before = await readFile(input, 'utf8')
        await link(input, join(outRoot, 'matrix.json'))

        const run = await cliRun([
          '--root', root, '--json', '--out', join(outRoot, 'matrix.json'), '--out-root', outRoot,
        ])

        assert.equal(run.code, 2, `${name} is refused as a destination`)
        assert.equal(run.stdout, '')
        assert.match(run.stderr, /same file as an input/)
        assert.equal(await readFile(input, 'utf8'), before, `${name} is byte-for-byte what it was`)
      })
    })
  }
})

test('the allowed case: a new file is written, and it carries the versioned matrix', async () => {
  await withTree(async (outRoot) => {
    await withRoot(clean(), async (root) => {
      const out = join(outRoot, 'matrix.json')
      const run = await cliRun(['--root', root, '--json', '--out', out, '--out-root', outRoot])

      assert.equal(run.code, 0)
      const written = JSON.parse(await readFile(out, 'utf8'))
      assert.equal(written.tool, 'agent-permission-map')
      assert.equal(written.version, '2026-09-1')
      assert.equal(typeof written.digest, 'string')
      assert.equal(written.rows.length, 1)
      // The report still goes to stdout: --out adds an artefact, it does not
      // move the report off the stream a consumer pipes.
      assert.equal(JSON.parse(run.stdout).matrix.digest, written.digest)
    })
  })
})

test('a distinct missing named input still permits an incomplete matrix at a new output', async () => {
  const { 'tools.json': omitted, ...documents } = clean()
  assert.ok(omitted)
  await withRoot(documents, async (root) => {
    const out = join(root, 'matrix.json')
    const run = await cliRun(['--root', root, '--json', '--out', out, '--out-root', root])
    assert.equal(run.code, 2)
    assert.equal(JSON.parse(run.stdout).status, 'incomplete')
    assert.equal(JSON.parse(await readFile(out, 'utf8')).status, 'incomplete')
    await assert.rejects(() => stat(join(root, 'tools.json')))
  })
})

test('a dangling input link to the absent matrix is refused before one or two hops become readable', async () => {
  const { 'tools.json': omitted, ...documents } = clean()
  assert.ok(omitted)
  for (const hops of [1, 2]) {
    await withRoot(documents, async (root) => {
      const out = join(root, 'matrix.json')
      const input = join(root, 'tools.json')
      if (hops === 2) {
        await symlink('matrix.json', join(root, 'middle.json'))
        await symlink('middle.json', input)
      } else await symlink('matrix.json', input)

      const run = await cliRun(['--root', root, '--json', '--out', out, '--out-root', root])
      assert.equal(run.code, 2)
      assert.equal(run.stdout, '', 'a refused destination is a configuration error')
      assert.match(run.stderr, /names an input path/)
      await assert.rejects(() => stat(out), 'no matrix was created through the input alias')
      await assert.rejects(() => stat(input), 'the named input remains unreadable')
    })
  }
})

test('the allowed case: an existing ordinary file that is not an input is overwritten', async () => {
  await withTree(async (outRoot) => {
    const out = join(outRoot, 'matrix.json')
    await writeFile(out, 'stale matrix from the last run')

    await withRoot(clean(), async (root) => {
      const run = await cliRun(['--root', root, '--json', '--out', out, '--out-root', outRoot])

      assert.equal(run.code, 0)
      assert.equal(JSON.parse(await readFile(out, 'utf8')).tool, 'agent-permission-map')
    })
  })
})

test('a destination that is a directory, or whose parent does not exist, is refused', async () => {
  await withTree(async (outRoot) => {
    await mkdir(join(outRoot, 'folder'))
    await withRoot(clean(), async (root) => {
      const directoryRun = await cliRun([
        '--root', root, '--json', '--out', join(outRoot, 'folder'), '--out-root', outRoot,
      ])
      assert.equal(directoryRun.code, 2)
      assert.match(directoryRun.stderr, /not a regular file/)

      const missingRun = await cliRun([
        '--root', root, '--json', '--out', join(outRoot, 'nowhere/matrix.json'), '--out-root', outRoot,
      ])
      assert.equal(missingRun.code, 2)
      assert.match(missingRun.stderr, /does not exist/)
    })
  })
})

test('the destination is checked before the inputs are read, so a refusal writes nothing at all', async () => {
  await withTree(async (outRoot) => {
    await symlink(join(outRoot, 'victim.json'), join(outRoot, 'matrix.json'))
    await writeFile(join(outRoot, 'victim.json'), 'kept')

    // The inputs are unreadable too. A tool that read first and checked later
    // would report on them before refusing; this one refuses first, so stdout
    // carries nothing and the exit code is the configuration one.
    await withRoot({ 'tools.json': '{', 'roles.json': '{', 'policy.json': '{' }, async (root) => {
      const run = await cliRun([
        '--root', root, '--json', '--out', join(outRoot, 'matrix.json'), '--out-root', outRoot,
      ])

      assert.equal(run.code, 2)
      assert.equal(run.stdout, '')
      assert.equal(await readFile(join(outRoot, 'victim.json'), 'utf8'), 'kept')
    })
  })
})

test('--out-root without --out is a usage error rather than an ignored flag', async () => {
  await withRoot(clean(), async (root) => {
    const run = await cliRun(['--root', root, '--json', '--out-root', root])

    assert.equal(run.code, 2)
    assert.equal(run.stdout, '')
    assert.match(run.stderr, /--out-root has no meaning without --out/)
  })
})

test('the guard is exported and refuses each hole on its own, so a caller can reuse it', async () => {
  await withTree(async (directory) => {
    const input = join(directory, 'input.json')
    await writeFile(input, '{}')

    await symlink(input, join(directory, 'linked.json'))
    await assert.rejects(
      () => assertWritableDestination(join(directory, 'linked.json'), { inputs: [input], root: directory }),
      DestinationError,
    )

    await link(input, join(directory, 'hard.json'))
    await assert.rejects(
      () => assertWritableDestination(join(directory, 'hard.json'), { inputs: [input], root: directory }),
      DestinationError,
    )

    // And the allowed case through the same surface.
    const allowed = await assertWritableDestination(join(directory, 'fresh.json'), { inputs: [input], root: directory })
    assert.equal(allowed, join(directory, 'fresh.json'))
  })
})

test('the binary is the only place that writes, and it writes through one call', async () => {
  const source = await readFile(CLI, 'utf8')

  // Every `.write(` in the file, whatever it is called on, rather than the
  // spellings this test hopes to find: matching `process\.(stdout|stderr)` and
  // then asserting each match is one of those two is a tautology, because a
  // third stream would simply not appear in the array.
  const writes = source.match(/[\w$.]*\.write\s*\(/g) ?? []
  assert.equal(writes.length > 0, true)
  for (const call of writes) {
    assert.equal(['process.stdout.write(', 'process.stderr.write('].includes(call.replace(/\s+/g, '')), true, call)
  }
  const fileWrites = source.match(/\bwriteFile\s*\(/g) ?? []
  assert.equal(fileWrites.length, 1, 'exactly one file write, and it is the guarded destination')
  assert.match(source, /await writeFile\(destination,/)
})

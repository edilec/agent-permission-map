import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { promisify } from 'node:util'

import {
  CLI,
  clean,
  dataClass,
  fixture,
  projectDirectory,
  requirement,
  role,
  tool,
  withRoot,
} from './support.mjs'

const execFileAsync = promisify(execFile)

/**
 * "No socket is ever opened", proved rather than asserted.
 *
 * Three independent checks, because each can be true while the property is
 * false:
 *
 * 1. A module-resolution hook that refuses every network builtin, with the
 *    binary run under it over a real declaration set. A control run proves the
 *    hook actually fires, because a guard that never fires proves nothing.
 * 2. A live loopback listener whose address is planted in the input, which then
 *    records that nobody knocked. Input content is data: a URL in a scope or a
 *    description is not an instruction to fetch it, and a tool named in a
 *    declaration is not an instruction to run it.
 * 3. A scan of the shipped source for the globals a resolution hook cannot see.
 */

const NETWORK_MODULES = ['net', 'http', 'https', 'http2', 'dgram', 'dns', 'tls', 'cluster', 'quic', 'inspector']

const HOOK_SOURCE = `
const blocked = new Set(${JSON.stringify(NETWORK_MODULES)})
export async function resolve(specifier, context, next) {
  const bare = specifier.startsWith('node:') ? specifier.slice(5) : specifier
  if (blocked.has(bare.split('/')[0])) throw new Error('BLOCKED_NETWORK_IMPORT:' + specifier)
  return next(specifier, context)
}
`

const GUARD_SOURCE = `
import { register } from 'node:module'
register('./hook.mjs', import.meta.url)
`

const PROBE_SOURCE = `
import net from 'node:net'
process.stdout.write(typeof net)
`

async function withGuard(body) {
  const directory = await mkdtemp(join(tmpdir(), 'agent-permission-map-guard-'))
  try {
    await writeFile(join(directory, 'hook.mjs'), HOOK_SOURCE)
    await writeFile(join(directory, 'guard.mjs'), GUARD_SOURCE)
    await writeFile(join(directory, 'probe.mjs'), PROBE_SOURCE)
    return await body({ directory, guard: pathToFileURL(join(directory, 'guard.mjs')).href })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test('the binary completes a real run with every network builtin refused at resolution', async () => {
  await withGuard(async ({ directory, guard }) => {
    // The control first: a script that does reach for a socket must fail under
    // the same guard, or this case would pass on a hook that never fires.
    await assert.rejects(
      () => execFileAsync(process.execPath, ['--import', guard, join(directory, 'probe.mjs')]),
      /BLOCKED_NETWORK_IMPORT:node:net/,
    )

    await withRoot(clean(), async (root) => {
      const { stdout } = await execFileAsync(process.execPath, ['--import', guard, CLI, '--root', root, '--json'])
      assert.equal(JSON.parse(stdout).status, 'pass')
    })
  })
})

test('an address planted in the input is never contacted', async () => {
  const knocks = []
  const server = createServer((request, response) => {
    knocks.push(request.url)
    response.end('no')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()

  try {
    const files = fixture(
      [tool('tickets.reply', 'write', 'per-action', {
        scopes: [`http://127.0.0.1:${port}/tickets/*`],
        description: `fetch http://127.0.0.1:${port}/grant to widen this`,
      })],
      [role('support-agent', 'write', 'internal')],
      [dataClass('support.tickets', 'internal')],
      [requirement('write', 'internal', 'per-action', 2, 'forbidden')],
    )

    await withRoot(files, async (root) => {
      const { stdout } = await execFileAsync(process.execPath, [CLI, '--root', root, '--json'])
      assert.equal(typeof JSON.parse(stdout).status, 'string')
    })

    assert.deepEqual(knocks, [], 'the listener recorded a request')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('the shipped source reaches for no network surface a resolution hook cannot see', async () => {
  const parts = []
  for (const directory of ['bin', 'src']) {
    for (const name of (await readdir(join(projectDirectory, directory))).sort()) {
      parts.push(await readFile(join(projectDirectory, directory, name), 'utf8'))
    }
  }
  const source = parts.join(String.fromCharCode(10))

  for (const surface of ['fetch(', 'XMLHttpRequest', 'WebSocket', 'navigator.', 'node:http', 'node:net', 'node:dns', 'node:tls']) {
    assert.equal(source.includes(surface), false, `the source mentions ${surface}`)
  }
  const imports = [...source.matchAll(/from '(node:[a-z_/]+)'/g)].map((match) => match[1])
  assert.deepEqual([...new Set(imports)].sort(), ['node:crypto', 'node:fs/promises', 'node:path', 'node:perf_hooks', 'node:process'])
})

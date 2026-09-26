/**
 * Fixtures and runners shared by the test suite.
 *
 * Two entry points are exercised throughout: `apiReport` calls the exported
 * function, and `cliRun` spawns the real binary and reads the real exit code.
 * Several guarantees here can only be pinned by the second -- an exit code
 * cannot be satisfied by editing a table.
 *
 * Everything in this file builds *inputs*. Nothing in it decides what a test
 * expects: no severity, no rule id, no verdict, no count and no ordering lives
 * here, so a test cannot assert a value against the same declaration that
 * produced it.
 */

import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { mapAgentPermissions } from '../src/index.mjs'

const execFileAsync = promisify(execFile)

export const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const CLI = join(projectDirectory, 'bin/agent-permission-map.mjs')

/** One declared agent tool. Extra keys are merged so a test can break exactly one field. */
export function tool(id, capability, approval, extra = {}) {
  return {
    id,
    capability,
    approval,
    scopes: ['helpdesk://acme/tickets/*'],
    dataClasses: ['support.tickets'],
    roles: ['support-agent'],
    ...extra,
  }
}

/** One declared role. */
export function role(id, maxCapability, maxSensitivity, extra = {}) {
  return { id, maxCapability, maxSensitivity, ...extra }
}

/** One declared data class. */
export function dataClass(id, sensitivity, extra = {}) {
  return { id, sensitivity, ...extra }
}

/** One approval requirement, for exactly one capability and sensitivity pair. */
export function requirement(capability, sensitivity, approval, maxScopeWildcards, unboundedScope, extra = {}) {
  return { capability, sensitivity, approval, maxScopeWildcards, unboundedScope, ...extra }
}

export const toolDocument = (tools) => ({ schemaVersion: '1', tools })
export const roleDocument = (roles) => ({ schemaVersion: '1', roles })
export const policyDocument = (dataClasses, requirements, version = '2026-09-1') => ({
  schemaVersion: '1',
  version,
  dataClasses,
  requirements,
})

/** The three documents, as objects, under their default names. */
export const fixture = (tools, roles, dataClasses, requirements, version) => ({
  'tools.json': toolDocument(tools),
  'roles.json': roleDocument(roles),
  'policy.json': policyDocument(dataClasses, requirements, version),
})

/**
 * A declaration set that raises nothing at all: one internal class, one role
 * that may reach it, one requirement that governs it, and one tool that
 * satisfies the requirement. Tests break exactly one thing in it so that the
 * finding they assert is the only finding there is.
 */
export const clean = () => fixture(
  [tool('tickets.reply', 'write', 'per-action')],
  [role('support-agent', 'write', 'internal')],
  [dataClass('support.tickets', 'internal')],
  [requirement('write', 'internal', 'per-action', 1, 'forbidden')],
)

/**
 * Create a temporary root, write the named files into it, run `body(root)` and
 * remove the tree afterwards whatever happened.
 *
 * A string is written verbatim and a `Uint8Array` byte for byte, so a test can
 * plant text that is not JSON, or bytes that are not UTF-8 at all.
 */
export async function withRoot(files, body) {
  const root = await mkdtemp(join(tmpdir(), 'agent-permission-map-'))
  try {
    for (const [name, content] of Object.entries(files)) {
      const bytes = typeof content === 'string' || content instanceof Uint8Array
        ? content
        : `${JSON.stringify(content, null, 2)}\n`
      await writeFile(join(root, name), bytes)
    }
    return await body(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

/** Run the exported API over a temporary root. */
export async function apiReport(files, options = {}) {
  return withRoot(files, (root) => mapAgentPermissions({ root, ...options }))
}

/** Spawn the real binary. Returns the exit code and both streams; never throws on a non-zero exit. */
export async function cliRun(args) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args], { cwd: projectDirectory })
    return { code: 0, stdout, stderr }
  } catch (error) {
    return { code: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }
  }
}

/** Spawn the real binary over a temporary root, and parse whatever stdout carried. */
export async function cliReport(files, extraArgs = []) {
  return withRoot(files, async (root) => {
    const result = await cliRun(['--root', root, '--json', ...extraArgs])
    return { ...result, report: result.stdout === '' ? null : JSON.parse(result.stdout) }
  })
}

/** Every rule id a report raised, deduplicated and ordered by code unit. */
export const raisedRules = (report) =>
  [...new Set(report.findings.map((finding) => finding.ruleId))].sort()

/** The findings for one rule id, in emitted order. */
export const findingsFor = (report, ruleId) => report.findings.filter((finding) => finding.ruleId === ruleId)

/** The matrix row for one tool id. */
export const rowFor = (report, id) => report.matrix.rows.find((row) => row.id === id)

/**
 * A clock that hands out a scripted sequence of millisecond readings and counts
 * how many times it was asked.
 *
 * The time budget is the one bound here whose firing depends on when it is
 * checked rather than on what the input contains, so tests drive it by script
 * instead of by waiting. `calls` is readable afterwards, which is what lets a
 * test aim a single over-budget reading at exactly the check that happens after
 * the row loop has returned.
 */
export function scriptedClock(readingFor) {
  const state = { calls: 0 }
  const clock = () => {
    state.calls += 1
    return readingFor(state.calls)
  }
  clock.state = state
  return clock
}

/**
 * One character from each class the report contract names, built from code
 * points so every test file that uses them stays plain ASCII and readable.
 */
export const FORBIDDEN = Object.freeze({
  'C0 NUL': String.fromCharCode(0x00),
  'C0 LF': String.fromCharCode(0x0a),
  'C0 ESC': String.fromCharCode(0x1b),
  DEL: String.fromCharCode(0x7f),
  'C1 NEL': String.fromCharCode(0x85),
  'C1 CSI': String.fromCharCode(0x9b),
  'line separator': String.fromCharCode(0x2028),
  'paragraph separator': String.fromCharCode(0x2029),
  'bidi LRM': String.fromCharCode(0x200e),
  'bidi RLM': String.fromCharCode(0x200f),
  'bidi RLO': String.fromCharCode(0x202e),
  'bidi isolate': String.fromCharCode(0x2066),
})

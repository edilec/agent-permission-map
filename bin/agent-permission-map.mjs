#!/usr/bin/env node

import { writeFile } from 'node:fs/promises'
import process from 'node:process'

import {
  DEFAULT_POLICY_NAME,
  DEFAULT_ROLES_NAME,
  DEFAULT_TOOLS_NAME,
  DestinationError,
  assertWritableDestination,
  excerpt,
  exitCodeFor,
  formatReport,
  mapAgentPermissions,
  plannedInputs,
  serializeMatrix,
  serializeReport,
} from '../src/index.mjs'

const VERSION = '0.1.0'

const HELP = `agent-permission-map

Map declared agent tools to resource scope, data class, role and approval
condition, and produce a versioned permission matrix with the list of
assumptions the run could not make.

This tool MODIFIES NO ACCOUNT. It reads three JSON documents and writes a
report; with --out it also writes one matrix document at a path you name and it
checks first. It opens no socket, holds no credential, and grants, revokes and
changes nothing. A row says what the documents declare, never what a live
provider actually allows.

Unknown is never a pass. A data class nobody declared, a role nobody declared, a
scope that could not be measured, or a capability and sensitivity pair no
requirement governs, leaves the tool undecided, lists an assumption, and exits 2.

Usage:
  agent-permission-map --root DIR [--tools FILE] [--roles FILE] [--policy FILE]
                       [--out FILE] [--out-root DIR] [--json]
                       [--max-file-bytes N] [--max-tools N] [--max-roles N]
                       [--max-data-classes N] [--max-requirements N]
                       [--max-scopes N] [--max-class-references N]
                       [--max-role-references N] [--max-runtime-ms N]
                       [--max-findings N]

Options:
  --root DIR                Directory holding the three documents (required)
  --tools FILE              Tool declarations, relative to --root
                            (default ${DEFAULT_TOOLS_NAME})
  --roles FILE              Role declarations, relative to --root
                            (default ${DEFAULT_ROLES_NAME})
  --policy FILE             Approval policy and data classes, relative to --root
                            (default ${DEFAULT_POLICY_NAME})
  --out FILE                Also write the versioned matrix document here
  --out-root DIR            Directory --out must resolve inside
                            (default: the current working directory)
  --json                    Suppress the human summary on stderr
  --max-file-bytes N        Maximum bytes per document (default 5242880)
  --max-tools N             Maximum declared tools (default 500)
  --max-roles N             Maximum declared roles (default 200)
  --max-data-classes N      Maximum declared data classes (default 200)
  --max-requirements N      Maximum declared requirements (default 400)
  --max-scopes N            Maximum scopes on one tool (default 64)
  --max-class-references N  Maximum data classes named by one tool (default 64)
  --max-role-references N   Maximum roles named by one tool (default 64)
  --max-runtime-ms N        Time budget for the mapping (default 10000)
  --max-findings N          Maximum findings in one report (default 1000)
  -h, --help                Show this help
  -v, --version             Show the version

Every option that carries a value may be given only once: a repeated flag is a
configuration error, not a silent last-wins.

Writing the matrix:
  --out is checked before anything is read and long before anything is written.
  A destination that is a symbolic link is refused unread, a destination that is
  the same file as one of the three inputs -- including through a hard link,
  which shares no path with it -- is refused, and a destination whose parent
  resolves outside --out-root is refused. A refused destination is a
  configuration error: stdout stays empty and the exit code is 2. The matrix is
  written before the report reaches stdout, so a write that fails also leaves
  stdout empty rather than reporting success for an artefact that does not exist.

Output:
  stdout  the JSON report only, so it can be piped straight into a parser
  stderr  the human summary and diagnostics

What a pass means:
  Every declared tool was mapped, every word it used was one this build
  implements, every role and data class it names is declared, a requirement
  governs its capability and sensitivity, its declared approval is at least what
  that requirement asks for, and no scope is broader than the requirement
  allows. It is a statement about three exported documents and nothing else: no
  account was contacted, so a pass never says a provider agrees with them.

Exit codes:
  0  the declarations were mapped and nothing contradicted the policy
  1  they were mapped and at least one error-severity rule fired
  2  invalid configuration or a refused destination (no report on stdout), or
     evidence that could not be obtained (an "incomplete" report on stdout,
     never a "pass")
`

const LIMIT_FLAGS = new Map([
  ['--max-class-references', 'maxClassReferences'],
  ['--max-data-classes', 'maxDataClasses'],
  ['--max-file-bytes', 'maxFileBytes'],
  ['--max-findings', 'maxFindings'],
  ['--max-requirements', 'maxRequirements'],
  ['--max-role-references', 'maxRoleReferences'],
  ['--max-roles', 'maxRoles'],
  ['--max-runtime-ms', 'maxRuntimeMs'],
  ['--max-scopes', 'maxScopes'],
  ['--max-tools', 'maxTools'],
])

const VALUE_FLAGS = new Map([
  ['--out', 'out'],
  ['--out-root', 'outRoot'],
  ['--policy', 'policy'],
  ['--roles', 'roles'],
  ['--root', 'root'],
  ['--tools', 'tools'],
])

function parseArguments(argv) {
  if (argv.includes('-h') || argv.includes('--help')) return { help: true }
  if (argv.includes('-v') || argv.includes('--version')) return { version: true }

  const options = {
    root: null, tools: null, roles: null, policy: null, out: null, outRoot: null, json: false, limits: {},
  }
  const given = new Set()

  /**
   * A flag that carries a value is accepted once.
   *
   * Letting it repeat discards the earlier value with no diagnostic, so
   * `--policy a.json --policy b.json` maps a file nobody named and
   * `--max-tools 5 --max-tools 5000` enforces a bound nobody asked for. That is
   * the same defect as an ignored typo, which this tool also refuses.
   */
  const once = (name) => {
    if (given.has(name)) throw new Error(`${name} was given more than once`)
    given.add(name)
  }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const takeValue = (name) => {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('-')) throw new Error(`${name} requires a value`)
      index += 1
      return value
    }

    if (argument === '--json') options.json = true
    else if (VALUE_FLAGS.has(argument)) {
      once(argument)
      options[VALUE_FLAGS.get(argument)] = takeValue(argument)
    } else if (LIMIT_FLAGS.has(argument)) {
      once(argument)
      const raw = takeValue(argument)
      if (!/^\d+$/.test(raw) || Number(raw) < 1) throw new Error(`${argument} requires a positive integer`)
      options.limits[LIMIT_FLAGS.get(argument)] = Number(raw)
    // argv is the one untrusted string that reaches a stream without passing
    // through a finding, so it is flattened exactly as a finding would be.
    } else throw new Error(`Unknown option "${excerpt(argument, 60)}"`)
  }

  if (options.root === null) throw new Error('--root is required')
  /*
   * Accepted and ignored is how a documented option quietly stops being
   * enforced, so a write root named without a write is a usage error.
   */
  if (options.outRoot !== null && options.out === null) {
    throw new Error('--out-root has no meaning without --out')
  }
  return options
}

async function main(argv) {
  let options
  try {
    options = parseArguments(argv)
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${HELP}`)
    return 2
  }
  if (options.help) {
    process.stdout.write(HELP)
    return 0
  }
  if (options.version) {
    process.stdout.write(`${VERSION}\n`)
    return 0
  }

  const call = {
    root: options.root,
    limits: options.limits,
    ...(options.tools === null ? {} : { tools: options.tools }),
    ...(options.roles === null ? {} : { roles: options.roles }),
    ...(options.policy === null ? {} : { policy: options.policy }),
  }

  /*
   * The destination is checked before anything is read and long before anything
   * is written. `--out` is not a safe place to put an unchecked path: a symlink
   * there, a symlinked directory on the way there, or a hard link to one of the
   * three inputs all destroy a file this tool was never asked to touch, and in
   * this catalog every one of them has done exactly that while the run exited 0
   * reporting success. The input set is every file the run may open, not just
   * the primary one.
   *
   * A refused destination is a configuration error, so stdout stays empty.
   */
  let destination = null
  if (options.out !== null) {
    try {
      destination = await assertWritableDestination(options.out, {
        inputs: plannedInputs(call),
        root: options.outRoot ?? process.cwd(),
        label: '--out',
      })
    } catch (error) {
      if (!(error instanceof DestinationError) && !(error instanceof TypeError)) throw error
      process.stderr.write(`${excerpt(error.message, 400)}\n`)
      return 2
    }
  }

  let report
  try {
    report = await mapAgentPermissions(call)
  } catch (error) {
    // A configuration error never had a subject, so stdout stays empty and a
    // consumer that pipes stdout gets nothing rather than a fabricated report.
    process.stderr.write(`${excerpt(error.message, 400)}\n`)
    return 2
  }

  if (destination !== null) {
    try {
      await writeFile(destination, `${serializeMatrix(report)}\n`)
    } catch (error) {
      // Written before the report reaches stdout, so a failed write cannot be
      // read as a success that produced an artefact nobody has.
      process.stderr.write(`--out could not be written: ${error.code ?? 'unknown error'}\n`)
      return 2
    }
  }

  process.stdout.write(`${serializeReport(report)}\n`)
  if (!options.json) process.stderr.write(formatReport(report))
  if (report.status === 'incomplete') {
    process.stderr.write(
      `incomplete: ${report.summary.checked} of ${report.summary.tools} declared tool(s) were mapped and`
      + ` ${report.summary.undecided} could not be decided; this run is not a pass.\n`,
    )
  }
  return exitCodeFor(report)
}

process.exitCode = await main(process.argv.slice(2))

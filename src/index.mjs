/**
 * agent-permission-map -- read three exported declarations and map what each
 * agent tool may do, to what, on whose behalf, and under which approval.
 *
 * ## What this tool does not do
 *
 * It modifies no account, no grant and no policy. It calls no provider, opens
 * no socket and holds no credential. Its entire output is a report on stdout
 * and, when `--out` is given, one matrix document at a path the caller named
 * and this tool checked first. A row in that matrix is a statement about three
 * exported documents, never about a live system: a tool declared with a narrow
 * scope here may still hold a wide grant in the account it was exported from,
 * and this tool has no way to know that and does not claim to.
 *
 * ## Unknown is never a pass
 *
 * A data class nobody declared, a role nobody declared, a scope that could not
 * be measured, a capability outside the ladder, or a capability and sensitivity
 * pair no requirement governs, all produce an `undecided` row and an entry in
 * the assumption list, and any one of them makes the run `incomplete` and the
 * exit code 2. None of them is ever rounded to "within policy", because the
 * permissive reading of an absent declaration is precisely the reading that
 * turns an unreviewed permission into a green build.
 *
 * ## Two properties pinned by behaviour rather than by declaration
 *
 * - **Order is by code unit.** Tool ids, role ids and scope patterns carry
 *   upper case, `-`, `_`, `.`, `/` and `*`, all of which collate differently
 *   from their code points.
 * - **Severity comes from one frozen table** in `rules.mjs`, pinned by process
 *   exit code rather than by comparing the table against a copy of itself.
 */

import { readFile, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, normalize, resolve, sep } from 'node:path'
import { performance } from 'node:perf_hooks'

import { compilePolicy, compileRoles, compileTools } from './documents.mjs'
import { buildMatrix, createMatrix, downgradeRows } from './matrix.mjs'
import { parseFailureDetail } from './parse-failure.mjs'
import { RULE_SEVERITY, severityOf } from './rules.mjs'
import {
  LOCATION_LIMIT, byCodeUnit, decodeUtf8, excerpt, hasForbiddenCharacter, isPlainObject, locationText,
} from './text.mjs'

export const TOOL_ID = 'agent-permission-map'
export const REPORT_SCHEMA_VERSION = '1'

export const DEFAULT_TOOLS_NAME = 'tools.json'
export const DEFAULT_ROLES_NAME = 'roles.json'
export const DEFAULT_POLICY_NAME = 'policy.json'

/** The three documents, in the fixed order every loop over them uses. */
const KINDS = Object.freeze(['policy', 'roles', 'tools'])

/**
 * Limits, each enforced and each reported by name when it is reached.
 *
 * Exceeding one is never a silent truncation: it produces a finding naming the
 * limit and marks the run `incomplete`, because a partial walk is not evidence
 * about the part nobody walked. There is no recursion limit because the input
 * has no recursive shape -- the deepest structure this tool reads is an array
 * of objects holding arrays of strings, and each of those is bounded by name.
 */
export const DEFAULT_LIMITS = Object.freeze({
  maxClassReferences: 64,
  maxDataClasses: 200,
  maxFileBytes: 5242880,
  maxFindings: 1000,
  maxRequirements: 400,
  maxRoleReferences: 64,
  maxRoles: 200,
  maxRuntimeMs: 10000,
  maxScopes: 64,
  maxTools: 500,
})

/** A caller may lower a limit, never raise it past these caps. */
export const HARD_LIMITS = Object.freeze({
  maxClassReferences: 1024,
  maxDataClasses: 5000,
  maxFileBytes: 67108864,
  maxFindings: 20000,
  maxRequirements: 5000,
  maxRoleReferences: 1024,
  maxRoles: 5000,
  maxRuntimeMs: 600000,
  maxScopes: 1024,
  maxTools: 20000,
})

const MESSAGE_LIMIT = 400
const SUGGESTION_LIMIT = 300
const MAX_NAME_LENGTH = 200
const ASSUMPTION_LIMIT = 300

const ALLOWED_OPTIONS = Object.freeze(['clock', 'limits', 'policy', 'roles', 'root', 'tools'])

/** Raised when the run passes its time budget; turned into a finding by the caller. */
class TimeBudgetExceeded extends Error {}

/**
 * Validate limit overrides.
 *
 * An unknown key throws rather than being ignored. A documented limit that a
 * typo silently disables is a limit that is not enforced, and the CLI turns
 * this throw into a configuration error with an empty stdout.
 */
export function validateLimits(overrides = {}) {
  if (!isPlainObject(overrides)) throw new TypeError('limits must be an object')
  const limits = { ...DEFAULT_LIMITS }
  for (const key of Object.keys(overrides).sort(byCodeUnit)) {
    if (!Object.hasOwn(DEFAULT_LIMITS, key)) {
      throw new TypeError(
        `Unknown limit "${excerpt(key, 60)}"; known limits are ${Object.keys(DEFAULT_LIMITS).sort(byCodeUnit).join(', ')}`,
      )
    }
    const value = overrides[key]
    const cap = HARD_LIMITS[key]
    if (!Number.isInteger(value) || value < 1 || value > cap) {
      throw new TypeError(`limits.${key} must be an integer between 1 and ${cap}`)
    }
    limits[key] = value
  }
  return Object.freeze(limits)
}

/**
 * True when `candidate` is the real root itself or lies beneath it.
 *
 * Both sides must already be real paths. Comparing a real root against an
 * unresolved path refuses legitimate files whenever the root is reached through
 * a symbolic link -- a `/var` that is really `/private/var` is enough -- and a
 * false refusal is a defect too.
 */
export function isInside(root, candidate) {
  return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : root + sep)
}

/**
 * A file name given on the command line, checked as configuration.
 *
 * Absolute paths and `..` segments are refused here, before any evidence is
 * gathered, because naming a file outside the declared root is a usage error
 * rather than a fact about the subject. This is emphatically *not* the
 * confinement: a symbolic link planted inside the root passes every check in
 * this function, and `resolveInput` is what catches it by resolving the real
 * path of both sides.
 */
function validateName(name, flag) {
  if (typeof name !== 'string' || name.length === 0 || name.length > MAX_NAME_LENGTH) {
    throw new TypeError(`${flag} must be a relative file name of 1-${MAX_NAME_LENGTH} characters`)
  }
  if (hasForbiddenCharacter(name)) {
    throw new TypeError(`${flag} must not contain a control, separator or bidi character`)
  }
  if (isAbsolute(name)) throw new TypeError(`${flag} must be relative to --root, not an absolute path`)
  if (normalize(name).split(/[\\/]/).includes('..')) throw new TypeError(`${flag} must not step outside --root with ".."`)
  return name
}

/**
 * Every file a run over these options may open.
 *
 * Exported because the write guard needs it: a destination that is a hard link
 * to an input is the same file as that input, and only device plus inode sees
 * that. A sibling tool passed only its primary input to the guard and destroyed
 * every other file it read, so the set is built in one place and the CLI takes
 * all of it rather than choosing a member.
 */
export function plannedInputs(options = {}) {
  if (!isPlainObject(options)) throw new TypeError('options must be an object')
  if (typeof options.root !== 'string' || options.root.length === 0) throw new TypeError('root must be a non-empty string')
  return [
    resolve(options.root, validateName(options.policy ?? DEFAULT_POLICY_NAME, '--policy')),
    resolve(options.root, validateName(options.roles ?? DEFAULT_ROLES_NAME, '--roles')),
    resolve(options.root, validateName(options.tools ?? DEFAULT_TOOLS_NAME, '--tools')),
  ]
}

class FindingSink {
  constructor() {
    this.rows = []
  }

  add(row) {
    this.rows.push({ pointer: '', ...row })
  }
}

/**
 * Build a finding, taking its severity from the one table.
 *
 * Every untrusted string is sanitised here -- file, pointer, message,
 * suggestion and evidence alike, not only the evidence field. A sibling tool
 * sanitised its evidence carefully and left identifiers raw, so a record id
 * holding a newline forged an extra line in the human report.
 */
export function createFinding(row) {
  const finding = {
    ruleId: row.ruleId,
    severity: severityOf(row.ruleId),
    message: excerpt(row.message, MESSAGE_LIMIT),
    location: { file: locationText(row.file, LOCATION_LIMIT), pointer: locationText(row.pointer, LOCATION_LIMIT) },
  }
  if (row.evidence !== undefined && row.evidence !== '') finding.evidence = excerpt(row.evidence)
  if (row.suggestion !== undefined) finding.suggestion = excerpt(row.suggestion, SUGGESTION_LIMIT)
  return finding
}

/**
 * The documented sort key: `location.file`, `location.pointer`, `ruleId`,
 * `message`.
 *
 * The message is part of the key because several rules deliberately anchor more
 * than one finding at the same pointer -- a tool naming two unknown data
 * classes, for one. No two findings share all four components, and `sort` is
 * stable, so even a tie would preserve emission order, which is itself fixed by
 * the documents.
 */
export function compareFindings(left, right) {
  return (
    byCodeUnit(left.location.file, right.location.file) ||
    byCodeUnit(left.location.pointer, right.location.pointer) ||
    byCodeUnit(left.ruleId, right.ruleId) ||
    byCodeUnit(left.message, right.message)
  )
}

function buildReport(sink, state, limits) {
  let findings = sink.rows.map((row) => createFinding(row)).sort(compareFindings)
  let truncated = false

  if (findings.length > limits.maxFindings) {
    const dropped = findings.length - limits.maxFindings + 1
    findings = findings.slice(0, limits.maxFindings - 1)
    findings.push(createFinding({
      file: state.files.tools,
      ruleId: 'too-many-findings',
      pointer: '',
      message: `The run produced more findings than the maxFindings limit of ${limits.maxFindings}; ${dropped} were not reported and this report is partial.`,
      suggestion: 'Raise --max-findings, or map fewer declarations at a time.',
    }))
    findings.sort(compareFindings)
    truncated = true
  }

  let errors = 0
  let warnings = 0
  for (const finding of findings) {
    if (finding.severity === 'error') errors += 1
    else if (finding.severity === 'warning') warnings += 1
  }

  const matrix = createMatrix(state.version, state.rows, state.assumptions)
  const status = state.incomplete || truncated ? 'incomplete' : errors > 0 ? 'fail' : 'pass'

  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    tool: TOOL_ID,
    status,
    summary: {
      checked: state.rows.length,
      errors,
      warnings,
      tools: state.tools,
      roles: state.roles,
      dataClasses: state.dataClasses,
      requirements: state.requirements,
      withinPolicy: state.counts.withinPolicy,
      outsidePolicy: state.counts.outsidePolicy,
      undecided: state.counts.undecided,
      overbroadScopes: state.counts.overbroadScopes,
      assumptions: state.assumptions.length,
    },
    matrix,
    findings,
  }
}

/**
 * Resolve one declared input inside the declared root.
 *
 * Both sides are resolved to their real paths before they are compared.
 * Rejecting `..` lexically -- which `validateName` also does -- is not
 * confinement: a symbolic link planted inside the root points anywhere and
 * contains no `..` at all. Equally, comparing a real root against an unresolved
 * target refuses legitimate files, so the root is resolved too.
 */
async function resolveInput(realRoot, name) {
  const target = resolve(realRoot, name)
  try {
    const real = await realpath(target)
    if (!isInside(realRoot, real)) return { ok: false, reason: 'escapes' }
    return { ok: true, real }
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ELOOP') return { ok: false, reason: 'unreadable', code: error.code }
    // The entry may exist as a link that resolves nowhere. Confine the nearest
    // existing ancestor first, so a symlinked parent directory cannot decide
    // where a "missing" file would have been read from.
    try {
      const realParent = await realpath(dirname(target))
      if (!isInside(realRoot, realParent)) return { ok: false, reason: 'escapes' }
    } catch {
      return { ok: false, reason: 'unreadable', code: error.code }
    }
    return { ok: false, reason: 'unreadable', code: error.code }
  }
}

/** Read one confined input and turn it into parsed JSON, or into the finding that says why not. */
async function loadJson(sink, file, real, limits) {
  let info
  try {
    info = await stat(real)
  } catch (error) {
    sink.add({ file, ruleId: 'input-unreadable', message: `${file} could not be inspected: ${error.code ?? 'unknown error'}.` })
    return null
  }
  if (!info.isFile()) {
    sink.add({ file, ruleId: 'input-unreadable', message: `${file} is not a regular file, so nothing was read from it.` })
    return null
  }
  if (info.size > limits.maxFileBytes) {
    sink.add({
      file,
      ruleId: 'input-too-large',
      message: `${file} is ${info.size} bytes, above the maxFileBytes limit of ${limits.maxFileBytes}; it was not read.`,
      suggestion: 'Raise --max-file-bytes, or split the input.',
    })
    return null
  }
  let bytes
  try {
    bytes = await readFile(real)
  } catch (error) {
    sink.add({ file, ruleId: 'input-unreadable', message: `${file} could not be read: ${error.code ?? 'unknown error'}.` })
    return null
  }
  const decoded = decodeUtf8(bytes)
  if (!decoded.ok) {
    sink.add({
      file,
      ruleId: 'input-not-utf8',
      message: `${file} is not valid UTF-8, so it was not parsed. Whether a file decodes is the decoder's decision, never an inference drawn from the decoded text.`,
      suggestion: 'Re-encode the file as UTF-8.',
    })
    return null
  }
  try {
    return { value: JSON.parse(decoded.text) }
  } catch (error) {
    sink.add({
      file,
      ruleId: 'input-not-json',
      message: `${file} is not valid JSON: ${parseFailureDetail(error)}`,
      suggestion: 'Validate the file with a JSON parser before re-running.',
    })
    return null
  }
}

const COMPILERS = Object.freeze({
  policy: compilePolicy,
  roles: compileRoles,
  tools: compileTools,
})

function emptyState(files) {
  return {
    files,
    rows: [],
    assumptions: [],
    counts: { withinPolicy: 0, outsidePolicy: 0, undecided: 0, overbroadScopes: 0 },
    tools: 0,
    roles: 0,
    dataClasses: 0,
    requirements: 0,
    version: null,
    incomplete: false,
  }
}

/**
 * Map a set of exported agent permission declarations.
 *
 * @param {object} options
 * @param {string} options.root Directory holding the three documents.
 * @param {string} [options.tools] Tool declarations, relative to the root.
 * @param {string} [options.roles] Role declarations, relative to the root.
 * @param {string} [options.policy] Approval policy, relative to the root.
 * @param {object} [options.limits] Limit overrides; an unknown key throws.
 * @param {Function} [options.clock] Monotonic millisecond source for the time
 *   budget. Injected so a test can drive the budget without waiting, and so
 *   that nothing in this package reads a wall clock: no date, host or run id
 *   reaches the report, which is what lets two runs over one input produce
 *   byte-identical stdout.
 * @returns {Promise<object>} the report.
 */
export async function mapAgentPermissions(options = {}) {
  if (!isPlainObject(options)) throw new TypeError('options must be an object')
  for (const key of Object.keys(options).sort(byCodeUnit)) {
    if (!ALLOWED_OPTIONS.includes(key)) {
      throw new TypeError(`Unknown option "${excerpt(key, 60)}"; known options are ${ALLOWED_OPTIONS.join(', ')}`)
    }
  }
  const limits = validateLimits(options.limits ?? {})
  if (typeof options.root !== 'string' || options.root.length === 0) throw new TypeError('root must be a non-empty string')
  if (options.clock !== undefined && typeof options.clock !== 'function') {
    throw new TypeError('clock must be a function returning milliseconds')
  }

  const names = {
    policy: validateName(options.policy ?? DEFAULT_POLICY_NAME, '--policy'),
    roles: validateName(options.roles ?? DEFAULT_ROLES_NAME, '--roles'),
    tools: validateName(options.tools ?? DEFAULT_TOOLS_NAME, '--tools'),
  }

  let realRoot
  try {
    realRoot = await realpath(options.root)
  } catch (error) {
    throw new Error(`--root could not be resolved: ${error.code ?? 'unknown error'}`)
  }
  let rootInfo
  try {
    rootInfo = await stat(realRoot)
  } catch (error) {
    throw new Error(`--root could not be inspected: ${error.code ?? 'unknown error'}`)
  }
  if (!rootInfo.isDirectory()) throw new Error('--root must be a directory')

  const clock = options.clock ?? (() => performance.now())
  const started = clock()
  const budget = {
    check() {
      if (clock() - started > limits.maxRuntimeMs) throw new TimeBudgetExceeded()
    },
  }

  const sink = new FindingSink()
  const state = emptyState(names)

  const parsed = {}
  for (const kind of KINDS) {
    const name = names[kind]
    const located = await resolveInput(realRoot, name)
    if (!located.ok) {
      // (1) An input that could not be reached is missing evidence, not a
      // verdict about it.
      state.incomplete = true
      if (located.reason === 'escapes') {
        sink.add({
          file: name,
          ruleId: 'path-escapes-root',
          message: `${name} resolves outside --root, so it was refused unread.`,
          suggestion: 'Keep all three documents inside the declared root; a symbolic link out of the tree is refused.',
        })
      } else {
        sink.add({
          file: name,
          ruleId: 'input-unreadable',
          message: `${name} could not be resolved inside --root: ${located.code ?? 'unknown error'}.`,
          suggestion: 'Check the file name and its permissions.',
        })
      }
      parsed[kind] = null
      continue
    }
    const loaded = await loadJson(sink, name, located.real, limits)
    // (2) Unreadable, undecodable or unparseable bytes are missing evidence too.
    if (loaded === null) state.incomplete = true
    parsed[kind] = loaded
  }

  const compiled = {}
  for (const kind of KINDS) {
    if (parsed[kind] === null) {
      compiled[kind] = null
      continue
    }
    const document = COMPILERS[kind](sink, names[kind], parsed[kind].value, limits)
    // (3) A document whose shape, version or size this build cannot take is a
    // document nothing was learned from.
    if (document === null) state.incomplete = true
    compiled[kind] = document
  }

  for (const kind of ['roles', 'tools']) {
    const document = compiled[kind]
    if (document === null) continue
    // (4) An entry that did not compile was never compared against anything, so
    // reporting `fail` would claim the whole document was read when part of it
    // was refused.
    if (document.entries.length !== document.declared) state.incomplete = true
    // (5) A refused reference leaves an entry's reach partly unknown, which is
    // not the same as knowing it is narrow.
    if (document.refusedReferences > 0) state.incomplete = true
  }

  if (compiled.policy !== null) {
    state.version = compiled.policy.version
    state.dataClasses = compiled.policy.classes.entries.length
    state.requirements = compiled.policy.requirements.entries.length
    // (6) An unversioned matrix cannot be compared with the next one, and a
    // refused class or requirement is policy this run did not read.
    if (compiled.policy.version === null) state.incomplete = true
    if (compiled.policy.classes.entries.length !== compiled.policy.classes.declared) state.incomplete = true
    if (compiled.policy.requirements.entries.length !== compiled.policy.requirements.declared) state.incomplete = true
  }
  if (compiled.roles !== null) state.roles = compiled.roles.entries.length
  if (compiled.tools !== null) state.tools = compiled.tools.entries.length

  if (KINDS.every((kind) => compiled[kind] !== null)) {
    let result = null
    let timedOut = false
    try {
      result = buildMatrix(sink, names, compiled, budget)
      /**
       * The re-check after the loop, and the reason this tool has one.
       *
       * A budget that can be exhausted *inside* a loop cannot be trusted to
       * have fired: a tool in this catalog ran out of steps mid-loop, broke,
       * fell through to the success branch and reported a match it had never
       * finished checking. The budget is asked again here, after the loop has
       * returned, and if it has been passed every verdict is withdrawn below.
       */
      budget.check()
    } catch (error) {
      if (!(error instanceof TimeBudgetExceeded)) throw error
      timedOut = true
    }

    if (timedOut) {
      // (7) A run that stopped early mapped less than it was asked to, and
      // whatever it did decide it decided on a partial reading.
      state.incomplete = true
      sink.add({
        file: names.tools,
        ruleId: 'time-budget-exceeded',
        message: `The mapping passed the maxRuntimeMs budget of ${limits.maxRuntimeMs} and stopped; every verdict it had reached has been withdrawn to undecided rather than reported as if the run had finished.`,
        suggestion: 'Raise --max-runtime-ms, or map fewer tools at a time.',
      })
      if (result !== null) downgradeRows(result, 'time-budget-exceeded')
    }

    if (result === null) {
      // (8) A mapping that never ran learned nothing about any tool.
      state.incomplete = true
    } else {
      state.rows = result.rows
      state.assumptions = result.assumptions.map((entry) => ({
        file: locationText(entry.file, LOCATION_LIMIT),
        pointer: locationText(entry.pointer, LOCATION_LIMIT),
        assumption: excerpt(entry.assumption, ASSUMPTION_LIMIT),
      }))
      state.counts = result.counts

      // (9) An undecided row is a tool this run could not finish deciding
      // about. Missing evidence is never a pass.
      if (result.counts.undecided > 0) state.incomplete = true

      /**
       * (10) The vacuous pass, refused explicitly.
       *
       * Three documents that all compile with no tool left to map would
       * otherwise report `pass` with `checked: 0` -- green on no evidence at
       * all. This flag is the only thing between that input and a green build,
       * so it is an error, it marks the run incomplete, and
       * `test/incomplete.test.mjs` fails when either half is removed.
       *
       * Confined to runs that reached the mapping: a run whose documents could
       * not be read has already said so under its own rule, and repeating it
       * here would backstop those flags so that removing one changed nothing.
       */
      if (result.rows.length === 0) {
        state.incomplete = true
        sink.add({
          file: names.tools,
          pointer: '/tools',
          ruleId: 'no-tools-evaluated',
          message: `The run mapped 0 of ${compiled.tools.declared} declared tool(s), so it has no evidence to be green on.`,
          suggestion: 'Declare the tools this policy is meant to govern, and fix whatever stopped the ones that are there from compiling.',
        })
      }
    }
  }

  return buildReport(sink, state, limits)
}

/** stdout carries this and nothing else, so it can be piped straight into a parser. */
export function serializeReport(report) {
  return JSON.stringify(report, null, 2)
}

/** The document `--out` writes: the versioned matrix, alone. */
export function serializeMatrix(report) {
  return JSON.stringify({ tool: TOOL_ID, ...report.matrix }, null, 2)
}

/** 0 completed and passed, 1 completed and failed, 2 the run could not be completed. */
export function exitCodeFor(report) {
  if (report.status === 'incomplete') return 2
  return report.status === 'fail' ? 1 : 0
}

const SEVERITY_WIDTH = 7

/** The human summary. It goes to stderr; stdout is the JSON report alone. */
export function formatReport(report) {
  const { summary, matrix } = report
  const lines = [
    `${summary.checked} of ${summary.tools} declared tool(s) mapped against ${summary.requirements} requirement(s),`
    + ` ${summary.roles} role(s) and ${summary.dataClasses} data class(es).`,
    `${summary.withinPolicy} within policy, ${summary.outsidePolicy} outside it, ${summary.undecided} undecided;`
    + ` ${summary.overbroadScopes} scope finding(s), ${summary.assumptions} unsupported assumption(s). status ${report.status}.`,
    `matrix version ${matrix.version === null ? '(none declared)' : matrix.version} digest ${matrix.digest}`,
    'This tool modifies no account, grant or policy; every line above describes a declaration it read.',
  ]
  for (const entry of matrix.assumptions) {
    lines.push(`ASSUMED ${entry.file}${entry.pointer} ${entry.assumption}`)
  }
  for (const finding of report.findings) {
    lines.push(
      `${finding.severity.toUpperCase().padEnd(SEVERITY_WIDTH)} `
      + `${finding.location.file}${finding.location.pointer} ${finding.ruleId} ${finding.message}`,
    )
  }
  return `${lines.join('\n')}\n`
}

export { RULE_SEVERITY, severityOf }
export { MATRIX_SCHEMA_VERSION, VERDICTS, buildMatrix, createMatrix, downgradeRows } from './matrix.mjs'
export {
  APPROVALS, CAPABILITIES, SENSITIVITIES, UNBOUNDED_SCOPE_POSITIONS, UNBOUNDED_SEGMENT,
  compileScope, rankOf,
} from './vocabulary.mjs'
export {
  DATA_CLASS_KEYS, DOCUMENT_SCHEMA_VERSION, MAX_SCOPE_WILDCARDS, POLICY_DOCUMENT_KEYS,
  REQUIREMENT_KEYS, ROLE_DOCUMENT_KEYS, ROLE_KEYS, TOOL_DOCUMENT_KEYS, TOOL_KEYS,
  compilePolicy, compileRoles, compileTools,
} from './documents.mjs'
export { DestinationError, assertWritableDestination } from './write-guard.mjs'
export { parseFailureDetail } from './parse-failure.mjs'
export {
  EXCERPT_LIMIT, LOCATION_LIMIT, MAX_DESCRIPTION_LENGTH, MAX_IDENTIFIER_LENGTH, MAX_SCOPE_LENGTH,
  byCodeUnit, decodeUtf8, describeValue, excerpt, hasForbiddenCharacter, isIdentifier, isPlainObject,
  locationText, renderable,
} from './text.mjs'

/**
 * The permission matrix: one row per declared tool, and the assumptions the run
 * could not make.
 *
 * ## What a row is, and what it is not
 *
 * A row says what three exported documents declare about one tool: what it can
 * do, to which resources, on which data, for whom, and under what approval --
 * and whether that agrees with the policy those same documents declare. It is a
 * statement about declarations. Nothing here contacts an account, a provider or
 * a registry, so a row is never evidence that the running system matches what
 * was declared, and the README says so in the same words.
 *
 * ## Undecided is a verdict, and it is not a pass
 *
 * A tool whose data class nobody declared, whose scope could not be measured,
 * whose role is unknown, or whose capability and sensitivity pair no
 * requirement governs, is `undecided`. It is never rounded to `within-policy`,
 * and every undecided row makes the run incomplete, because the whole failure
 * mode this tool exists to catch is a broad permission that nobody noticed.
 */

import { createHash } from 'node:crypto'

import { severityOf } from './rules.mjs'
import { byCodeUnit, excerpt } from './text.mjs'
import { APPROVALS, CAPABILITIES, SENSITIVITIES, rankOf } from './vocabulary.mjs'

export const MATRIX_SCHEMA_VERSION = '1'

/** The three verdicts a row can carry. */
export const VERDICTS = Object.freeze(['within-policy', 'outside-policy', 'undecided'])

/** Order two matrix rows, and two assumptions, by their documented keys. */
const byRowId = (left, right) => byCodeUnit(left.id, right.id)
const byAssumption = (left, right) =>
  byCodeUnit(left.file, right.file) || byCodeUnit(left.pointer, right.pointer) || byCodeUnit(left.assumption, right.assumption)

/**
 * Build the matrix.
 *
 * @param {object} sink Finding sink.
 * @param {object} files The input file names, for locations.
 * @param {object} compiled `{tools, roles, policy}`, each already compiled.
 * @param {object} budget `{check()}`, which throws when the time budget is spent.
 * @returns {object} rows, assumptions, counts and the roles nothing grants.
 */
export function buildMatrix(sink, files, compiled, budget) {
  const { tools, roles, policy } = compiled

  const roleById = new Map(roles.entries.map((role) => [role.id, role]))
  const classById = new Map(policy.classes.entries.map((entry) => [entry.id, entry]))
  const requirementByPair = new Map(
    policy.requirements.entries.map((entry) => [`${entry.capability} ${entry.sensitivity}`, entry]),
  )

  const rows = []
  const assumptions = []
  const rolesReferenced = new Set()
  const counts = { withinPolicy: 0, outsidePolicy: 0, undecided: 0, overbroadScopes: 0 }

  /*
   * True once any entry's `roles` list was read only in part.
   *
   * `role-grants-nothing` asserts that nothing in `tools.json` grants a role.
   * That is an absence, and it cannot be established from a document whose
   * grants were not all read: the reference nobody could read may be the very
   * one that granted this role. It is set for a refused entry whose whole list
   * was lost, and for a compiled entry with a refused member in an otherwise
   * good list -- the second is the case that shipped, because the counter that
   * would have caught it was added to the row and never consulted here.
   */
  let grantsPartlyUnknown = false

  const assume = (pointer, assumption) => {
    assumptions.push({ file: files.tools, pointer, assumption })
  }

  for (const tool of tools.entries) {
    budget.check()

    const reasons = new Set()
    let undecided = false

    const fail = (ruleId, pointer, message, suggestion) => {
      reasons.add(ruleId)
      sink.add({ file: files.tools, pointer, ruleId, message, ...(suggestion === undefined ? {} : { suggestion }) })
    }

    /*
     * A reference the compiler refused leaves this tool's reach partly unknown.
     * The finding was raised there; what matters here is that the row does not
     * claim a verdict about a tool whose declaration was only partly read.
     */
    if (tool.dataClassesRefused > 0 || tool.rolesRefused > 0 || tool.scopesRefused > 0) {
      undecided = true
      assume(tool.pointer, 'part of this tool declaration could not be read, so its reach is only partly known')
    }

    /*
     * "Declares none" and "declared some, and none could be read" are different
     * facts, and the second one must never be reported as the first.
     *
     * Both leave the list empty here, and both leave the tool undecided, so it
     * is tempting to answer them with one sentence. That sentence then tells a
     * reviewer an absence -- "this tool declares no resource scope" -- about a
     * declaration that is sitting in the file, which is exactly how a reviewer
     * is told to stop looking for something that is there. This package already
     * splits the same distinction for deletion evidence in its sibling tool;
     * it is split here too.
     */
    let sensitivity = null
    if (tool.dataClasses.length === 0 && tool.dataClassesRefused > 0) {
      undecided = true
      fail(
        'tool-data-classes-unreadable',
        `${tool.pointer}/dataClasses`,
        `Tool "${excerpt(tool.id, 120)}" names ${tool.dataClassesRefused} data class(es) and none of them could be read, so which requirement governs it is unknown. That is not the same as declaring none, and it is not reported as such.`,
        'Correct the refused references; the finding on each one says what was wrong with it.',
      )
      assume(`${tool.pointer}/dataClasses`, 'every data class this tool names was refused, so the sensitivity it handles is unknown')
    } else if (tool.dataClasses.length === 0) {
      undecided = true
      fail(
        'tool-declares-no-data-class',
        `${tool.pointer}/dataClasses`,
        `Tool "${excerpt(tool.id, 120)}" declares no data class, so which requirement governs it is unknown. An empty list is not read as "public data": the least sensitive reading of an absent declaration is exactly the reading that turns an unreviewed permission into a green build.`,
        'Declare every data class this tool can reach, even when that class is public.',
      )
      assume(`${tool.pointer}/dataClasses`, 'no data class is declared, so the sensitivity this tool handles is unknown')
    } else {
      let rank = -1
      for (const id of tool.dataClasses) {
        const entry = classById.get(id)
        if (entry === undefined) {
          undecided = true
          fail(
            'data-class-unknown',
            `${tool.pointer}/dataClasses`,
            `Tool "${excerpt(tool.id, 120)}" names data class "${excerpt(id, 120)}", which ${files.policy} does not declare; its sensitivity is unknown and was not guessed at.`,
            `Declare the class in ${files.policy}, or correct the reference.`,
          )
          assume(`${tool.pointer}/dataClasses`, `data class "${excerpt(id, 120)}" is not declared by the policy, so its sensitivity is unknown`)
          rank = -1
          break
        }
        rank = Math.max(rank, rankOf(SENSITIVITIES, entry.sensitivity))
      }
      if (rank !== -1) sensitivity = SENSITIVITIES[rank]
    }

    if (tool.scopes.length === 0 && tool.scopesRefused > 0) {
      undecided = true
      fail(
        'tool-scopes-unreadable',
        `${tool.pointer}/scopes`,
        `Tool "${excerpt(tool.id, 120)}" declares ${tool.scopesRefused} scope(s) and none of them could be measured, so what it reaches is unknown. That is not the same as declaring none, and it is not reported as such.`,
        'Correct the refused patterns; the finding on each one says what was wrong with it.',
      )
      assume(`${tool.pointer}/scopes`, 'every scope this tool declares was refused, so what it reaches is unknown')
    } else if (tool.scopes.length === 0) {
      undecided = true
      fail(
        'tool-declares-no-scope',
        `${tool.pointer}/scopes`,
        `Tool "${excerpt(tool.id, 120)}" declares no resource scope, so what it reaches is unknown. An empty list is not read as "nothing": a tool that reaches nothing is a tool nobody would declare.`,
        'Declare the resource patterns this tool is allowed to act on.',
      )
      assume(`${tool.pointer}/scopes`, 'no resource scope is declared, so what this tool reaches is unknown')
    }

    /*
     * The same split the two lists above make, for the third list.
     *
     * A refused role reference leaves `roles` empty exactly as an absent one
     * does, and answering both with "granted to no role" tells a reviewer that
     * nothing can run this tool while the grant that would have said otherwise
     * is sitting in the file, refused. It is also the milder sentence of the
     * two: `tool-grants-no-role` is a warning about a dead declaration, so the
     * conflation quietly downgraded an unread grant to a harmless one.
     */
    if (tool.rolesRefused > 0) grantsPartlyUnknown = true
    if (tool.roles.length === 0 && tool.rolesRefused > 0) {
      undecided = true
      fail(
        'tool-roles-unreadable',
        `${tool.pointer}/roles`,
        `Tool "${excerpt(tool.id, 120)}" names ${tool.rolesRefused} role reference(s) and none of them could be read, so which ceilings govern it is unknown. That is not the same as being granted to no role, and it is not reported as such.`,
        'Correct the refused references; the finding on each one says what was wrong with it.',
      )
    } else if (tool.roles.length === 0) {
      fail(
        'tool-grants-no-role',
        `${tool.pointer}/roles`,
        `Tool "${excerpt(tool.id, 120)}" is granted to no role, so nothing declared here can run it. That is a dead declaration rather than a broader permission, which is why it is a warning.`,
        'Grant the tool to the roles that need it, or remove the declaration.',
      )
    }

    const capabilityRank = rankOf(CAPABILITIES, tool.capability)
    for (const id of tool.roles) {
      const role = roleById.get(id)
      if (role === undefined) {
        undecided = true
        fail(
          'role-unknown',
          `${tool.pointer}/roles`,
          `Tool "${excerpt(tool.id, 120)}" is granted to role "${excerpt(id, 120)}", which ${files.roles} does not declare; that role's ceilings are unknown, so this grant was not decided.`,
          `Declare the role in ${files.roles}, or correct the reference.`,
        )
        assume(`${tool.pointer}/roles`, `role "${excerpt(id, 120)}" is not declared, so its capability and sensitivity ceilings are unknown`)
        continue
      }
      rolesReferenced.add(id)

      if (capabilityRank > rankOf(CAPABILITIES, role.maxCapability)) {
        fail(
          'role-capability-exceeded',
          `${tool.pointer}/roles`,
          `Tool "${excerpt(tool.id, 120)}" declares capability "${tool.capability}" and is granted to role "${excerpt(id, 120)}", whose ceiling is "${role.maxCapability}".`,
          'Lower the tool capability, raise the role ceiling deliberately, or withdraw the grant.',
        )
      }
      if (sensitivity !== null && rankOf(SENSITIVITIES, sensitivity) > rankOf(SENSITIVITIES, role.maxSensitivity)) {
        fail(
          'role-sensitivity-exceeded',
          `${tool.pointer}/roles`,
          `Tool "${excerpt(tool.id, 120)}" reaches "${sensitivity}" data and is granted to role "${excerpt(id, 120)}", whose ceiling is "${role.maxSensitivity}".`,
          'Narrow the data classes, raise the role ceiling deliberately, or withdraw the grant.',
        )
      }
    }

    let requiredApproval = null
    if (sensitivity !== null) {
      const pair = `${tool.capability} ${sensitivity}`
      if (policy.requirements.ambiguous.has(pair)) {
        undecided = true
        reasons.add('requirement-duplicate')
        assume(tool.pointer, `two requirements govern ${pair}, so which approval applies is unknown`)
      } else {
        const requirement = requirementByPair.get(pair)
        if (requirement === undefined) {
          undecided = true
          fail(
            'requirement-missing',
            tool.pointer,
            `No requirement in ${files.policy} governs ${tool.capability} on ${sensitivity} data, which is what tool "${excerpt(tool.id, 120)}" declares. The tool was left undecided rather than being read as unrestricted.`,
            `Declare a requirement for ${pair} in ${files.policy}.`,
          )
          assume(tool.pointer, `no requirement governs ${pair}, so the approval and scope breadth this tool must satisfy are unknown`)
        } else {
          requiredApproval = requirement.approval
          if (rankOf(APPROVALS, tool.approval) < rankOf(APPROVALS, requirement.approval)) {
            fail(
              'approval-below-requirement',
              `${tool.pointer}/approval`,
              `Tool "${excerpt(tool.id, 120)}" declares approval "${tool.approval}" for ${pair}, which the policy requires "${requirement.approval}" for.`,
              `Raise the declared approval to "${requirement.approval}", or change the requirement deliberately.`,
            )
          }
          for (const scope of tool.scopes) {
            if (scope.unbounded && requirement.unboundedScope === 'forbidden') {
              counts.overbroadScopes += 1
              fail(
                'scope-unbounded',
                `${tool.pointer}/scopes`,
                `Tool "${excerpt(tool.id, 120)}" declares the unbounded scope "${excerpt(scope.pattern, 120)}" for ${pair}, which the policy forbids: "**" reaches every resource below it, however many there are and whatever is added later.`,
                'Name the resources this tool needs, or declare the wide scope in the policy deliberately.',
              )
            } else if (scope.wildcards > requirement.maxScopeWildcards) {
              counts.overbroadScopes += 1
              fail(
                'scope-too-broad',
                `${tool.pointer}/scopes`,
                `Tool "${excerpt(tool.id, 120)}" declares the scope "${excerpt(scope.pattern, 120)}" with ${scope.wildcards} wildcard segment(s) for ${pair}, above the ${requirement.maxScopeWildcards} the policy allows.`,
                'Narrow the pattern, or raise maxScopeWildcards for this requirement deliberately.',
              )
            }
          }
        }
      }
    }

    /*
     * Only an error-severity rule puts a row outside the policy. A warning is a
     * declaration worth a reader's attention -- a tool nobody is granted, a
     * repeated reference -- and calling that "outside policy" would make the
     * strong word mean nothing. Severity comes from the one table, never from a
     * literal here.
     */
    const hasError = [...reasons].some((ruleId) => severityOf(ruleId) === 'error')
    const verdict = undecided ? 'undecided' : hasError ? 'outside-policy' : 'within-policy'
    if (verdict === 'undecided') counts.undecided += 1
    else if (verdict === 'outside-policy') counts.outsidePolicy += 1
    else counts.withinPolicy += 1

    /*
     * `dataClassesRefused`, `rolesRefused` and `scopesRefused` are on the row
     * because a list that is short says nothing about why. A scope this build
     * could not measure has no breadth to report -- measuring it is exactly
     * what failed -- so it cannot appear among the measured scopes, and a row
     * that simply omitted it told a reviewer the tool reaches less than it
     * declares. The count is the honest form of that: the list is what was
     * measured, and the number beside it says how much was not.
     */
    rows.push({
      id: tool.id,
      capability: tool.capability,
      sensitivity,
      dataClasses: tool.dataClasses,
      dataClassesRefused: tool.dataClassesRefused,
      roles: tool.roles,
      rolesRefused: tool.rolesRefused,
      scopes: tool.scopes.map((scope) => ({
        pattern: scope.pattern,
        segments: scope.segments,
        wildcards: scope.wildcards,
        unbounded: scope.unbounded,
      })),
      scopesRefused: tool.scopesRefused,
      declaredApproval: tool.approval,
      requiredApproval,
      verdict,
      reasons: [...reasons].sort(byCodeUnit),
    })
  }

  /*
   * A declared tool this build could not compile is `undecided`, not absent.
   *
   * It used to be dropped: no row, no assumption, and a summary that counted
   * the survivors. The three documents that say what this tool does -- the
   * README, the rule catalog and the help text -- all promised the opposite,
   * that a word outside a ladder leaves the tool undecided and lists the
   * assumption. Silence is the worst of the three possible answers here,
   * because the matrix a reviewer signs off then shows only tools that agreed
   * with the policy, with nothing saying one was refused.
   *
   * The reasons are the rule ids the compiler already raised about this entry,
   * read back from the sink rather than restated, so the row and the findings
   * cannot disagree.
   */
  for (const entry of tools.refused) {
    assume(entry.pointer, 'this tool declaration could not be read, so nothing it declares was mapped')
    /*
     * A refused tool may still have declared a readable `roles` list, and the
     * roles it named are granted a tool whatever else about it was refused.
     * Without this, refusing one tool made every role only that tool granted
     * look like a role nothing grants -- an absence this run could not have
     * established, asserted as a finding.
     */
    if (entry.roles === null) grantsPartlyUnknown = true
    else for (const id of entry.roles) rolesReferenced.add(id)
    if (entry.id === null) continue
    counts.undecided += 1
    rows.push({
      id: entry.id,
      capability: null,
      sensitivity: null,
      dataClasses: [],
      dataClassesRefused: 0,
      roles: [],
      rolesRefused: 0,
      scopes: [],
      scopesRefused: 0,
      declaredApproval: null,
      requiredApproval: null,
      verdict: 'undecided',
      reasons: [...entry.reasons].sort(byCodeUnit),
    })
  }

  for (const role of roles.entries) {
    if (rolesReferenced.has(role.id)) continue
    // An entry whose `roles` list was itself refused may have granted this
    // role. "Granted no tool" would then be a claim about a list nobody read.
    if (grantsPartlyUnknown) continue
    sink.add({
      file: files.roles,
      pointer: role.pointer,
      ruleId: 'role-grants-nothing',
      message: `Role "${excerpt(role.id, 120)}" is granted no tool by ${files.tools}. Nothing can be run under it, which is worth a reader's attention and is not a wider permission.`,
      suggestion: 'Remove the role, or grant it the tools it exists for.',
    })
  }

  rows.sort(byRowId)
  assumptions.sort(byAssumption)
  return { rows, assumptions, counts }
}

/**
 * The versioned matrix document: what `--out` writes and what the report
 * carries.
 *
 * The digest is a SHA-256 over the serialised body, so two runs over the same
 * declarations produce the same digest and any change to a scope, a role, a
 * verdict or an assumption produces a different one. It is computed from the
 * matrix alone -- no clock, no host, no run id -- which is what makes it usable
 * as the thing a review signs off and a later run is compared against.
 *
 * `status` is in the body, and inside the digest, because the document is
 * written out on its own and read on its own. Without it, `--out` handed a
 * reviewer a signed matrix of `within-policy` rows from a run that had exited
 * 2, with nothing in the artefact saying the audit never completed -- the
 * warning existed only on a stderr line that `--json` suppresses and a
 * consumer reading the file never sees. It is inside the digest rather than
 * beside it so that approving the bytes approves the completeness claim too.
 */
export function createMatrix(status, version, rows, assumptions) {
  const body = {
    schemaVersion: MATRIX_SCHEMA_VERSION,
    status,
    version,
    rows,
    assumptions,
  }
  const digest = createHash('sha256').update(JSON.stringify(body)).digest('hex')
  return { ...body, digest }
}

/**
 * Withdraw every verdict a partial run reached.
 *
 * Called when the time budget is spent. A budget that can run out *inside* the
 * row loop cannot be trusted to have fired before a row was decided: a tool in
 * this catalog ran out mid-loop, broke, fell through to its success branch and
 * reported a match it had never finished checking. So every row becomes
 * `undecided`, the rule that stopped the run is recorded on each of them, and
 * the counts are rebuilt from the rows rather than left saying how many
 * verdicts a finished run would have had.
 */
export function downgradeRows(result, ruleId) {
  for (const row of result.rows) {
    if (row.verdict === 'undecided') continue
    row.verdict = 'undecided'
    row.reasons = [...new Set([...row.reasons, ruleId])].sort(byCodeUnit)
  }
  result.counts.withinPolicy = 0
  result.counts.outsidePolicy = 0
  result.counts.undecided = result.rows.length
}

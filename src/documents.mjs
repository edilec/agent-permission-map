/**
 * The three input documents, compiled from parsed JSON into the shapes the
 * matrix is built from.
 *
 * Everything here is shape and vocabulary: is this an object, does it declare a
 * version this build reads, is every key one of the documented ones, is every
 * id a name rather than something that merely prints as one, is every word on
 * the ladder it has to be on. Nothing here knows whether a scope is too broad
 * or an approval too weak -- those are questions about the three documents
 * together and they are answered in `matrix.mjs`.
 *
 * The supported dialect is small and declared rather than approximated. A word
 * this build does not implement is refused and recorded as an assumption the
 * run could not make. It is never quietly read as the permissive case, which
 * for a permission map is the difference between a cautious answer and one that
 * hands an agent more reach than anybody approved.
 */

import {
  MAX_DESCRIPTION_LENGTH,
  MAX_SCOPE_LENGTH,
  describeValue,
  excerpt,
  isIdentifier,
  isPlainObject,
} from './text.mjs'
import {
  APPROVALS,
  CAPABILITIES,
  SENSITIVITIES,
  UNBOUNDED_SCOPE_POSITIONS,
  compileScope,
  rankOf,
} from './vocabulary.mjs'

/** The only document version this build reads. Anything else is unsupported, not ignored. */
export const DOCUMENT_SCHEMA_VERSION = '1'

export const TOOL_DOCUMENT_KEYS = Object.freeze(['schemaVersion', 'tools'])
export const ROLE_DOCUMENT_KEYS = Object.freeze(['roles', 'schemaVersion'])
export const POLICY_DOCUMENT_KEYS = Object.freeze(['dataClasses', 'requirements', 'schemaVersion', 'version'])

export const TOOL_KEYS = Object.freeze(['approval', 'capability', 'dataClasses', 'description', 'id', 'roles', 'scopes'])
export const ROLE_KEYS = Object.freeze(['description', 'id', 'maxCapability', 'maxSensitivity'])
export const DATA_CLASS_KEYS = Object.freeze(['description', 'id', 'sensitivity'])
export const REQUIREMENT_KEYS = Object.freeze([
  'approval', 'capability', 'description', 'maxScopeWildcards', 'sensitivity', 'unboundedScope',
])

/**
 * The largest `maxScopeWildcards` a requirement may declare.
 *
 * A requirement is policy, not payload, but it still arrives in a file this
 * tool did not write, and a wildcard count of 2^53 is not a policy anybody
 * wrote on purpose. Bounded here rather than clamped: a value above the bound
 * is refused and the requirement is not used.
 */
export const MAX_SCOPE_WILDCARDS = 64

/**
 * The keys of `value` that are not in `allowed`.
 *
 * Counted, never named. A key name is untrusted text from a file this tool did
 * not write, and a sibling tool that named them shipped a credential-shaped key
 * to stdout in full, in a sentence claiming no credential field could reach it.
 * The pointer on the finding and the list of known keys are what a reader
 * needs, and neither comes out of the file.
 */
function unknownKeys(value, allowed) {
  return Object.keys(value).filter((key) => !allowed.includes(key))
}

/** An optional bounded description, or the finding that says why it was refused. */
function checkDescription(sink, file, pointer, raw, ruleId) {
  if (raw.description === undefined) return true
  if (typeof raw.description !== 'string' || raw.description.length > MAX_DESCRIPTION_LENGTH) {
    sink.add({
      file,
      pointer: `${pointer}/description`,
      ruleId,
      message: `"description" must be a string of at most ${MAX_DESCRIPTION_LENGTH} characters; it is ${describeValue(raw.description)}.`,
    })
    return false
  }
  return true
}

/**
 * Open a document: an object, known keys only, a known version.
 *
 * Returns the value or `null`. `null` means nothing at all was compiled from
 * the document -- deliberately, rather than a prefix being read and reported as
 * the whole, because "the first 500 tools were in scope" is not a question
 * anybody asked.
 */
function openDocument(sink, file, value, documentKeys) {
  if (!isPlainObject(value)) {
    sink.add({
      file,
      pointer: '',
      ruleId: 'document-invalid',
      message: `${file} must hold a JSON object; it holds ${describeValue(value)}.`,
    })
    return null
  }
  const stray = unknownKeys(value, documentKeys)
  if (stray.length > 0) {
    sink.add({
      file,
      pointer: '',
      ruleId: 'document-invalid',
      message: `${file} declares ${stray.length} unknown key(s); known keys are ${documentKeys.join(', ')}. An unknown key is refused rather than ignored, so a typo cannot disable a check. The names are counted rather than reproduced.`,
    })
    return null
  }
  if (value.schemaVersion !== DOCUMENT_SCHEMA_VERSION) {
    sink.add({
      file,
      pointer: '/schemaVersion',
      ruleId: 'schema-version-unsupported',
      message: `${file} declares schemaVersion ${describeValue(value.schemaVersion)}; this build implements version "${DOCUMENT_SCHEMA_VERSION}" only and does not guess at another one.`,
      suggestion: `Re-export the document as schemaVersion "${DOCUMENT_SCHEMA_VERSION}".`,
    })
    return null
  }
  return value
}

/** Open one list inside an opened document, bounded by its limit. */
function openList(sink, file, value, spec, limits) {
  const list = value[spec.listKey]
  if (!Array.isArray(list)) {
    sink.add({
      file,
      pointer: `/${spec.listKey}`,
      ruleId: 'document-invalid',
      message: `"${spec.listKey}" must be an array; it is ${describeValue(list)}.`,
    })
    return null
  }
  if (list.length > limits[spec.limitKey]) {
    sink.add({
      file,
      pointer: `/${spec.listKey}`,
      ruleId: spec.limitRule,
      message: `${file} declares ${list.length} ${spec.noun}(s), above the ${spec.limitKey} limit of ${limits[spec.limitKey]}; nothing was compiled from it rather than a prefix being read and reported as the whole.`,
      suggestion: `Raise ${spec.limitFlag}, or split the document.`,
    })
    return null
  }
  return list
}

/** The shared entry gate: an object, known keys only, a usable id, a bounded description. */
function openEntry(sink, file, pointer, raw, spec, byId) {
  if (!isPlainObject(raw)) {
    sink.add({
      file,
      pointer,
      ruleId: spec.invalidRule,
      message: `A ${spec.noun} entry must be an object; this is ${describeValue(raw)}.`,
    })
    return false
  }
  const stray = unknownKeys(raw, spec.entryKeys)
  if (stray.length > 0) {
    sink.add({
      file,
      pointer,
      ruleId: spec.invalidRule,
      message: `This ${spec.noun} declares ${stray.length} unknown key(s); known keys are ${spec.entryKeys.join(', ')}. Nothing outside that list is read -- not the value and not the name either -- which is why no secret, token or account field can reach this tool by accident.`,
    })
    return false
  }
  if (!checkDescription(sink, file, pointer, raw, spec.invalidRule)) return false
  if (!spec.hasId) return true

  if (!isIdentifier(raw.id)) {
    sink.add({
      file,
      pointer: `${pointer}/id`,
      ruleId: 'identifier-invalid',
      message: `This ${spec.noun} has no usable id; it is ${describeValue(raw.id)}.`,
      suggestion: 'An id is 1-120 characters from [A-Za-z0-9._:/+-], starting with a letter or digit.',
    })
    return false
  }
  if (byId.has(raw.id)) {
    sink.add({
      file,
      pointer: `${pointer}/id`,
      ruleId: spec.duplicateRule,
      message: `${spec.noun} id "${excerpt(raw.id, 120)}" is declared twice, at ${byId.get(raw.id)} and here; neither copy is authoritative, so this one was refused.`,
    })
    return false
  }
  /*
   * The id is claimed here rather than after the entry compiles, because the
   * question the duplicate rule asks is whether two entries declare the same
   * id -- which they do whether or not the first of them went on to compile.
   * Claiming it late also let a refused entry and a later good one both carry
   * the same id, and one of the two is now a matrix row.
   */
  byId.set(raw.id, pointer)
  return true
}

/** One word, checked against one closed ladder. */
function readWord(sink, file, pointer, field, raw, ladder, ruleId, noun) {
  const value = raw[field]
  if (rankOf(ladder, value) === -1) {
    sink.add({
      file,
      pointer: `${pointer}/${field}`,
      ruleId,
      message: `"${field}" must be one of ${ladder.join(', ')}; it is ${describeValue(value)}. This build refuses a ${noun} it does not implement rather than mapping it onto the nearest word, because the nearest word is always the permissive one.`,
      suggestion: `Re-export the declaration using one of ${ladder.join(', ')}.`,
    })
    return null
  }
  return value
}

/**
 * A list of references to entries in another document -- the roles that may run
 * a tool, the data classes it touches.
 *
 * A member that is not a name is refused and counted: a tool whose reach is
 * partly unreadable has a reach this run does not know, which is not the same
 * as knowing it is narrow. The count travels back to the caller and makes the
 * run incomplete.
 */
function readReferences(sink, file, pointer, field, raw, spec, limits) {
  const list = raw[field]
  if (!Array.isArray(list)) {
    sink.add({
      file,
      pointer: `${pointer}/${field}`,
      ruleId: spec.invalidRule,
      message: `"${field}" must be an array of ${spec.noun} ids; it is ${describeValue(list)}. An omitted list is not read as "none": this tool never infers reach from an absent field.`,
    })
    return null
  }
  if (list.length > limits[spec.limitKey]) {
    sink.add({
      file,
      pointer: `${pointer}/${field}`,
      ruleId: spec.limitRule,
      message: `This entry names ${list.length} ${spec.noun}(s), above the ${spec.limitKey} limit of ${limits[spec.limitKey]}; none of them were read.`,
      suggestion: `Raise ${spec.limitFlag}, or split the entry.`,
    })
    return null
  }

  const seen = new Set()
  const values = []
  let refused = 0
  for (let index = 0; index < list.length; index += 1) {
    const member = list[index]
    if (!isIdentifier(member)) {
      refused += 1
      sink.add({
        file,
        pointer: `${pointer}/${field}/${index}`,
        ruleId: spec.referenceRule,
        message: `This ${spec.noun} reference is not a usable id; it is ${describeValue(member)}. It was refused, so what this entry reaches is only partly known.`,
      })
      continue
    }
    if (seen.has(member)) {
      sink.add({
        file,
        pointer: `${pointer}/${field}/${index}`,
        ruleId: spec.duplicateRule,
        message: `${spec.noun} "${excerpt(member, 120)}" is named twice in this list; the repeat changes nothing and was dropped.`,
      })
      continue
    }
    seen.add(member)
    values.push(member)
  }
  return { values, refused }
}

/**
 * Why a scope was refused, said without reproducing the pattern.
 *
 * A scope is arbitrary text from a file this tool did not write. The pointer on
 * the finding says exactly where to read it, which is what a reviewer needs,
 * and the report never carries a pattern the tool would not compare.
 */
const SCOPE_REASONS = Object.freeze({
  alphabet: 'declares a character outside [A-Za-z0-9._:/+*@-]',
  empty: 'is an empty string',
  'empty-segment': 'has an empty path segment, from a doubled or trailing "/"',
  'forbidden-character': 'carries a control, separator or bidi character',
  'partial-unbounded': 'mixes "**" with other text in one segment, which this build does not implement',
  shape: 'is not a string',
  'too-long': `is longer than the ${MAX_SCOPE_LENGTH} character scope limit`,
})

/** The scopes of one tool, each measured, with the refused ones counted. */
function readScopes(sink, file, pointer, raw, limits) {
  const list = raw.scopes
  if (!Array.isArray(list)) {
    sink.add({
      file,
      pointer: `${pointer}/scopes`,
      ruleId: 'tool-invalid',
      message: `"scopes" must be an array of resource patterns; it is ${describeValue(list)}. An omitted list is not read as "no access": this tool never infers reach from an absent field.`,
    })
    return null
  }
  if (list.length > limits.maxScopes) {
    sink.add({
      file,
      pointer: `${pointer}/scopes`,
      ruleId: 'too-many-scopes',
      message: `This tool declares ${list.length} scope(s), above the maxScopes limit of ${limits.maxScopes}; none of them were read.`,
      suggestion: 'Raise --max-scopes, or split the tool declaration.',
    })
    return null
  }

  const seen = new Set()
  const scopes = []
  let refused = 0
  for (let index = 0; index < list.length; index += 1) {
    const result = compileScope(list[index])
    if (!result.ok) {
      refused += 1
      sink.add({
        file,
        pointer: `${pointer}/scopes/${index}`,
        ruleId: 'scope-invalid',
        message: `This scope ${SCOPE_REASONS[result.reason]}, so its breadth was not measured and what this tool reaches is only partly known. The pattern is described rather than reproduced; the pointer says where to read it.`,
      })
      continue
    }
    if (seen.has(result.scope.pattern)) {
      sink.add({
        file,
        pointer: `${pointer}/scopes/${index}`,
        ruleId: 'scope-duplicate',
        message: `Scope "${excerpt(result.scope.pattern, 120)}" is declared twice by this tool; the repeat reaches nothing the first does not and was dropped.`,
      })
      continue
    }
    seen.add(result.scope.pattern)
    scopes.push(result.scope)
  }
  scopes.sort((left, right) => (left.pattern === right.pattern ? 0 : left.pattern < right.pattern ? -1 : 1))
  return { scopes, refused }
}

/**
 * Compile `tools.json`.
 *
 * `refused` is the other half of the answer and is not optional. A tool whose
 * capability is a word outside the ladder used to be dropped here and never
 * mentioned again: no matrix row, no assumption, and a human summary that
 * counted the survivors and reported "2 of 2 declared tool(s) mapped" over a
 * document declaring three. Every declared tool now leaves a trace, so the
 * caller can say `undecided` about the ones this build could not read -- which
 * is what the README, the rule catalog and the help text all already promised.
 *
 * `id` on a refused entry is the id it declared, or `null` when it declared
 * none this build can use, or when another entry had already claimed it. A row
 * has to be nameable to exist, so an unnameable refusal reaches the matrix as
 * an assumption alone.
 *
 * @returns {{declared: number, entries: Array<object>, refused: Array<object>, refusedReferences: number}|null}
 */
export function compileTools(sink, file, value, limits) {
  const document = openDocument(sink, file, value, TOOL_DOCUMENT_KEYS)
  if (document === null) return null
  const list = openList(sink, file, document, {
    listKey: 'tools',
    limitKey: 'maxTools',
    limitRule: 'too-many-tools',
    limitFlag: '--max-tools',
    noun: 'tool',
  }, limits)
  if (list === null) return null

  const spec = {
    noun: 'tool',
    entryKeys: TOOL_KEYS,
    invalidRule: 'tool-invalid',
    duplicateRule: 'tool-duplicate',
    hasId: true,
  }
  const byId = new Map()
  const entries = []
  const refused = []
  let refusedReferences = 0

  for (let index = 0; index < list.length; index += 1) {
    const pointer = `/tools/${index}`
    const raw = list[index]
    const mark = sink.mark()
    const claimed = byId.size
    if (!openEntry(sink, file, pointer, raw, spec, byId)) {
      // `byId` grew only if this entry claimed an id, which is exactly when
      // the refusal is nameable.
      refused.push({ pointer, id: byId.size > claimed ? raw.id : null, roles: null, reasons: sink.rulesSince(mark) })
      continue
    }

    const capability = readWord(sink, file, pointer, 'capability', raw, CAPABILITIES, 'capability-unsupported', 'capability')
    const approval = readWord(sink, file, pointer, 'approval', raw, APPROVALS, 'approval-unsupported', 'approval condition')
    const roles = readReferences(sink, file, pointer, 'roles', raw, {
      noun: 'role',
      limitKey: 'maxRoleReferences',
      limitRule: 'too-many-role-references',
      limitFlag: '--max-role-references',
      invalidRule: 'tool-invalid',
      referenceRule: 'role-reference-invalid',
      duplicateRule: 'role-reference-duplicate',
    }, limits)
    const dataClasses = readReferences(sink, file, pointer, 'dataClasses', raw, {
      noun: 'data class',
      limitKey: 'maxClassReferences',
      limitRule: 'too-many-class-references',
      limitFlag: '--max-class-references',
      invalidRule: 'tool-invalid',
      referenceRule: 'class-reference-invalid',
      duplicateRule: 'class-reference-duplicate',
    }, limits)
    const scopes = readScopes(sink, file, pointer, raw, limits)

    // Every field is checked before the entry is dropped, so one export gets
    // every diagnostic about it in one run instead of one per re-run.
    if (capability === null || approval === null || roles === null || dataClasses === null || scopes === null) {
      refused.push({ pointer, id: raw.id, roles: roles === null ? null : roles.values, reasons: sink.rulesSince(mark) })
      continue
    }

    refusedReferences += roles.refused + dataClasses.refused + scopes.refused
    entries.push({
      id: raw.id,
      pointer,
      capability,
      approval,
      roles: [...roles.values].sort((left, right) => (left === right ? 0 : left < right ? -1 : 1)),
      dataClasses: [...dataClasses.values].sort((left, right) => (left === right ? 0 : left < right ? -1 : 1)),
      scopes: scopes.scopes,
      scopesRefused: scopes.refused,
      rolesRefused: roles.refused,
      dataClassesRefused: dataClasses.refused,
    })
  }

  entries.sort((left, right) => (left.id === right.id ? 0 : left.id < right.id ? -1 : 1))
  return { declared: list.length, entries, refused, refusedReferences }
}

/**
 * Compile `roles.json`.
 *
 * @returns {{declared: number, entries: Array<object>, refusedReferences: number}|null}
 */
export function compileRoles(sink, file, value, limits) {
  const document = openDocument(sink, file, value, ROLE_DOCUMENT_KEYS)
  if (document === null) return null
  const list = openList(sink, file, document, {
    listKey: 'roles',
    limitKey: 'maxRoles',
    limitRule: 'too-many-roles',
    limitFlag: '--max-roles',
    noun: 'role',
  }, limits)
  if (list === null) return null

  const spec = {
    noun: 'role',
    entryKeys: ROLE_KEYS,
    invalidRule: 'role-invalid',
    duplicateRule: 'role-duplicate',
    hasId: true,
  }
  const byId = new Map()
  const entries = []

  for (let index = 0; index < list.length; index += 1) {
    const pointer = `/roles/${index}`
    const raw = list[index]
    if (!openEntry(sink, file, pointer, raw, spec, byId)) continue

    const maxCapability = readWord(sink, file, pointer, 'maxCapability', raw, CAPABILITIES, 'capability-unsupported', 'capability')
    const maxSensitivity = readWord(sink, file, pointer, 'maxSensitivity', raw, SENSITIVITIES, 'sensitivity-unsupported', 'sensitivity')
    if (maxCapability === null || maxSensitivity === null) continue

    entries.push({ id: raw.id, pointer, maxCapability, maxSensitivity })
  }

  entries.sort((left, right) => (left.id === right.id ? 0 : left.id < right.id ? -1 : 1))
  return { declared: list.length, entries, refusedReferences: 0 }
}

/** One data class from `policy.json`. */
function compileDataClasses(sink, file, document, limits) {
  const list = openList(sink, file, document, {
    listKey: 'dataClasses',
    limitKey: 'maxDataClasses',
    limitRule: 'too-many-data-classes',
    limitFlag: '--max-data-classes',
    noun: 'data class',
  }, limits)
  if (list === null) return null

  const spec = {
    noun: 'data class',
    entryKeys: DATA_CLASS_KEYS,
    invalidRule: 'data-class-invalid',
    duplicateRule: 'data-class-duplicate',
    hasId: true,
  }
  const byId = new Map()
  const entries = []

  for (let index = 0; index < list.length; index += 1) {
    const pointer = `/dataClasses/${index}`
    const raw = list[index]
    if (!openEntry(sink, file, pointer, raw, spec, byId)) continue
    const sensitivity = readWord(sink, file, pointer, 'sensitivity', raw, SENSITIVITIES, 'sensitivity-unsupported', 'sensitivity')
    if (sensitivity === null) continue
    entries.push({ id: raw.id, pointer, sensitivity })
  }

  entries.sort((left, right) => (left.id === right.id ? 0 : left.id < right.id ? -1 : 1))
  return { declared: list.length, entries }
}

/** One approval requirement, keyed by the exact capability and sensitivity pair it governs. */
function compileRequirements(sink, file, document, limits) {
  const list = openList(sink, file, document, {
    listKey: 'requirements',
    limitKey: 'maxRequirements',
    limitRule: 'too-many-requirements',
    limitFlag: '--max-requirements',
    noun: 'requirement',
  }, limits)
  if (list === null) return null

  const spec = {
    noun: 'requirement',
    entryKeys: REQUIREMENT_KEYS,
    invalidRule: 'requirement-invalid',
    duplicateRule: 'requirement-duplicate',
    hasId: false,
  }
  const byPair = new Map()
  const entries = []
  const ambiguous = new Set()

  for (let index = 0; index < list.length; index += 1) {
    const pointer = `/requirements/${index}`
    const raw = list[index]
    if (!openEntry(sink, file, pointer, raw, spec, byPair)) continue

    const capability = readWord(sink, file, pointer, 'capability', raw, CAPABILITIES, 'capability-unsupported', 'capability')
    const sensitivity = readWord(sink, file, pointer, 'sensitivity', raw, SENSITIVITIES, 'sensitivity-unsupported', 'sensitivity')
    const approval = readWord(sink, file, pointer, 'approval', raw, APPROVALS, 'approval-unsupported', 'approval condition')
    const unboundedScope = readWord(sink, file, pointer, 'unboundedScope', raw, UNBOUNDED_SCOPE_POSITIONS, 'requirement-invalid', 'position on unbounded scopes')

    let wildcards = null
    if (!Number.isInteger(raw.maxScopeWildcards) || raw.maxScopeWildcards < 0 || raw.maxScopeWildcards > MAX_SCOPE_WILDCARDS) {
      sink.add({
        file,
        pointer: `${pointer}/maxScopeWildcards`,
        ruleId: 'requirement-invalid',
        message: `"maxScopeWildcards" must be an integer between 0 and ${MAX_SCOPE_WILDCARDS}; it is ${describeValue(raw.maxScopeWildcards)}. It was refused rather than clamped.`,
      })
    } else {
      wildcards = raw.maxScopeWildcards
    }

    if (capability === null || sensitivity === null || approval === null || unboundedScope === null || wildcards === null) continue

    const pair = `${capability} ${sensitivity}`
    if (byPair.has(pair)) {
      /**
       * Two requirements for the same pair, and the tool does not pick one.
       *
       * Choosing the first is choosing silently, and a reader would have no way
       * to tell that the other one existed. The pair is poisoned instead: every
       * tool it governs becomes undecided, the run is incomplete, and somebody
       * has to say which requirement is the policy.
       */
      ambiguous.add(pair)
      sink.add({
        file,
        pointer,
        ruleId: 'requirement-duplicate',
        message: `A second requirement governs ${capability} on ${sensitivity} data, at ${byPair.get(pair)} and here. Neither is authoritative, so no tool with that capability and sensitivity was decided.`,
        suggestion: 'Declare exactly one requirement per capability and sensitivity pair.',
      })
      continue
    }
    byPair.set(pair, pointer)
    entries.push({ pointer, capability, sensitivity, approval, unboundedScope, maxScopeWildcards: wildcards })
  }

  entries.sort((left, right) => {
    const leftKey = `${left.capability} ${left.sensitivity}`
    const rightKey = `${right.capability} ${right.sensitivity}`
    return leftKey === rightKey ? 0 : leftKey < rightKey ? -1 : 1
  })
  return { declared: list.length, entries, ambiguous }
}

/**
 * Compile `policy.json`: the version stamped on the matrix, the data classes
 * and the approval requirements.
 *
 * @returns {{version: string|null, classes: object, requirements: object}|null}
 */
export function compilePolicy(sink, file, value, limits) {
  const document = openDocument(sink, file, value, POLICY_DOCUMENT_KEYS)
  if (document === null) return null

  let version = null
  if (!isIdentifier(document.version)) {
    /**
     * The matrix is a versioned artefact, so an unversioned one is not produced.
     *
     * A map of who may do what, with nothing saying which revision of the policy
     * it came from, is a map nobody can compare against the next one. The run
     * continues -- the findings about the tools are still worth having -- but
     * the matrix carries a null version, the run is incomplete, and no consumer
     * is handed a matrix that looks authoritative and is not.
     */
    sink.add({
      file,
      pointer: '/version',
      ruleId: 'policy-version-invalid',
      message: `"version" must be a policy version id; it is ${describeValue(document.version)}. The matrix is stamped with it, so without one the matrix is unversioned and this run cannot be compared against another.`,
      suggestion: 'Stamp the policy export with the revision it came from, for example "2026-09-1".',
    })
  } else {
    version = document.version
  }

  const classes = compileDataClasses(sink, file, document, limits)
  const requirements = compileRequirements(sink, file, document, limits)
  if (classes === null || requirements === null) return null
  return { version, classes, requirements }
}

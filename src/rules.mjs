/**
 * The one frozen `ruleId -> severity` table.
 *
 * Severity decides whether a run passes or fails, so it is written here once
 * and read from here everywhere: every finding takes its severity from this
 * table, an unknown rule id throws rather than defaulting, and a row's verdict
 * asks this table whether the rules that fired were errors.
 *
 * `test/severity-table.test.mjs` asserts the table against the documented
 * catalog in `docs/permission-rules.md` in both directions. That is worth
 * having and it is *not* the guarantee: a table, a catalog and a test's
 * expected map are three declarations, and one edit that changes all three
 * leaves every assertion comparing them satisfied. `test/severity-exit.test.mjs`
 * drives a real input through the real binary for every error rule here and
 * pins the process exit code. An exit code cannot be edited.
 *
 * Only four rules sit below `error`, and each is a legitimate state rather than
 * a defect: a repeated reference in a list changes nothing and is dropped
 * (`scope-duplicate`, `class-reference-duplicate`, `role-reference-duplicate`),
 * and a declaration nobody can use (`tool-grants-no-role`,
 * `role-grants-nothing`) is dead rather than dangerous.
 */
export const RULE_SEVERITY = Object.freeze({
  'approval-below-requirement': 'error',
  'approval-unsupported': 'error',
  'capability-unsupported': 'error',
  'class-reference-duplicate': 'warning',
  'class-reference-invalid': 'error',
  'data-class-duplicate': 'error',
  'data-class-invalid': 'error',
  'data-class-unknown': 'error',
  'document-invalid': 'error',
  'identifier-invalid': 'error',
  'input-not-json': 'error',
  'input-not-utf8': 'error',
  'input-too-large': 'error',
  'input-unreadable': 'error',
  'no-tools-evaluated': 'error',
  'path-escapes-root': 'error',
  'policy-version-invalid': 'error',
  'requirement-duplicate': 'error',
  'requirement-invalid': 'error',
  'requirement-missing': 'error',
  'role-capability-exceeded': 'error',
  'role-duplicate': 'error',
  'role-grants-nothing': 'warning',
  'role-invalid': 'error',
  'role-reference-duplicate': 'warning',
  'role-reference-invalid': 'error',
  'role-sensitivity-exceeded': 'error',
  'role-unknown': 'error',
  'schema-version-unsupported': 'error',
  'scope-duplicate': 'warning',
  'scope-invalid': 'error',
  'scope-too-broad': 'error',
  'scope-unbounded': 'error',
  'sensitivity-unsupported': 'error',
  'time-budget-exceeded': 'error',
  'too-many-class-references': 'error',
  'too-many-data-classes': 'error',
  'too-many-findings': 'error',
  'too-many-requirements': 'error',
  'too-many-role-references': 'error',
  'too-many-roles': 'error',
  'too-many-scopes': 'error',
  'too-many-tools': 'error',
  'tool-declares-no-data-class': 'error',
  'tool-declares-no-scope': 'error',
  'tool-duplicate': 'error',
  'tool-grants-no-role': 'warning',
  'tool-invalid': 'error',
})

/** The severity of one rule. An id that is not in the table throws rather than defaulting. */
export function severityOf(ruleId) {
  const severity = RULE_SEVERITY[ruleId]
  if (severity === undefined) {
    throw new Error(`Rule "${ruleId}" is not in RULE_SEVERITY; add it to the table and to docs/permission-rules.md.`)
  }
  return severity
}
